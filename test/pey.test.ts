import { describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { PeyClient, verifyPeyWebhook } from "../src/pey.js";
import { RemoteFailure } from "../src/contracts.js";

const qr = {
  intentId: "intent",
  workOrderId: "order",
  revision: 1,
  amountCents: 10001,
  concept: "Servicio",
  expiration: 600,
  numRef: "123",
  bankAccountId: "account",
};
const tx = {
  id: "tx",
  status: "PAID",
  amount: 100.01,
  amountBreakdown: { base: 100.01 },
  currency: "MXN",
  paymentMethod: "CODI",
  payableType: "API_CODI_QR",
  payableId: "qr",
  metadata: { clabe: "012180001234567899" },
  datePaid: 1704067200,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("PeyClient", () => {
  it("creates a fixed QR for the specified receiver with exact pesos", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: "qr", qrString: "payload" }, 201));
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    expect(await client.createQr(qr)).toEqual({
      id: "qr",
      qrString: "payload",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.pey.mx/codi/qr");
    expect(JSON.parse(init!.body as string)).toEqual({
      amount: 100.01,
      concept: "Servicio",
      expiration: 600,
      numRef: "123",
      generateImage: false,
      bankAccountId: "account",
      metadata: { chargeIntentId: "intent", workOrderId: "order", revision: 1 },
    });
    await expect(
      client.createQr({ ...qr, bankAccountId: "" }),
    ).rejects.toThrow();
    await expect(client.createQr({ ...qr, amountCents: 0 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("distinguishes rejected creation from uncertain failures and never retries", async () => {
    for (const [status, uncertain] of [
      [400, false],
      [500, true],
      [503, true],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({}, status));
      const client = new PeyClient({ apiKey: "secret", fetch: fetcher });
      await expect(client.createQr(qr)).rejects.toMatchObject({ uncertain });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: "qr" }, 201));
    await expect(
      new PeyClient({ apiKey: "secret", fetch: fetcher }).createQr(qr),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it("times out even if fetch does not settle", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    await expect(
      new PeyClient({
        apiKey: "secret",
        fetch: fetcher,
        timeoutMs: 5,
      }).createQr(qr),
    ).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates and converts transaction amounts exactly", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(tx))
      .mockResolvedValueOnce(response({ ...tx, amount: 100.001 }));
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    expect(await client.getTransaction("tx")).toEqual({
      id: "tx",
      status: "PAID",
      amountCents: 10001,
      baseCents: 10001,
      currency: "MXN",
      paymentMethod: "CODI",
      payableType: "API_CODI_QR",
      payableId: "qr",
      receiverClabe: "012180001234567899",
      datePaid: 1704067200,
    });
    await expect(client.getTransaction("tx")).rejects.toBeInstanceOf(
      RemoteFailure,
    );
  });
  it("follows page tokens and hydrates list items from transaction details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ items: [{ id: "tx" }], nextToken: "a+/=" }),
      )
      .mockResolvedValueOnce(response(tx))
      .mockResolvedValueOnce(response({ items: [], nextToken: null }));
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    const first = await client.listQrTransactions("qr");
    expect(first.transactions[0]?.payableId).toBe("qr");
    expect(first.nextToken).toBe("a+/=");
    expect(await client.listQrTransactions("qr", first.nextToken)).toEqual({
      transactions: [],
    });
    expect(fetcher.mock.calls[2]![0]).toBe(
      "https://api.pey.mx/transaction/codi/qr/qr?nextToken=a%2B%2F%3D",
    );
  });
  it("requires HTTPS and refuses URL credentials or redirects", () => {
    for (const baseUrl of [
      "http://localhost:8080",
      "https://user:pass@example.com",
      "https://example.com/?key=secret",
    ]) {
      expect(() => new PeyClient({ apiKey: "key", baseUrl })).toThrow();
    }
  });
  it("rejects mismatched account and transaction identities", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          id: "other",
          alias: "a",
          name: "n",
          clabe: "012180001234567899",
          entity: "PERSON",
          codiStatus: "ACTIVE",
        }),
      )
      .mockResolvedValueOnce(response({ ...tx, id: "other" }))
      .mockResolvedValueOnce(
        response({ items: [{ id: "tx" }], nextToken: null }),
      )
      .mockResolvedValueOnce(response({ ...tx, payableId: "other" }));
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    await expect(client.getAccount("account")).rejects.toMatchObject({
      uncertain: false,
    });
    await expect(client.getTransaction("tx")).rejects.toMatchObject({
      uncertain: false,
    });
    await expect(client.listQrTransactions("qr")).rejects.toMatchObject({
      uncertain: false,
    });
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("handles cent boundaries and rejects unsafe amounts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        response({ id: "qr", qrString: "payload" }, 201),
      );
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    await client.createQr({ ...qr, amountCents: 1 });
    await client.createQr({ ...qr, amountCents: 29 });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).amount).toBe(
      0.01,
    );
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).amount).toBe(
      0.29,
    );
    await expect(
      client.createQr({ ...qr, amountCents: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow();
    const reads = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ ...tx, amount: 0.01, amountBreakdown: { base: 0.29 } }),
      )
      .mockResolvedValueOnce(response({ ...tx, amount: 0.001 }))
      .mockResolvedValueOnce(response({ ...tx, amount: 90071992547410 }));
    const reader = new PeyClient({ apiKey: "key", fetch: reads });
    expect(await reader.getTransaction("tx")).toMatchObject({
      amountCents: 1,
      baseCents: 29,
    });
    await expect(reader.getTransaction("tx")).rejects.toBeInstanceOf(
      RemoteFailure,
    );
    await expect(reader.getTransaction("tx")).rejects.toBeInstanceOf(
      RemoteFailure,
    );
  });
  it("classifies malformed successful account creation and read timeout safely", async () => {
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ id: "account", codiStatus: "BOGUS" }));
    const client = new PeyClient({ apiKey: "key", fetch: malformed });
    await expect(
      client.registerAccount({
        alias: "a",
        name: "n",
        clabe: "012180001234567899",
        entity: "PERSON",
      }),
    ).rejects.toMatchObject({ uncertain: true });
    const stalled = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    await expect(
      new PeyClient({
        apiKey: "key",
        fetch: stalled,
        timeoutMs: 5,
      }).getTransaction("tx"),
    ).rejects.toMatchObject({ uncertain: false });
  });
  it("registers and reads a bank account", async () => {
    const input = {
      alias: "BBVA",
      name: "Titular",
      clabe: "012180001234567899",
      entity: "PERSON" as const,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "account", codiStatus: "PENDING" }))
      .mockResolvedValueOnce(
        response({ id: "account", ...input, codiStatus: "ACTIVE" }),
      );
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    expect(await client.registerAccount(input)).toEqual({
      id: "account",
      status: "PENDING",
    });
    expect(await client.getAccount("account")).toEqual({
      id: "account",
      ...input,
      status: "ACTIVE",
    });
    await expect(
      client.registerAccount({ ...input, clabe: "bad" }),
    ).rejects.toThrow();
  });
});

