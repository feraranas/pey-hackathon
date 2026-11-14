import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { endpoints, webhookEvents } from "../src/explorer/catalog.js";
import { createRedactor } from "../src/explorer/redact.js";
import { createExplorer } from "../src/explorer/server.js";
import { startExplorerSandbox } from "../src/explorer/sandbox.js";

const TOKEN = "explorer-token-for-tests-0123456789";
const KEY = "pey_live_SuperSecretApiKey123";
const SECRET = `whsec_${Buffer.from("explorer-test-webhook-secret-32b").toString("base64")}`;
const auth = {
  authorization: `Basic ${Buffer.from(`pey:${TOKEN}`).toString("base64")}`,
};
const headers = {
  ...auth,
  "content-type": "application/json",
  "x-explorer-request": "1",
};

type Seen = { url: string; init: RequestInit };
function setup(overrides: { postsEnabled?: boolean; upstream?: unknown } = {}) {
  const seen: Seen[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(overrides.upstream ?? { id: "x" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const app = createExplorer({
    token: TOKEN,
    production: {
      apiKey: KEY,
      apiKeyId: "key-id-1",
      webhookSecret: SECRET,
      postsEnabled: overrides.postsEnabled ?? true,
      maxAmount: 5,
    },
    sandbox: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "sbx_key_not_production",
      apiKeyId: "sbx-id",
      webhookSecret: `whsec_${Buffer.from("sandbox-webhook-secret-32-bytes!").toString("base64")}`,
      seed: {},
    },
    fetch: fakeFetch,
  });
  return { app, seen };
}
const call = (
  app: ReturnType<typeof createExplorer>,
  payload: unknown,
  extra = {},
) =>
  app.inject({
    method: "POST",
    url: "/api/call",
    headers: { ...headers, ...extra },
    payload: payload as object,
  });

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const make = (o = {}) => {
  const s = setup(o);
  apps.push(s.app);
  return s;
};

describe("explorer access control", () => {
  it("requires the token everywhere except health and the signed webhook route", async () => {
    const { app } = make();
    for (const url of [
      "/",
      "/app.js",
      "/api/bootstrap",
      "/api/webhooks/recent",
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/bootstrap",
          headers: {
            authorization: `Basic ${Buffer.from("pey:wrong").toString("base64")}`,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: "{}",
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/", headers: auth })).statusCode).toBe(
      200,
    );
  });

  it("throttles repeated bad passwords", async () => {
    const { app } = make();
    const bad = {
      authorization: `Basic ${Buffer.from("pey:nope").toString("base64")}`,
    };
    for (let i = 0; i < 10; i++) await app.inject({ url: "/", headers: bad });
    expect((await app.inject({ url: "/", headers: bad })).statusCode).toBe(429);
    expect((await app.inject({ url: "/", headers: auth })).statusCode).toBe(
      429,
    );
  });

  it("rejects POSTs without the explorer header or from another site", async () => {
    const { app, seen } = make();
    const payload = { mode: "production", endpointId: "transactions-api-key" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/call",
          headers: { ...auth, "content-type": "application/json" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(app, payload, { "sec-fetch-site": "cross-site" })).statusCode,
    ).toBe(403);
    expect(seen).toHaveLength(0);
    expect(
      (await call(app, payload, { "sec-fetch-site": "same-origin" }))
        .statusCode,
    ).toBe(200);
  });
});

describe("explorer proxy", () => {
  it("injects the bearer key server-side and never returns it to the browser", async () => {
    const { app, seen } = make({
      upstream: {
        echoedAuthorization: `Bearer ${KEY}`,
        note: `key ${KEY} and secret ${SECRET}`,
        clabe: "012180001234567899",
        metadata: { clabe: "000000000000000000" },
        taxId: "XAXX010101000",
        items: [],
      },
    });
    const res = await call(app, {
      mode: "production",
      endpointId: "transactions-api-key",
      params: { nextToken: "abc_DEF-12=" },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://api.pey.mx/transaction/api-key?nextToken=abc_DEF-12%3D",
    );
    expect(
      (seen[0]!.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${KEY}`);
    const text = res.body;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("012180001234567899");
    expect(text).not.toContain("000000000000000000");
    expect(text).toContain("•••••••••••••• 7899".replace(" ", ""));
    expect(text).not.toContain("XAXX010101000");
    expect(res.json().request.headers.authorization).toBe("Bearer [secreto]");
    // the page itself ships without any secret
    const boot = (await app.inject({ url: "/api/bootstrap", headers: auth }))
      .body;
    for (const asset of ["/", "/app.js", "/app.css"]) {
      const body = (await app.inject({ url: asset, headers: auth })).body;
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(SECRET);
    }
    expect(boot).not.toContain(KEY);
    expect(boot).not.toContain(SECRET);
    expect(boot).not.toContain(TOKEN);
  });

  it("only reaches catalogued paths with validated parameters", async () => {
    const { app, seen } = make();
    expect(
      (await call(app, { mode: "production", endpointId: "nope" })).statusCode,
    ).toBe(404);
    for (const id of ["../admin", "a/b", "a?x=1", "a b", "", "x".repeat(200)])
      expect(
        (
          await call(app, {
            mode: "production",
            endpointId: "transaction-get",
            params: { id },
          })
        ).statusCode,
      ).toBe(422);
    expect(
      (
        await call(app, {
          mode: "production",
          endpointId: "transactions-api-key",
          params: { nextToken: "a&b=1" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call(app, { mode: "moon", endpointId: "transaction-get" }))
        .statusCode,
    ).toBe(400);
    expect(seen).toHaveLength(0);
    const ok = await call(app, {
      mode: "production",
      endpointId: "transaction-get",
      params: { id: "01HXYZ-abc_1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(seen[0]!.url).toBe("https://api.pey.mx/transaction/01HXYZ-abc_1");
  });

  it("guards production POSTs: lock, explicit confirm, amount cap, sample phone", async () => {
    const body = { amount: 1, concept: "t", expiration: 600, numRef: "1" };
    const locked = make({ postsEnabled: false });
    const r1 = await call(locked.app, {
      mode: "production",
      endpointId: "qr-create",
      body,
      confirm: "REAL",
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().code).toBe("PROD_POSTS_LOCKED");
    expect(locked.seen).toHaveLength(0);

    const { app, seen } = make();
    const r2 = await call(app, {
      mode: "production",
      endpointId: "qr-create",
      body,
    });
    expect(r2.statusCode).toBe(428);
    expect(
      (
        await call(app, {
          mode: "production",
          endpointId: "qr-create",
          body,
          confirm: "yes",
        })
      ).statusCode,
    ).toBe(428);
    expect(
      (
        await call(app, {
          mode: "production",
          endpointId: "qr-create",
          body: { ...body, amount: 6 },
          confirm: "REAL",
        })
      ).json().code,
    ).toBe("AMOUNT_TOO_HIGH");
    expect(
      (
        await call(app, {
          mode: "production",
          endpointId: "push-create",
          body: { amount: 1, phoneNumber: "5512345678" },
          confirm: "REAL",
        })
      ).json().code,
    ).toBe("SAMPLE_PHONE");
    expect(
      (
        await call(app, {
          mode: "production",
          endpointId: "qr-create",
          body: "not json",
          confirm: "REAL",
        })
      ).statusCode,
    ).toBe(422);
    expect(seen).toHaveLength(0);

    const ok = await call(app, {
      mode: "production",
      endpointId: "qr-create",
      body,
      confirm: "REAL",
    });
    expect(ok.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual(body);
  });

  it("sandbox calls use the sandbox key and host, never the production key", async () => {
    const { app, seen } = make();
    const res = await call(app, {
      mode: "sandbox",
      endpointId: "qr-create",
      body: { amount: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.url).toBe("http://127.0.0.1:9/codi/qr");
    expect(
      (seen[0]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer sbx_key_not_production");
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });

  it("reports production as unavailable without a key", async () => {
    const app = createExplorer({
      token: TOKEN,
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    apps.push(app);
    const res = await call(app, {
      mode: "production",
      endpointId: "transactions-api-key",
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("explorer webhook sink", () => {
  const simulate = (app: ReturnType<typeof createExplorer>, extra: object) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/simulate",
      headers,
      payload: {
        type: "codi.qr.payment_received",
        mode: "production",
        ...extra,
      },
    });

  it("verifies, dedupes by webhook-id and rejects tampered or stale signatures", async () => {
    const { app } = make();
    const first = (await simulate(app, { webhookId: "msg_test_1" })).json();
    expect(first.response.status).toBe(202);
    expect(first.verification.map((v: { ok: boolean }) => v.ok)).toEqual([
      true,
      true,
      true,
    ]);
    const replay = (await simulate(app, { webhookId: "msg_test_1" })).json();
    expect(replay.response.status).toBe(200);
    expect(replay.response.body.outcome).toBe("duplicado");
    const tampered = (await simulate(app, { variant: "tampered" })).json();
    expect(tampered.response.status).toBe(401);
    const stale = (await simulate(app, { variant: "stale" })).json();
    expect(stale.response.status).toBe(401);
    expect(stale.verification[1].detail).toContain("5 min");
    const feed = (
      await app.inject({ url: "/api/webhooks/recent", headers: auth })
    ).json().feed;
    expect(feed.map((e: { outcome: string }) => e.outcome)).toEqual([
      "aceptado",
      "duplicado",
      "firma inválida",
      "firma inválida",
    ]);
    expect(JSON.stringify(feed)).not.toContain(SECRET);
    // the signature itself is never echoed in full
    expect(first.request.headers["webhook-signature"]).toMatch(/…$/);
  });

  it("accepts every documented event type and refuses an unknown secret", async () => {
    const { app } = make();
    for (const event of webhookEvents) {
      const res = (await simulate(app, { type: event.type })).json();
      expect(res.response.status).toBe(202);
    }
    const unsigned = await app.inject({
      method: "POST",
      url: "/webhooks/pey",
      payload: "{}",
      headers: {
        "content-type": "application/json",
        "webhook-id": "a",
        "webhook-timestamp": "1",
        "webhook-signature": "v1,AAAA",
      },
    });
    expect(unsigned.statusCode).toBe(401);
  });
});

describe("explorer end to end against the local sandbox", () => {
  it("creates a QR, lets the sandbox bank pay it and receives the signed webhook", async () => {
    const sb = await startExplorerSandbox();
    const app = createExplorer({
      token: TOKEN,
      sandbox: {
        baseUrl: sb.baseUrl,
        apiKey: sb.apiKey,
        apiKeyId: sb.apiKeyId,
        webhookSecret: sb.webhookSecret,
        seed: sb.seed,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    sb.sandbox.setWebhookUrl(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/webhooks/pey`,
    );
    try {
      const created = (
        await call(app, {
          mode: "sandbox",
          endpointId: "qr-create",
          body: {
            amount: 1,
            concept: "e2e",
            expiration: 600,
            numRef: "1",
            generateImage: true,
          },
        })
      ).json();
      expect(created.response.status).toBe(201);
      expect(created.response.qrImagePng).toMatch(/^[A-Za-z0-9+/=]+$/);
      const qrId = created.response.body.id as string;
      const paid = (
        await app.inject({
          method: "POST",
          url: "/api/sandbox/action",
          headers,
          payload: { action: "pay-qr", id: qrId },
        })
      ).json();
      expect(paid.ok).toBe(true);
      const feed = (
        await app.inject({ url: "/api/webhooks/recent", headers: auth })
      ).json().feed;
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        type: "codi.qr.payment_received",
        outcome: "aceptado",
        source: "sandbox",
      });
      const txs = (
        await call(app, {
          mode: "sandbox",
          endpointId: "transactions-qr",
          params: { id: qrId },
        })
      ).json();
      expect(txs.response.body.items).toHaveLength(1);
      const act = async (action: string, id: string) =>
        (
          await app.inject({
            method: "POST",
            url: "/api/sandbox/action",
            headers,
            payload: { action, id },
          })
        ).json();
      const link = (
        await call(app, {
          mode: "sandbox",
          endpointId: "link-create",
          body: {
            amount: 1,
            successUrl: "https://example.com/ok",
            backUrl: "https://example.com/no",
          },
        })
      ).json().response.body.id as string;
      const updated = (
        await call(app, {
          mode: "sandbox",
          endpointId: "link-update",
          body: { paymentLinkId: link, amount: 2 },
        })
      ).json();
      expect(updated.response.body.amount).toBe(2);
      expect((await act("pay-link", link)).ok).toBe(true);
      const after = (
        await call(app, {
          mode: "sandbox",
          endpointId: "link-update",
          body: { paymentLinkId: link, amount: 3 },
        })
      ).json();
      expect(after.response.status).toBe(409);
      const push = (
        await call(app, {
          mode: "sandbox",
          endpointId: "push-create",
          body: { amount: 1, phoneNumber: "5512345678" },
        })
      ).json().response.body.transactionId as string;
      expect((await act("pay-push", push)).ok).toBe(true);
      const types = (
        await app.inject({ url: "/api/webhooks/recent", headers: auth })
      )
        .json()
        .feed.map((e: { type: string }) => e.type);
      expect(types).toEqual([
        "codi.qr.payment_received",
        "payment_link.status_updated",
        "codi.pn.payment_received",
      ]);
      // every documented endpoint is callable in the sandbox with seeded ids
      for (const ep of endpoints.filter((e) => e.method === "GET")) {
        const params = Object.fromEntries(
          ep.params
            .filter((p) => p.ctx && p.ctx !== "nextToken")
            .map((p) => [p.name, sb.seed[p.ctx as keyof typeof sb.seed]]),
        );
        const res = await call(app, {
          mode: "sandbox",
          endpointId: ep.id,
          params,
        });
        expect(res.json().response.status, ep.id).toBe(200);
      }
    } finally {
      await app.close();
      await sb.sandbox.app.close();
    }
  });
});

describe("redaction and catalogue", () => {
  it("masks CLABEs, phones, tax ids and literal secrets, and summarises QR images", () => {
    const r = createRedactor([KEY]);
    expect(
      r.value({
        clabe: "012180001234567899",
        phoneNumber: "5512345678",
        taxId: "XAXX010101000",
        qrImage: "A".repeat(500),
        deep: [{ text: `x ${KEY} y 012180001234567899 z Bearer abc.def` }],
      }),
    ).toEqual({
      clabe: "••••••••••••••7899",
      phoneNumber: "••••••5678",
      taxId: "XAX••••••••••",
      qrImage: "[imagen PNG en base64, 500 caracteres]",
      deep: [{ text: "x [secreto] y ••••••••••••••7899 z Bearer [secreto]" }],
    });
  });

  it("documents the 11 endpoints and 4 webhooks", () => {
    expect(endpoints.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      "GET /bank-account/{id}",
      "GET /payment-link/{id}",
      "GET /transaction/api-key",
      "GET /transaction/bank-account/{id}",
      "GET /transaction/codi/qr/{id}",
      "GET /transaction/{id}",
      "POST /bank-account",
      "POST /codi/pn",
      "POST /codi/qr",
      "POST /payment-link/create",
      "POST /payment-link/update",
    ]);
    expect(webhookEvents.map((e) => e.type).sort()).toEqual([
      "bank.account.updated",
      "codi.pn.payment_received",
      "codi.qr.payment_received",
      "payment_link.status_updated",
    ]);
    for (const e of endpoints.filter((x) => x.method === "POST"))
      expect(e.risk).toBe("dinero");
  });
});
