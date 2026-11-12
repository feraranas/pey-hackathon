import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  MODE: z.enum(["live", "simulation"]).default("live"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().min(1),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, "must be 64 hexadecimal characters"),
  PEY_API_KEY: z.string().min(1),
  PEY_API_KEY_ID: z.string().min(1),
  PEY_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://"), "must use HTTPS"),
  MERCHANT_ID: z.string().min(1).default("merchant-1"),
  MERCHANT_JID: z.string().regex(/^\d+@s\.whatsapp\.net$/),
  MERCHANT_LID: z.string().optional(),
  PRODUCT_JID: z.string().regex(/^\d+@s\.whatsapp\.net$/),
  WHATSAPP_PAIRING_MODE: z.enum(["qr", "code"]).default("qr"),
  ALLOWED_CHAT_JIDS: z.string().default(""),
  EXTRACTION_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
});
export type Config = z.infer<typeof schema> & { allowedChatJids: string[] };
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    ...env,
    MERCHANT_JID: env.MERCHANT_JID ?? env.SELF_JID,
    MERCHANT_LID: env.MERCHANT_LID ?? env.SELF_LID,
    OPENAI_API_KEY: env.OPENAI_API_KEY || undefined,
  });
  if (!parsed.success) {
    throw new Error(
      `Configuración inválida: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const allowedChatJids = parsed.data.ALLOWED_CHAT_JIDS.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (allowedChatJids.some((jid) => !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)))
    throw new Error(
      "ALLOWED_CHAT_JIDS debe contener chats individuales separados por coma",
    );
  if (
    allowedChatJids.includes(parsed.data.MERCHANT_JID) ||
    allowedChatJids.includes(parsed.data.PRODUCT_JID)
  )
    throw new Error("El comerciante y el producto no son chats de cliente");
  if (parsed.data.MERCHANT_JID === parsed.data.PRODUCT_JID)
    throw new Error(
      "El número del producto debe ser distinto del WhatsApp del comerciante",
    );
  return {
    ...parsed.data,
    DATA_DIR: resolve(parsed.data.DATA_DIR),
    allowedChatJids,
  };
}