describe("PeyClient read-only key listing", () => {
  it("lists payment ids with a GET and no body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ items: [{ id: "a" }], nextToken: null }));
    const client = new PeyClient({ apiKey: "key", fetch: fetcher });
    expect(await client.listApiKeyTransactions()).toEqual({ ids: ["a"] });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.pey.mx/transaction/api-key");
    expect(init!.method).toBe("GET");
    expect(init!.body).toBeUndefined();
  });
  it("rejects a malformed page and reports a rejected key without uncertainty", async () => {
    const bad = new PeyClient({
      apiKey: "key",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ items: 3 })),
    });
    await expect(bad.listApiKeyTransactions()).rejects.toThrow(RemoteFailure);
    const forbidden = new PeyClient({
      apiKey: "key",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ message: "no" }, 403)),
    });
    await expect(forbidden.listApiKeyTransactions()).rejects.toMatchObject({
      uncertain: false,
    });
  });
});

describe("verifyPeyWebhook", () => {
  const secret = `whsec_${Buffer.from("a sufficiently long webhook secret").toString("base64")}`;
  const signer = new Webhook(secret);
  const headers = (payload: string) => {
    const now = new Date();
    return {
      "webhook-id": "message",
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": signer.sign("message", now, payload),
    };
  };
  it("verifies the exact raw bytes and parses supported events", () => {
    const raw = JSON.stringify({
      type: "codi.qr.payment_received",
      transactionId: "tx",
      codiQrId: "qr",
      apiKeyId: "key",
      bankAccountId: "account",
      amount: 100,
    });
    expect(verifyPeyWebhook(raw, headers(raw), secret)).toEqual({
      type: "codi.qr.payment_received",
      transactionId: "tx",
      codiQrId: "qr",
      apiKeyId: "key",
      bankAccountId: "account",
    });
    expect(() => verifyPeyWebhook(`${raw} `, headers(raw), secret)).toThrow();
    const account = JSON.stringify({
      type: "bank.account.updated",
      bankAccountId: "account",
    });
    expect(verifyPeyWebhook(account, headers(account), secret)).toEqual({
      type: "bank.account.updated",
      bankAccountId: "account",
    });
  });
  it("rejects signed malformed JSON and unsupported or incomplete events", () => {
    for (const raw of [
      "{",
      JSON.stringify({ type: "codi.qr.payment_received" }),
      JSON.stringify({ type: "unknown" }),
    ]) {
      expect(() => verifyPeyWebhook(raw, headers(raw), secret)).toThrow();
    }
  });
});
