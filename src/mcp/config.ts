import { z } from "zod";

/**
 * Configuración del servidor MCP de pey, leída del entorno.
 *
 * Por defecto corre en **sandbox** (un pey de mentira en memoria: no se mueve
 * dinero). Con `PEY_MODE=production` habla con https://api.pey.mx usando la
 * clave real, y las escrituras quedan protegidas (ver `docs/mcp.md`).
 */
export type McpConfig = {
  mode: "sandbox" | "production";
  /** Solo producción. */
  apiKey?: string;
  baseUrl: string;
  /** Tope por cobro, en centavos. */
  maxAmountCents: number;
  /** En producción, las escrituras exigen PEY_MCP_ALLOW_WRITES=true. */
  allowWrites: boolean;
  /** Cuenta que recibe los cobros con QR; sin ella, la ligada a la clave. */
  bankAccountId?: string;
  successUrl: string;
  backUrl: string;
  qrExpirationSeconds: number;
  timezone: string;
};

const pesos = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "debe ser un monto en pesos, p. ej. 500 o 99.50");
const schema = z.object({
  PEY_MODE: z.enum(["sandbox", "production"]).default("sandbox"),
  PEY_API_KEY: z.string().min(1).optional(),
  PEY_BASE_URL: z.string().url().startsWith("https://").optional(),
  PEY_MCP_MAX_AMOUNT: pesos.optional(),
  PEY_MCP_ALLOW_WRITES: z.enum(["true", "false"]).optional(),
  PEY_BANK_ACCOUNT_ID: z.string().min(1).optional(),
  PEY_LINK_SUCCESS_URL: z.string().url().startsWith("https://").optional(),
  PEY_LINK_BACK_URL: z.string().url().startsWith("https://").optional(),
  PEY_QR_EXPIRATION_SECONDS: z.coerce.number().int().min(360).optional(),
  PEY_MCP_TIMEZONE: z.string().min(1).default("America/Mexico_City"),
});

/** En producción, sin PEY_MCP_MAX_AMOUNT el tope es de $100 MXN por cobro. */
export const DEFAULT_PRODUCTION_MAX_PESOS = "100";
export const DEFAULT_SANDBOX_MAX_PESOS = "1000000";

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success)
    throw new Error(
      `Configuración inválida: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const e = parsed.data;
  const production = e.PEY_MODE === "production";
  if (production && !e.PEY_API_KEY)
    throw new Error("PEY_MODE=production requiere PEY_API_KEY");
  const maxPesos =
    e.PEY_MCP_MAX_AMOUNT ??
    (production ? DEFAULT_PRODUCTION_MAX_PESOS : DEFAULT_SANDBOX_MAX_PESOS);
  const [whole = "0", fraction = ""] = maxPesos.split(".");
  return {
    mode: e.PEY_MODE,
    ...(e.PEY_API_KEY ? { apiKey: e.PEY_API_KEY } : {}),
    baseUrl: e.PEY_BASE_URL ?? "https://api.pey.mx",
    maxAmountCents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
    allowWrites: production ? e.PEY_MCP_ALLOW_WRITES === "true" : true,
    ...(e.PEY_BANK_ACCOUNT_ID ? { bankAccountId: e.PEY_BANK_ACCOUNT_ID } : {}),
    successUrl: e.PEY_LINK_SUCCESS_URL ?? "https://pey.mx/",
    backUrl: e.PEY_LINK_BACK_URL ?? "https://pey.mx/",
    qrExpirationSeconds: e.PEY_QR_EXPIRATION_SECONDS ?? 3600,
    timezone: e.PEY_MCP_TIMEZONE,
  };
}
