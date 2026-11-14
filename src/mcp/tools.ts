import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { validClabe } from "../clabe.js";
import { formatPesos, RemoteFailure, type Transaction } from "../contracts.js";
import type { PeyClient } from "../pey.js";
import type { McpConfig } from "./config.js";

/** Lo que las herramientas necesitan para trabajar. */
export type McpContext = {
  config: McpConfig;
  pey: PeyClient;
  /** Solo en sandbox: base del pey de mentira, para `simular_pago`. */
  sandboxUrl?: string;
  /** Reloj inyectable para pruebas. */
  now?: () => Date;
};

type Result = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Errores esperados que se le explican al agente en español. */
class ToolError extends Error {}

/** `**************1234`: nunca se muestra una CLABE completa. */
export const maskClabe = (clabe: string) =>
  `${"*".repeat(Math.max(clabe.length - 4, 0))}${clabe.slice(-4)}`;

const ok = (
  resumen: string,
  datos: Record<string, unknown>,
  extra: Result["content"] = [],
): Result => ({
  content: [
    { type: "text", text: `${resumen}\n${JSON.stringify(datos, null, 2)}` },
    ...extra,
  ],
  structuredContent: datos,
});
const fail = (mensaje: string): Result => ({
  content: [{ type: "text", text: `Error: ${mensaje}` }],
  isError: true,
});

/** Convierte lo que lance una herramienta en un resultado entendible. */
async function guard(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolError) return fail(error.message);
    if (error instanceof RemoteFailure)
      return fail(
        `pey no respondió bien (${error.message}). ${
          error.uncertain
            ? "No se sabe si la operación se llegó a hacer: revisa antes de reintentar."
            : "Puedes reintentar."
        }`,
      );
    if (error instanceof z.ZodError)
      return fail(
        `Datos inválidos: ${error.issues.map((i) => i.message).join("; ")}`,
      );
    return fail("Falló la operación. Revisa los datos e inténtalo de nuevo.");
  }
}

/** 150 o 99.5 → centavos exactos; rechaza más de dos decimales. */
export function pesosToCents(monto: number): number {
  const cents = Math.round(monto * 100);
  if (!Number.isFinite(monto) || Math.abs(monto * 100 - cents) > 1e-6)
    throw new ToolError("El monto debe tener máximo dos decimales.");
  return cents;
}

/** Acepta 5512345678, +52 55 1234 5678, 52-55-1234-5678… y deja 10 dígitos. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const ten =
    digits.length === 12 && digits.startsWith("52") ? digits.slice(2) : digits;
  if (!/^\d{10}$/.test(ten))
    throw new ToolError("El teléfono debe tener 10 dígitos (México).");
  return ten;
}

/** Fecha local (AAAA-MM-DD) de un instante, en la zona configurada. */
export function localDate(seconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(seconds * 1000));
}
const localDateTime = (seconds: number, timezone: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(seconds * 1000));

const money = (cents: number) => `$${formatPesos(cents)} MXN`;

/** En producción, escribir exige permiso explícito en el entorno. */
function assertCanWrite(config: McpConfig) {
  if (!config.allowWrites)
    throw new ToolError(
      "Las escrituras están desactivadas en producción. El dueño del servidor debe iniciar con PEY_MCP_ALLOW_WRITES=true.",
    );
}

type Handle = { kind: "qr" | "link" | "tx"; id: string };
const KINDS = { qr: "qr", link: "link", tx: "tx" } as const;
function parseHandle(raw: string): { kind?: Handle["kind"]; id: string } {
  const match = /^(qr|link|tx):(.+)$/.exec(raw.trim());
  return match
    ? { kind: KINDS[match[1] as keyof typeof KINDS], id: match[2]! }
    : { id: raw.trim() };
}

const estadoTexto = {
  pagado: "pagado",
  parcial: "pago parcial",
  procesando: "procesando",
  pendiente: "pendiente",
} as const;

