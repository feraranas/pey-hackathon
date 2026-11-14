import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, {
  LogController,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { Webhook } from "standardwebhooks";
import {
  endpointById,
  endpoints,
  webhookEvents,
  type Endpoint,
  type SandboxAction,
} from "./catalog.js";
import { createRedactor, type Redactor } from "./redact.js";

export const PEY_BASE_URL = "https://api.pey.mx";
export type Mode = "sandbox" | "production";

export type ExplorerOptions = {
  /** Shared access token; the page asks for it as the Basic-auth password. */
  token: string;
  production?: {
    apiKey: string;
    apiKeyId?: string;
    webhookSecret?: string;
    /** Production POSTs stay locked unless this is true. */
    postsEnabled: boolean;
    /** Largest amount (MXN) a production POST may carry. */
    maxAmount: number;
  };
  sandbox?: {
    baseUrl: string;
    apiKey: string;
    apiKeyId: string;
    webhookSecret: string;
    seed: Record<string, string>;
  };
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

type FeedEntry = {
  seq: number;
  receivedAt: string;
  webhookId: string | null;
  type: string | null;
  source: "producción" | "sandbox" | null;
  outcome:
    | "aceptado"
    | "duplicado"
    | "firma inválida"
    | "cabeceras incompletas"
    | "evento desconocido";
  httpStatus: number;
  payload?: unknown;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_\-+/=.]{1,2000}$/;
const SANDBOX_PATHS: Record<SandboxAction, (id: string) => string> = {
  "activate-account": (id) => `/__sandbox/accounts/${id}/activate`,
  "pay-qr": (id) => `/__sandbox/qr/${id}/pay`,
  "pay-push": (id) => `/__sandbox/pn/${id}/pay`,
  "pay-link": (id) => `/__sandbox/payment-links/${id}/pay`,
};
const SAMPLE_PHONE = "5512345678";
const digest = (value: string) => createHash("sha256").update(value).digest();

const ui = (name: string) =>
  readFileSync(new URL(`./ui/${name}`, import.meta.url));
const assets: Record<string, { type: string; body: Buffer }> = {
  "/": { type: "text/html; charset=utf-8", body: ui("index.html") },
  "/app.css": { type: "text/css; charset=utf-8", body: ui("app.css") },
  "/app.js": { type: "text/javascript; charset=utf-8", body: ui("app.js") },
};

export function createExplorer(options: ExplorerOptions) {
  const doFetch = options.fetch ?? fetch;
  const prod = options.production;
  const sbx = options.sandbox;
  const redactor: Redactor = createRedactor([
    options.token,
    prod?.apiKey,
    prod?.webhookSecret,
    sbx?.apiKey,
    sbx?.webhookSecret,
  ]);
  const secrets: Array<{ source: "producción" | "sandbox"; secret: string }> =
    [];
  if (prod?.webhookSecret)
    secrets.push({ source: "producción", secret: prod.webhookSecret });
  if (sbx) secrets.push({ source: "sandbox", secret: sbx.webhookSecret });

  const app = Fastify({
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_r, body, done) => done(null, body),
  );

  // ---- access control -------------------------------------------------
  const tokenDigest = digest(options.token);
  const failures = new Map<string, { count: number; since: number }>();
  const publicRoute = (request: FastifyRequest) =>
    request.url === "/health" ||
    (request.method === "POST" && request.url === "/webhooks/pey");
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (publicRoute(request)) return;
    const who = String(request.headers["cf-connecting-ip"] ?? request.ip);
    const now = Date.now();
    const seen = failures.get(who);
    if (seen && now - seen.since < 60_000 && seen.count >= 10)
      return reply
        .code(429)
        .send({ error: "Demasiados intentos; espera un minuto" });
    const header = request.headers.authorization ?? "";
    const given = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64")
          .toString()
          .split(":")
          .slice(1)
          .join(":")
      : "";
    if (!given || !timingSafeEqual(digest(given), tokenDigest)) {
      const fresh =
        seen && now - seen.since < 60_000 ? seen : { count: 0, since: now };
      fresh.count += 1;
      failures.set(who, fresh);
      return reply
        .code(401)
        .header(
          "www-authenticate",
          'Basic realm="pey explorer", charset="UTF-8"',
        )
        .send({ error: "Se requiere el token de acceso" });
    }
    failures.delete(who);
    if (request.method === "POST" && request.url.startsWith("/api/")) {
      // Basic credentials ride along on cross-site requests: demand a header a
      // foreign page cannot set without a CORS preflight, and refuse cross-site.
      const site = request.headers["sec-fetch-site"];
      if (
        request.headers["x-explorer-request"] !== "1" ||
        (site !== undefined && site !== "same-origin" && site !== "none")
      )
        return reply.code(403).send({ error: "Solicitud no permitida" });
    }
  });

  for (const [path, asset] of Object.entries(assets))
    app.get(path, async (_request, reply) =>
      reply.type(asset.type).send(asset.body),
    );
  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());
  app.get("/health", async () => ({ status: "ok" }));

  // ---- bootstrap ------------------------------------------------------
  app.get("/api/bootstrap", async () => ({
    baseUrl: PEY_BASE_URL,
    modes: {
      sandbox: sbx
        ? { available: true, seed: sbx.seed }
        : { available: false, seed: {} },
      production: prod
        ? {
            available: true,
            postsEnabled: prod.postsEnabled,
            maxAmount: prod.maxAmount,
          }
        : { available: false, postsEnabled: false, maxAmount: 0 },
    },
    defaultMode: prod ? "production" : "sandbox",
    endpoints,
    webhooks: webhookEvents,
    feed: feed.slice(-50),
  }));

  // ---- proxy ----------------------------------------------------------
  const asBody = (value: unknown): Record<string, unknown> | undefined => {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        return undefined;
      }
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  };
  const input = (request: FastifyRequest) => asBody(request.body) ?? {};
  const fail = (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => reply.code(status).send({ ok: false, code, message });

  app.post("/api/call", async (request, reply) => {
    const req = input(request);
    const mode = req.mode;
    if (mode !== "sandbox" && mode !== "production")
      return fail(reply, 400, "BAD_MODE", "Modo inválido");
    const target =
      mode === "production"
        ? prod && { baseUrl: PEY_BASE_URL, apiKey: prod.apiKey }
        : sbx && { baseUrl: sbx.baseUrl, apiKey: sbx.apiKey };
    if (!target)
      return fail(
        reply,
        409,
        "MODE_UNAVAILABLE",
        mode === "production"
          ? "Producción no está configurada (falta PEY_API_KEY en el servidor)"
          : "El sandbox no está disponible",
      );
    const endpoint: Endpoint | undefined = endpointById.get(
      String(req.endpointId),
    );
    if (!endpoint)
      return fail(reply, 404, "UNKNOWN_ENDPOINT", "Endpoint desconocido");

    // path + query, validated against the catalogue
    const params = (
      req.params && typeof req.params === "object" ? req.params : {}
    ) as Record<string, unknown>;
    let path = endpoint.path;
    const query = new URLSearchParams();
    for (const p of endpoint.params) {
      const raw = params[p.name];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        if (p.required)
          return fail(reply, 422, "MISSING_PARAM", `Falta ${p.label}`);
        continue;
      }
      if (!(p.in === "path" ? ID : TOKEN).test(value))
        return fail(
          reply,
          422,
          "BAD_PARAM",
          `${p.label} tiene caracteres no permitidos`,
        );
      if (p.in === "path")
        path = path.replace(`{${p.name}}`, encodeURIComponent(value));
      else query.set(p.name, value);
    }
    const url = `${target.baseUrl}${path}${query.size ? `?${query}` : ""}`;

    // body + guards
    let body: Record<string, unknown> | undefined;
    if (endpoint.method === "POST") {
      body = asBody(req.body);
      if (!body)
        return fail(
          reply,
          422,
          "BAD_BODY",
          "El cuerpo debe ser un objeto JSON válido",
        );
      if (JSON.stringify(body).length > 16_000)
        return fail(reply, 422, "BAD_BODY", "Cuerpo demasiado grande");
    }
    if (mode === "production" && endpoint.risk !== "lectura") {
      if (!prod?.postsEnabled)
        return fail(
          reply,
          403,
          "PROD_POSTS_LOCKED",
          "Las escrituras en producción están bloqueadas en este servidor (EXPLORER_PROD_POSTS=1 para habilitarlas)",
        );
      if (req.confirm !== "REAL")
        return fail(
          reply,
          428,
          "CONFIRM_REQUIRED",
          "Confirma explícitamente: esta llamada usa dinero o cuentas reales",
        );
      const amount = body?.amount;
      if (typeof amount === "number" && amount > prod.maxAmount)
        return fail(
          reply,
          422,
          "AMOUNT_TOO_HIGH",
          `En producción el monto máximo del explorador es ${prod.maxAmount} MXN`,
        );
      if (endpoint.id === "push-create" && body?.phoneNumber === SAMPLE_PHONE)
        return fail(
          reply,
          422,
          "SAMPLE_PHONE",
          "Ese teléfono es el de ejemplo de la documentación; escribe uno tuyo",
        );
    }

    const started = performance.now();
    const startedAt = new Date().toISOString();
    const requestEcho = {
      method: endpoint.method,
      url: redactor.text(url),
      headers: {
        authorization: "Bearer [secreto]",
        "content-type": "application/json",
      },
      ...(body ? { body: redactor.value(body) } : {}),
    };
    try {
      const upstream = await doFetch(url, {
        method: endpoint.method,
        headers: {
          authorization: `Bearer ${target.apiKey}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const text = (await upstream.text()).slice(0, 400_000);
      const latencyMs = Math.round(performance.now() - started);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const image =
        json &&
        typeof json === "object" &&
        typeof (json as { qrImage?: unknown }).qrImage === "string"
          ? (json as { qrImage: string }).qrImage
          : undefined;
      return {
        ok: upstream.ok,
        mode,
        endpointId: endpoint.id,
        startedAt,
        request: requestEcho,
        response: {
          status: upstream.status,
          statusText: upstream.statusText,
          latencyMs,
          contentType: upstream.headers.get("content-type") ?? "",
          body: json === undefined ? redactor.text(text) : redactor.value(json),
          ...(image && /^[A-Za-z0-9+/=]{1,300000}$/.test(image)
            ? { qrImagePng: image }
            : {}),
        },
      };
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        code: "UPSTREAM_UNREACHABLE",
        message:
          error instanceof Error && error.name === "TimeoutError"
            ? "pey no respondió en 15 s"
            : "No se pudo contactar a pey",
        request: requestEcho,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  });

  // ---- sandbox "the bank acts" buttons ------------------------------------
  app.post("/api/sandbox/action", async (request, reply) => {
    const req = input(request);
    const action = req.action as SandboxAction;
    const id = typeof req.id === "string" ? req.id : "";
    if (!sbx)
      return fail(
        reply,
        409,
        "MODE_UNAVAILABLE",
        "El sandbox no está disponible",
      );
    if (!(action in SANDBOX_PATHS) || !ID.test(id))
      return fail(reply, 422, "BAD_ACTION", "Acción o id inválidos");
    const started = performance.now();
    const response = await doFetch(
      `${sbx.baseUrl}${SANDBOX_PATHS[action](id)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      body: redactor.value(json),
    };
  });

  // ---- webhook sink ---------------------------------------------------------
  const feed: FeedEntry[] = [];
  const seenIds = new Set<string>();
  const listeners = new Set<(entry: FeedEntry) => void>();
  const streams = new Set<{ end(): void }>();
  let seq = 0;
  const record = (entry: Omit<FeedEntry, "seq" | "receivedAt">) => {
    const full: FeedEntry = {
      seq: ++seq,
      receivedAt: new Date().toISOString(),
      ...entry,
    };
    feed.push(full);
    if (feed.length > 200) feed.shift();
    for (const listener of listeners) listener(full);
    return full;
  };
  const knownTypes = new Set(webhookEvents.map((e) => e.type as string));

  app.post("/webhooks/pey", async (request, reply) => {
    const headers: Record<string, string> = {};
    for (const name of [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (Object.keys(headers).length !== 3) {
      record({
        webhookId: headers["webhook-id"] ?? null,
        type: null,
        source: null,
        outcome: "cabeceras incompletas",
        httpStatus: 401,
      });
      return reply
        .code(401)
        .send({ accepted: false, outcome: "cabeceras incompletas" });
    }
    const raw = typeof request.body === "string" ? request.body : "";
    let verified:
      { source: "producción" | "sandbox"; payload: unknown } | undefined;
    for (const candidate of secrets) {
      try {
        verified = {
          source: candidate.source,
          payload: new Webhook(candidate.secret).verify(raw, headers),
        };
        break;
      } catch {
        /* try the next secret */
      }
    }
    const webhookId = headers["webhook-id"]!;
    if (!verified) {
      record({
        webhookId: redactor.text(webhookId).slice(0, 80),
        type: null,
        source: null,
        outcome: "firma inválida",
        httpStatus: 401,
      });
      return reply
        .code(401)
        .send({ accepted: false, outcome: "firma inválida" });
    }
    const payload = verified.payload as { type?: unknown };
    const type = typeof payload?.type === "string" ? payload.type : null;
    if (!type || !knownTypes.has(type)) {
      record({
        webhookId,
        type,
        source: verified.source,
        outcome: "evento desconocido",
        httpStatus: 202,
        payload: redactor.value(payload),
      });
      return reply
        .code(202)
        .send({ accepted: true, outcome: "evento desconocido" });
    }
    const duplicate = seenIds.has(webhookId);
    seenIds.add(webhookId);
    record({
      webhookId,
      type,
      source: verified.source,
      outcome: duplicate ? "duplicado" : "aceptado",
      httpStatus: duplicate ? 200 : 202,
      payload: redactor.value(payload),
    });
    return reply
      .code(duplicate ? 200 : 202)
      .send({ accepted: true, outcome: duplicate ? "duplicado" : "aceptado" });
  });

  app.get("/api/webhooks/recent", async () => ({ feed: feed.slice(-100) }));
  app.get("/api/webhooks/stream", (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const send = (entry: FeedEntry) =>
      res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
    listeners.add(send);
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    const done = () => {
      clearInterval(beat);
      listeners.delete(send);
    };
    streams.add(res);
    request.raw.on("close", () => {
      done();
      streams.delete(res);
    });
  });
  app.addHook("onClose", async () => {
    for (const res of streams) res.end();
    streams.clear();
  });

  // ---- local signer ----------------------------------------------------------
  app.post("/api/webhooks/simulate", async (request, reply) => {
    const req = input(request);
    const event = webhookEvents.find((e) => e.type === req.type);
    if (!event) return fail(reply, 422, "UNKNOWN_EVENT", "Evento desconocido");
    const mode = req.mode;
    const secret =
      mode === "production"
        ? prod?.webhookSecret
        : mode === "sandbox"
          ? sbx?.webhookSecret
          : undefined;
    if (!secret)
      return fail(
        reply,
        409,
        "NO_SECRET",
        mode === "production"
          ? "Falta PEY_WEBHOOK_SECRET en el servidor para firmar en modo producción"
          : "Modo inválido o sin secreto",
      );
    const variant = ["valid", "tampered", "stale"].includes(String(req.variant))
      ? String(req.variant)
      : "valid";
    const apiKeyId = mode === "production" ? prod?.apiKeyId : sbx?.apiKeyId;
    const payload = asBody(req.payload) ?? {
      ...event.payload,
      ...(apiKeyId && "apiKeyId" in event.payload ? { apiKeyId } : {}),
    };
    const raw = JSON.stringify(payload);
    const webhookId =
      typeof req.webhookId === "string" && ID.test(req.webhookId)
        ? req.webhookId
        : `msg_sim_${randomUUID()}`;
    const signedAt = new Date(
      Date.now() - (variant === "stale" ? 10 * 60_000 : 0),
    );
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign(webhookId, signedAt, raw),
    };
    const sentBody = variant === "tampered" ? `${raw} ` : raw;
    const before = seq;
    const delivered = await app.inject({
      method: "POST",
      url: "/webhooks/pey",
      payload: sentBody,
      headers,
    });
    const outcome = (delivered.json() as { outcome?: string }).outcome ?? "";
    const verification = [
      {
        step: "Firma",
        ok: true,
        detail:
          "HMAC-SHA256 con tu PEY_WEBHOOK_SECRET sobre «id.timestamp.cuerpo». El secreto no sale del servidor.",
      },
      {
        step: "Verificación",
        ok: outcome === "aceptado" || outcome === "duplicado",
        detail:
          outcome === "firma inválida"
            ? variant === "stale"
              ? "Rechazada: el timestamp tiene 10 min; Standard Webhooks tolera 5 min (evita repeticiones)."
              : "Rechazada: el cuerpo cambió después de firmar, la firma ya no coincide."
            : "La firma coincide y el timestamp es reciente.",
      },
      {
        step: "Idempotencia",
        ok: outcome !== "duplicado",
        detail:
          outcome === "duplicado"
            ? "Ese webhook-id ya se procesó: se responde 200 sin repetir el efecto."
            : outcome === "aceptado"
              ? "Primera vez que se ve este webhook-id: se procesa una sola vez."
              : "No se llegó a esta etapa.",
      },
    ];
    return {
      ok: delivered.statusCode < 300,
      request: {
        method: "POST",
        url: "/webhooks/pey",
        headers: {
          ...headers,
          "webhook-signature": `${headers["webhook-signature"].slice(0, 16)}…`,
        },
        body: redactor.value(payload),
      },
      response: { status: delivered.statusCode, body: delivered.json() },
      webhookId,
      verification,
      feedSeq: seq > before ? seq : null,
    };
  });

  return Object.assign(app, { redactor });
}
