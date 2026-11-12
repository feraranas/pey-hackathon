// Read-only smoke test against the real pey API. It creates no QR, registers
// no account and moves no money. It never prints a key, a secret or a full CLABE.
//
//   PEY_API_KEY, PEY_WEBHOOK_SECRET   required
//   PEY_BANK_ACCOUNT_ID               optional: also GET /bank-account/{id}
//   PUBLIC_BASE_URL                   optional: checks the webhook endpoint rejects an unsigned POST
import { Webhook } from "standardwebhooks";
import { PeyClient, verifyPeyWebhook } from "../src/pey.js";
import { RemoteFailure } from "../src/contracts.js";

const apiKey = process.env.PEY_API_KEY;
const secret = process.env.PEY_WEBHOOK_SECRET;
if (!apiKey || !secret)
  throw new Error(
    "Se requieren PEY_API_KEY y PEY_WEBHOOK_SECRET en el entorno",
  );

const mask = (clabe: string) => `${"*".repeat(14)}${clabe.slice(-4)}`;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? "OK  " : "FALLA"} ${check}: ${detail}`);
};

// 1. Key accepted by production, read-only listing.
const client = new PeyClient({ apiKey });
try {
  const page = await client.listApiKeyTransactions();
  record(
    "GET /transaction/api-key",
    true,
    `200, ${page.ids.length} pagos${page.nextToken ? " (hay más páginas)" : ""}`,
  );
} catch (e) {
  record(
    "GET /transaction/api-key",
    false,
    e instanceof RemoteFailure ? e.message : "error de red",
  );
}

// 2. Optional bank account status.
const accountId = process.env.PEY_BANK_ACCOUNT_ID;
if (accountId) {
  try {
    const a = await client.getAccount(accountId);
    record(
      "GET /bank-account/{id}",
      true,
      `${a.status}, ${a.entity}, CLABE ${mask(a.clabe)}`,
    );
  } catch (e) {
    record(
      "GET /bank-account/{id}",
      false,
      e instanceof RemoteFailure ? e.message : "error de red",
    );
  }
} else
  record(
    "GET /bank-account/{id}",
    true,
    "omitido: no hay PEY_BANK_ACCOUNT_ID (pey no ofrece listar cuentas)",
  );

// 3. The webhook secret can sign and verify, offline.
try {
  const raw = JSON.stringify({
    type: "bank.account.updated",
    bankAccountId: "smoke",
  });
  const now = new Date();
  const headers = {
    "webhook-id": "smoke",
    "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign("smoke", now, raw),
  };
  verifyPeyWebhook(raw, headers, secret);
  let tamperedRejected = false;
  try {
    verifyPeyWebhook(`${raw} `, headers, secret);
  } catch {
    tamperedRejected = true;
  }
  record(
    "firma de webhook (local)",
    tamperedRejected,
    tamperedRejected
      ? "firma válida aceptada y alterada rechazada"
      : "una carga alterada fue aceptada",
  );
} catch {
  record("firma de webhook (local)", false, "el secreto no sirve para firmar");
}

// 4. Our public endpoint refuses an unsigned POST.
const base = process.env.PUBLIC_BASE_URL;
if (base) {
  try {
    const r = await fetch(new URL("/webhooks/pey", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    record(
      "POST sin firma a /webhooks/pey",
      r.status === 401,
      `HTTP ${r.status} (se espera 401)`,
    );
  } catch {
    record("POST sin firma a /webhooks/pey", false, "sin respuesta");
  }
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
