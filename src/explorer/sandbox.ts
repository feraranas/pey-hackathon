import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPeySandbox } from "../pey-sandbox.js";

/** A running local stand-in for api.pey.mx with a little data to browse. */
export async function startExplorerSandbox() {
  const apiKey = `sbx_${randomBytes(18).toString("base64url")}`;
  const webhookSecret = `whsec_${randomBytes(24).toString("base64")}`;
  const apiKeyId = "sandbox-api-key-id";
  const sandbox = createPeySandbox({ apiKey, apiKeyId, webhookSecret });
  await sandbox.app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${(sandbox.app.server.address() as AddressInfo).port}`;
  const call = async (method: "POST", url: string, payload?: unknown) =>
    (
      await sandbox.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${apiKey}` },
        ...(payload ? { payload: payload as object } : {}),
      })
    ).json() as Record<string, string>;

  // One ACTIVE account, one paid QR, one pending payment link: every GET card has data.
  const account = sandbox.seedAccount({
    alias: "Cuenta de ejemplo (sandbox)",
    name: "Taller Rafa S.A. de C.V.",
    clabe: "012180009998887778",
    entity: "BUSINESS",
  });
  const qr = await call("POST", "/codi/qr", {
    amount: 1,
    bankAccountId: account.id,
    expiration: 600,
    concept: "Cobro de ejemplo",
    numRef: "1",
  });
  const paid = await call("POST", `/__sandbox/qr/${qr.id}/pay`);
  const link = await call("POST", "/payment-link/create", {
    amount: 1,
    successUrl: "https://example.com/success",
    backUrl: "https://example.com/cancel",
    clientReferenceId: "ejemplo-1",
  });
  return {
    sandbox,
    apiKey,
    apiKeyId,
    webhookSecret,
    baseUrl,
    seed: {
      bankAccountId: account.id,
      qrId: qr.id!,
      transactionId: paid.transactionId!,
      paymentLinkId: link.id!,
    },
  };
}