export function registerPeyTools(server: McpServer, ctx: McpContext) {
  const { config, pey } = ctx;
  const now = ctx.now ?? (() => new Date());
  const production = config.mode === "production";

  /* ---------------------------------------------------------------- */
  server.registerTool(
    "crear_cobro",
    {
      title: "Crear cobro",
      description:
        "Crea un cobro en pesos mexicanos (MXN) con pey. Con `telefono_pagador` manda una solicitud de pago CoDi directo al celular del cliente; si no, genera un QR CoDi (o un link de pago con metodo=link) para que el cliente pague. Devuelve un `cobro_id` que se usa en `revisar_cobro`. Crear un cobro NO es recibir el dinero: hay que revisar después si ya pagó." +
        (production
          ? " ESTÁ EN PRODUCCIÓN: es dinero real. Primero llámala sin `confirmar` para ver la vista previa, enséñasela al dueño y solo con su visto bueno repite con confirmar=true."
          : " Está en modo sandbox: no se mueve dinero."),
      inputSchema: z.object({
        monto: z
          .number()
          .positive()
          .describe(
            "Monto a cobrar en pesos MXN, máximo dos decimales. Ej. 150 o 99.50",
          ),
        concepto: z
          .string()
          .min(1)
          .max(80)
          .describe(
            "Para qué es el cobro; lo ve el cliente. Ej. «Corte de cabello»",
          ),
        telefono_pagador: z
          .string()
          .optional()
          .describe(
            "Celular del cliente (10 dígitos). Si se da, se le envía la solicitud CoDi a su banco.",
          ),
        alias_pagador: z
          .string()
          .max(60)
          .optional()
          .describe(
            "Nombre o apodo del cliente, solo para tus registros (pey no lo envía al cliente)",
          ),
        metodo: z
          .enum(["auto", "qr", "link", "push"])
          .default("auto")
          .describe(
            "auto: push si hay teléfono, si no QR. qr: QR CoDi. link: link de pago (acepta tarjeta). push: solicitud al celular",
          ),
        cuenta_id: z
          .string()
          .optional()
          .describe(
            "Cuenta (id de pey) que recibe el pago. Si se omite se usa la configurada o la ligada a la clave",
          ),
        confirmar: z
          .boolean()
          .optional()
          .describe(
            "Solo producción: true para crear de verdad el cobro tras enseñar la vista previa",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      guard(async () => {
        const cents = pesosToCents(args.monto);
        if (cents > config.maxAmountCents)
          throw new ToolError(
            `El monto ${money(cents)} supera el tope permitido de ${money(config.maxAmountCents)} (PEY_MCP_MAX_AMOUNT).`,
          );
        const phone = args.telefono_pagador
          ? normalizePhone(args.telefono_pagador)
          : undefined;
        const metodo =
          args.metodo === "auto" ? (phone ? "push" : "qr") : args.metodo;
        if (metodo === "push" && !phone)
          throw new ToolError("metodo=push requiere telefono_pagador.");
        const vista = {
          monto: money(cents),
          concepto: args.concepto,
          metodo,
          ...(phone ? { telefono_pagador: `******${phone.slice(-4)}` } : {}),
          ...(args.alias_pagador ? { alias_pagador: args.alias_pagador } : {}),
        };
        if (production) {
          assertCanWrite(config);
          if (args.confirmar !== true)
            return ok(
              "VISTA PREVIA: todavía no se creó nada. Muéstrasela al dueño y, si la aprueba, repite la llamada con confirmar=true.",
              { creado: false, vista_previa: vista },
            );
        }
        const cuenta = args.cuenta_id ?? config.bankAccountId;
        const numRef = String(randomInt(1, 10_000_000));
        const metadata = {
          origen: "pey-mcp",
          ...(args.alias_pagador ? { alias_pagador: args.alias_pagador } : {}),
        };
        const nota = production
          ? "Cobro real creado. El dinero llega hasta que el cliente paga: usa revisar_cobro."
          : "Cobro de sandbox: no es dinero real. Usa simular_pago para ver cómo se vería pagado.";

        if (metodo === "qr") {
          const qr = await pey.createCodiQr({
            amountCents: cents,
            concept: args.concepto,
            expiration: config.qrExpirationSeconds,
            numRef,
            ...(cuenta ? { bankAccountId: cuenta } : {}),
            metadata,
          });
          const png = (
            await QRCode.toBuffer(qr.qrString, { width: 360 })
          ).toString("base64");
          return ok(
            `Cobro QR creado por ${money(cents)}. Pásale el QR al cliente para que lo escanee con su app del banco.`,
            {
              creado: true,
              cobro_id: `qr:${qr.id}`,
              metodo,
              monto: money(cents),
              concepto: args.concepto,
              estado: estadoTexto.pendiente,
              qr_cadena: qr.qrString,
              vigencia_segundos: config.qrExpirationSeconds,
              ...(args.alias_pagador
                ? { alias_pagador: args.alias_pagador }
                : {}),
              nota,
            },
            [{ type: "image", data: png, mimeType: "image/png" }],
          );
        }
        if (metodo === "link") {
          const link = await pey.createPaymentLink({
            amountCents: cents,
            successUrl: config.successUrl,
            backUrl: config.backUrl,
            clientReferenceId: (args.alias_pagador ?? args.concepto).slice(
              0,
              255,
            ),
          });
          return ok(
            `Link de pago creado por ${money(cents)}. Compártelo con el cliente.`,
            {
              creado: true,
              cobro_id: `link:${link.id}`,
              metodo,
              monto: money(cents),
              concepto: args.concepto,
              estado: estadoTexto.pendiente,
              link: link.url,
              ...(args.alias_pagador
                ? { alias_pagador: args.alias_pagador }
                : {}),
              nota,
            },
          );
        }
        const push = await pey.createPush({
          amountCents: cents,
          phoneNumber: phone!,
          concept: args.concepto,
          expiration: 360,
          numRef,
          ...(cuenta ? { bankAccountId: cuenta } : {}),
        });
        return ok(
          `Solicitud de pago CoDi enviada por ${money(cents)} al celular terminado en ${phone!.slice(-4)}. El cliente debe aprobarla en su app del banco (vigencia 6 minutos).`,
          {
            creado: true,
            cobro_id: `tx:${push.transactionId}`,
            metodo,
            monto: money(cents),
            concepto: args.concepto,
            estado: estadoTexto.pendiente,
            telefono_pagador: `******${phone!.slice(-4)}`,
            vigencia_segundos: 360,
            ...(args.alias_pagador
              ? { alias_pagador: args.alias_pagador }
              : {}),
            nota,
          },
        );
      }),
  );

  /* ---------------------------------------------------------------- */
  async function lookup(raw: string) {
    const { kind, id } = parseHandle(raw);
    const attempts: Handle["kind"][] = kind ? [kind] : ["tx", "link", "qr"];
    let last: unknown;
    for (const attempt of attempts) {
      try {
        if (attempt === "qr") {
          const page = await pey.listQrTransactions(id);
          const paid = page.transactions.filter((t) => t.status === "PAID");
          return {
            tipo: "qr",
            estado: paid.length > 0 ? "pagado" : "pendiente",
            pagos: paid.map((t) => pago(t)),
          } as const;
        }
        if (attempt === "link") {
          const link = await pey.getPaymentLink(id);
          const estado =
            link.status === "paid"
              ? "pagado"
              : link.status === "partial"
                ? "parcial"
                : link.status === "processing"
                  ? "procesando"
                  : "pendiente";
          return {
            tipo: "link",
            estado,
            monto_del_link: money(link.amountCents),
            pagos: link.transactions.map((t) => ({
              transaccion_id: t.id,
              monto: money(t.amountCents),
              ...(t.datePaid
                ? { fecha: localDateTime(t.datePaid, config.timezone) }
                : {}),
            })),
          } as const;
        }
        const tx = await pey.getTransaction(id);
        return {
          tipo: "transaccion",
          estado: tx.status === "PAID" ? "pagado" : "pendiente",
          pagos: tx.status === "PAID" ? [pago(tx)] : [],
        } as const;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof RemoteFailure
      ? new ToolError(
          `No encontré ese cobro (${raw}). Usa el cobro_id que devolvió crear_cobro.`,
        )
      : last;
  }
  const pago = (t: Transaction) => ({
    transaccion_id: t.id,
    monto: money(t.amountCents),
    metodo: t.paymentMethod,
    ...(t.datePaid
      ? { fecha: localDateTime(t.datePaid, config.timezone) }
      : {}),
    ...(t.receiverClabe ? { cuenta_destino: maskClabe(t.receiverClabe) } : {}),
  });

  server.registerTool(
    "revisar_cobro",
    {
      title: "Revisar si pagaron un cobro",
      description:
        "Consulta en pey si un cobro ya fue pagado. Recibe el `cobro_id` que devolvió crear_cobro (por ejemplo `qr:ABC…`, `link:ABC…` o `tx:ABC…`). Responde pagado, pendiente, procesando o pago parcial. Solo lee: no cobra ni modifica nada.",
      inputSchema: z.object({
        cobro_id: z.string().min(1).describe("El cobro_id de crear_cobro"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ cobro_id }) =>
      guard(async () => {
        const r = await lookup(cobro_id);
        const resumen =
          r.estado === "pagado"
            ? "Sí: el cobro ya está pagado."
            : r.estado === "pendiente"
              ? "Todavía no: el cobro sigue pendiente."
              : `El cobro está ${estadoTexto[r.estado]}.`;
        return ok(resumen, {
          cobro_id,
          pagado: r.estado === "pagado",
          estado: r.estado,
          tipo: r.tipo,
          ...("monto_del_link" in r
            ? { monto_del_link: r.monto_del_link }
            : {}),
          pagos: r.pagos,
        });
      }),
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    "conciliar_dia",
    {
      title: "Conciliar el día",
      description:
        "Lista los pagos recibidos en un día (por defecto hoy, hora de Ciudad de México) y los totaliza por método. Sirve para el corte de caja: compara el total contra lo que el negocio espera cobrar. Solo lee. pey no ofrece saldos ni retiros: esto suma pagos recibidos, no el saldo de la cuenta.",
      inputSchema: z.object({
        fecha: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Día a conciliar, AAAA-MM-DD. Por defecto hoy"),
        cuenta_id: z
          .string()
          .optional()
          .describe(
            "Limitar a una cuenta registrada. Si se omite, todos los pagos de la clave de API",
          ),
        max_paginas: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe("Páginas de 80 pagos a revisar como máximo"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ fecha, cuenta_id, max_paginas }) =>
      guard(async () => {
        const tz = config.timezone;
        const dia = fecha ?? localDate(now().getTime() / 1000, tz);
        const cuenta = cuenta_id ?? undefined;
        const delDia: Transaction[] = [];
        let token: string | undefined;
        let completo = false;
        for (let pagina = 0; pagina < max_paginas; pagina++) {
          const page = await pey.listTransactions(
            cuenta ? { bankAccountId: cuenta } : {},
            token,
          );
          for (const tx of page.transactions) {
            if (tx.status !== "PAID" || tx.datePaid === undefined) continue;
            const d = localDate(tx.datePaid, tz);
            if (d === dia) delDia.push(tx);
            else if (d < dia) completo = true; // más recientes primero: ya pasamos el día
          }
          token = page.nextToken;
          if (completo || !token) {
            completo = true;
            break;
          }
        }
        const total = delDia.reduce((sum, t) => sum + t.amountCents, 0);
        const porMetodo: Record<string, { pagos: number; total: string }> = {};
        const acumulado: Record<string, { pagos: number; cents: number }> = {};
        for (const t of delDia) {
          const x = (acumulado[t.paymentMethod] ??= { pagos: 0, cents: 0 });
          x.pagos += 1;
          x.cents += t.amountCents;
        }
        for (const [m, x] of Object.entries(acumulado))
          porMetodo[m] = { pagos: x.pagos, total: money(x.cents) };
        return ok(
          `Conciliación del ${dia} (${tz}): ${delDia.length} pago(s), total ${money(total)}.${
            completo
              ? ""
              : " OJO: hay más páginas sin revisar; el total puede estar incompleto."
          }`,
          {
            fecha: dia,
            zona_horaria: tz,
            num_pagos: delDia.length,
            total_recibido: money(total),
            por_metodo: porMetodo,
            completo,
            pagos: delDia.map((t) => pago(t)),
          },
        );
      }),
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    "registrar_cuenta",
    {
      title: "Registrar cuenta bancaria",
      description:
        "Da de alta una cuenta (CLABE de 18 dígitos) para recibir cobros CoDi. La activación en CoDi no es inmediata: pasa de PENDING a ACTIVE; consúltala con `consultar_cuenta`. La CLABE debe ser de un banco con CoDi. Nunca repitas la CLABE completa en tus respuestas." +
        (production
          ? " ESTÁ EN PRODUCCIÓN: pide confirmación al dueño y envía confirmar=true."
          : ""),
      inputSchema: z.object({
        alias: z
          .string()
          .min(1)
          .max(255)
          .describe("Nombre corto para reconocerla. Ej. «Cuenta del negocio»"),
        nombre_legal: z
          .string()
          .min(1)
          .max(255)
          .describe("Nombre completo del titular tal como aparece en el banco"),
        clabe: z.string().describe("CLABE de 18 dígitos"),
        tipo_persona: z
          .enum(["persona_fisica", "empresa"])
          .describe(
            "persona_fisica: el titular es una persona. empresa: persona moral",
          ),
        confirmar: z
          .boolean()
          .optional()
          .describe("Solo producción: true tras la aprobación del dueño"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      guard(async () => {
        const clabe = args.clabe.replace(/[\s-]/g, "");
        if (!validClabe(clabe))
          throw new ToolError(
            "La CLABE no es válida: deben ser 18 dígitos con dígito verificador correcto.",
          );
        const entity = args.tipo_persona === "empresa" ? "BUSINESS" : "PERSON";
        if (production) {
          assertCanWrite(config);
          if (args.confirmar !== true)
            return ok(
              "VISTA PREVIA: todavía no se registró nada. Pide confirmación al dueño y repite con confirmar=true.",
              {
                registrada: false,
                vista_previa: {
                  alias: args.alias,
                  nombre_legal: args.nombre_legal,
                  clabe: maskClabe(clabe),
                  tipo_persona: args.tipo_persona,
                },
              },
            );
        }
        const cuenta = await pey.registerAccount({
          alias: args.alias,
          name: args.nombre_legal,
          clabe,
          entity,
        });
        return ok(
          `Cuenta registrada (${cuenta.status}). La activación en CoDi puede tardar: consúltala con consultar_cuenta.`,
          {
            registrada: true,
            cuenta_id: cuenta.id,
            estado: cuenta.status,
            alias: args.alias,
            clabe: maskClabe(clabe),
            tipo_persona: args.tipo_persona,
          },
        );
      }),
  );

  server.registerTool(
    "consultar_cuenta",
    {
      title: "Consultar cuenta bancaria",
      description:
        "Consulta una cuenta registrada en pey y su estado de activación CoDi (PENDING, PROCESSING, ACTIVE o ERROR). Solo ACTIVE puede recibir cobros con QR. La CLABE se muestra enmascarada.",
      inputSchema: z.object({
        cuenta_id: z
          .string()
          .min(1)
          .describe("El cuenta_id que devolvió registrar_cuenta"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ cuenta_id }) =>
      guard(async () => {
        const cuenta = await pey.getAccount(cuenta_id);
        return ok(
          cuenta.status === "ACTIVE"
            ? "La cuenta está ACTIVE: ya puede recibir cobros."
            : `La cuenta está ${cuenta.status}: todavía no puede recibir cobros.`,
          {
            cuenta_id: cuenta.id,
            estado: cuenta.status,
            activa: cuenta.status === "ACTIVE",
            alias: cuenta.alias,
            nombre_legal: cuenta.name,
            clabe: maskClabe(cuenta.clabe),
            tipo_persona:
              cuenta.entity === "BUSINESS" ? "empresa" : "persona_fisica",
          },
        );
      }),
  );

  /* ---------------------------------------------------------------- */
  if (!production && ctx.sandboxUrl) {
    const base = ctx.sandboxUrl;
    server.registerTool(
      "simular_pago",
      {
        title: "Simular que el cliente pagó (solo sandbox)",
        description:
          "SOLO EN SANDBOX: marca como pagado un cobro de prueba para ver el flujo completo. No existe en producción y no mueve dinero.",
        inputSchema: z.object({
          cobro_id: z.string().min(1).describe("El cobro_id de crear_cobro"),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      ({ cobro_id }) =>
        guard(async () => {
          const { kind, id } = parseHandle(cobro_id);
          const path =
            kind === "link"
              ? `payment-links/${id}`
              : kind === "tx"
                ? `pn/${id}`
                : `qr/${id}`;
          const response = await fetch(`${base}/__sandbox/${path}/pay`, {
            method: "POST",
          });
          if (!response.ok)
            throw new ToolError(`No se pudo simular el pago de ${cobro_id}.`);
          return ok(
            "Pago simulado en sandbox. Ahora revisar_cobro lo mostrará como pagado.",
            {
              cobro_id,
              simulado: true,
            },
          );
        }),
    );
  }
}
