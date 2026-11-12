import { afterEach, describe, expect, it } from "vitest";
import { startLocal } from "../src/local.js";

const NAME = "Ana",
  ANA = "5215550000002";
let app: Awaited<ReturnType<typeof startLocal>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});
const texts = (a: NonNullable<typeof app>, re: RegExp) =>
  a.whatsapp.deliveries.filter((d) => re.test(d.text));

async function onboard(a: NonNullable<typeof app>) {
  await a.merchantSays("hola");
  for (const answer of [
    "Taller Rafa",
    "Rafael Ortiz Méndez",
    "646180157034432952",
    "física",
  ])
    await a.merchantSays(answer);
  await a.merchantSays("Sí, autorizo");
  expect(a.sandbox.accounts.size).toBe(1);
  expect(texts(a, /cinco días hábiles/).length).toBeGreaterThan(0);
  await a.merchantSays(`agrega a ${NAME} ${ANA}`);
  await a.activateAccounts();
  expect(a.coordinator.listAccounts()[0]!.status).toBe("ACTIVE");
  expect(texts(a, /Ya puedes cobrar/)).toHaveLength(1);
}

describe("end to end over HTTP: PeyClient → pey sandbox → signed webhook → app", () => {
  it("onboarding → agreement → proposal → «Sí» → QR → webhook paid → notification", async () => {
    app = await startLocal();
    await onboard(app);
    await app.inClientChat(
      NAME,
      "merchant",
      "Ana, balatas 800 y mano de obra 400, total 1200. Anticipo 600.",
    );
    await app.inClientChat(NAME, "client", "Va, ¿cómo te pago?");
    expect(texts(app, /¿Le envío a Ana el cobro de \$600\.00/)).toHaveLength(1);
    expect(app.sandbox.qrs.size).toBe(0);

    await app.merchantSays("Sí");
    expect(app.sandbox.qrs.size).toBe(1);
    const qr = app.whatsapp.deliveries.find((d) => d.qrString)!;
    expect(qr).toMatchObject({
      channel: "MERCHANT",
      recipientJid: `${ANA}@s.whatsapp.net`,
    });
    expect(qr.qrString).toContain("SANDBOX-PEY");
    const [qrId] = [...app.sandbox.qrs.keys()];
    const [request] = [...app.sandbox.qrs.values()];
    expect(request!.bankAccountId).toBe(
      app.coordinator.listAccounts()[0]!.providerId,
    );

    const paid = await app.payQr(qrId!);
    expect(paid.webhookStatus).toBe(202);
    const received = texts(app, /Recibiste \$600\.00 de Ana/);
    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe("PRODUCT");

    expect(
      (await app.resendWebhook(paid.webhookId as string)).webhookStatus,
    ).toBe(202);
    expect(texts(app, /Recibiste/)).toHaveLength(1);
    const order = app.store.db.prepare("SELECT id FROM orders").get() as {
      id: string;
    };
    expect(app.coordinator.balance(order.id)).toMatchObject({
      verifiedCents: 60000,
      pendingCents: 60000,
    });
  });

  it("an unsigned or wrongly signed webhook is refused and pays nothing", async () => {
    app = await startLocal();
    await onboard(app);
    const before = app.store.db
      .prepare("SELECT COUNT(*) AS n FROM webhooks")
      .get();
    for (const headers of [
      {} as Record<string, string>,
      {
        "webhook-id": "x",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,AAAA",
      },
    ]) {
      const res = await fetch(`${app.appUrl}/webhooks/pey`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          type: "codi.qr.payment_received",
          transactionId: "t",
          codiQrId: "q",
          apiKeyId: "sandbox-key",
        }),
      });
      expect(res.status).toBe(401);
    }
    expect(
      app.store.db.prepare("SELECT COUNT(*) AS n FROM webhooks").get(),
    ).toEqual(before);
    expect(
      app.store.db.prepare("SELECT COUNT(*) AS n FROM receipts").get(),
    ).toEqual({
      n: 0,
    });
  });
});

describe("pey sandbox boundary", () => {
  it("requires the bearer key and refuses QRs for inactive accounts", async () => {
    app = await startLocal();
    expect((await fetch(`${app.sandboxUrl}/bank-account/x`)).status).toBe(401);
    await app.merchantSays("hola");
    for (const a of ["Taller", "Rafael", "646180157034432952", "moral"])
      await app.merchantSays(a);
    await app.merchantSays("Sí, autorizo");
    const [account] = [...app.sandbox.accounts.values()];
    expect(account!.codiStatus).toBe("PENDING");
    const { PeyClient } = await import("../src/pey.js");
    const client = new PeyClient({
      apiKey: "wrong",
      baseUrl: app.sandboxUrl,
      allowLoopbackHttp: true,
    });
    await expect(client.getAccount(account!.id)).rejects.toThrow();
    expect(
      () => new PeyClient({ apiKey: "k", baseUrl: "http://example.com" }),
    ).toThrow();
    expect(
      () =>
        new PeyClient({
          apiKey: "k",
          baseUrl: "http://example.com",
          allowLoopbackHttp: true,
        }),
    ).toThrow();
  });
});
