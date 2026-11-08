import { describe, it, expect } from "vitest";
import { Webhook } from "standardwebhooks";
import { createServer } from "../src/server.js";
import type { ProviderEvent } from "../src/contracts.js";
const secret = `whsec_${Buffer.from("test-webhook-signing-secret-32bytes").toString("base64")}`;
const payload = {
  type: "codi.qr.payment_received",
  transactionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  codiQrId: "qr-1",
  apiKeyId: "api-1",
};
function signed(body: string, id = "evt-1") {
  const date = new Date();
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(id, date, body),
  };
}
describe("webhook HTTP boundary", () => {
  it("ACKs after durable storage, dedupes, rejects invalid signature before saving", async () => {
    const saved = new Map<string, ProviderEvent>();
    const server = createServer({
      secret,
      apiKeyId: "api-1",
      saveWebhook(id, event) {
        if (saved.has(id)) return false;
        saved.set(id, event);
        return true;
      },
    });
    const body = JSON.stringify(payload);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers: signed(body),
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers: signed(body),
        })
      ).statusCode,
    ).toBe(202);
    expect(saved.size).toBe(1);
    const headers = signed(body, "evt-invalid");
    headers["webhook-signature"] = "v1,bad";
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(saved.size).toBe(1);
    await server.close();
  });
  it("returns retryable error if evidence cannot be persisted", async () => {
    const server = createServer({
      secret,
      apiKeyId: "api-1",
      saveWebhook() {
        throw new Error("disk full");
      },
    });
    const body = JSON.stringify(payload);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers: signed(body),
        })
      ).statusCode,
    ).toBe(503);
    await server.close();
  });
  it("rejects a valid signature for a different API key", async () => {
    let stored = false;
    const server = createServer({
      secret,
      apiKeyId: "api-2",
      saveWebhook() {
        stored = true;
        return true;
      },
    });
    const body = JSON.stringify(payload);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers: signed(body),
        })
      ).statusCode,
    ).toBe(403);
    expect(stored).toBe(false);
    await server.close();
  });
});
