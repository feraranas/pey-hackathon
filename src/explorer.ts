// Visual explorer for pey's public API. Run: npm run explorer
//
//   EXPLORER_PORT        default 4173 (always bound to 127.0.0.1; use a tunnel)
//   EXPLORER_TOKEN_FILE  default ~/.config/pey-explorer/token (created 0600 if missing)
//   PEY_API_KEY          enables «producción» (the key never leaves this process)
//   PEY_API_KEY_ID, PEY_WEBHOOK_SECRET   optional, for signing/verifying webhooks
//   EXPLORER_PROD_POSTS=1   unlock POSTs in producción (default: locked)
//   EXPLORER_MAX_AMOUNT     largest amount in MXN for production POSTs (default 5)
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createExplorer } from "./explorer/server.js";
import { startExplorerSandbox } from "./explorer/sandbox.js";

const tokenFile =
  process.env.EXPLORER_TOKEN_FILE ??
  join(homedir(), ".config", "pey-explorer", "token");
if (!existsSync(tokenFile)) {
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${randomBytes(24).toString("base64url")}\n`, {
    mode: 0o600,
  });
}
chmodSync(tokenFile, 0o600);
const token = readFileSync(tokenFile, "utf8").trim();
if (token.length < 20)
  throw new Error(`El token de ${tokenFile} es demasiado corto`);

const port = Number(process.env.EXPLORER_PORT ?? 4173);
const sandbox = await startExplorerSandbox();
const apiKey = process.env.PEY_API_KEY;
const maxAmount = Number(process.env.EXPLORER_MAX_AMOUNT ?? 5);
const explorer = createExplorer({
  token,
  sandbox: {
    baseUrl: sandbox.baseUrl,
    apiKey: sandbox.apiKey,
    apiKeyId: sandbox.apiKeyId,
    webhookSecret: sandbox.webhookSecret,
    seed: sandbox.seed,
  },
  ...(apiKey
    ? {
        production: {
          apiKey,
          ...(process.env.PEY_API_KEY_ID
            ? { apiKeyId: process.env.PEY_API_KEY_ID }
            : {}),
          ...(process.env.PEY_WEBHOOK_SECRET
            ? { webhookSecret: process.env.PEY_WEBHOOK_SECRET }
            : {}),
          postsEnabled: process.env.EXPLORER_PROD_POSTS === "1",
          maxAmount:
            Number.isFinite(maxAmount) && maxAmount > 0 ? maxAmount : 5,
        },
      }
    : {}),
});
await explorer.listen({ host: "127.0.0.1", port });
sandbox.sandbox.setWebhookUrl(`http://127.0.0.1:${port}/webhooks/pey`);
console.log(
  `Explorador de pey en http://127.0.0.1:${port}  (usuario: pey, contraseña en ${tokenFile})\n` +
    `Sandbox: sí · Producción: ${apiKey ? `sí (escrituras ${process.env.EXPLORER_PROD_POSTS === "1" ? "habilitadas" : "bloqueadas"})` : "no, falta PEY_API_KEY"}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void Promise.all([explorer.close(), sandbox.sandbox.app.close()]).finally(
      () => process.exit(0),
    );
  });
