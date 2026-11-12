import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { Runtime } from "./runtime.js";
import { SimulatedPey, SimulatedWhatsApp } from "./simulation.js";
import { RuleExtractor } from "./extraction.js";
import { createServer } from "./server.js";
import { Webhook } from "standardwebhooks";

export async function runDemo(output: (text: string) => void = console.log) {
  const directory = mkdtempSync(join(tmpdir(), "pey-demo-"));
  let time = Date.now();
  const merchant = "5215550000001@s.whatsapp.net",
    ana = "5215550000002@s.whatsapp.net",
    luis = "5215550000003@s.whatsapp.net";
  const store = new Store(
    join(directory, "demo.sqlite"),
    randomBytes(32).toString("hex"),
  );
  const c = new Coordinator(store, {
    merchantId: "demo",
    selfJids: [merchant],
    controlChatJid: merchant,
    pairedAt: time - 1000,
    now: () => time,
  });
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp(output);
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: new RuleExtractor() },
    { debounceMs: 0, now: () => time },
  );
  let seq = 0;
  const say = async (text: string, quotedMessageId?: string) => {
    output(`[Rafa → número del producto] ${text}`);
    runtime.accept({
      session: "PRODUCT",
      chatJid: merchant,
      messageId: `rafa-${++seq}`,
      fromMe: false,
      at: time,
      text,
      ...(quotedMessageId ? { quotedMessageId } : {}),
    });
    await runtime.step();
  };
  const chat = async (
    jid: string,
    who: "Rafa" | "cliente",
    text: string,
    extra: { imageRef?: string } = {},
  ) => {
    output(`[chat ${c.clientLabel(jid)} · ${who}] ${text || "(foto)"}`);
    runtime.accept({
      session: "MERCHANT",
      chatJid: jid,
      messageId: `chat-${++seq}`,
      fromMe: who === "Rafa",
      at: time,
      text,
      ...extra,
    });
    await runtime.step();
  };
  const last = (needle: RegExp) =>
    wa.deliveries.findLast((d) => needle.test(d.text));
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const server = createServer({
    secret,
    apiKeyId: "simulation",
    saveWebhook: (id, event) => c.saveWebhook(id, event),
  });
  const webhook = async (qrId: string, bankAccountId: string, id: string) => {
    const tx = [...pey.transactions.values()].find(
      (t) => t.payableId === qrId,
    )!;
    const body = JSON.stringify({
      type: "codi.qr.payment_received",
      transactionId: tx.id,
      codiQrId: qrId,
      bankAccountId,
      apiKeyId: "simulation",
    });
    const date = new Date();
    const res = await server.inject({
      method: "POST",
      url: "/webhooks/pey",
      payload: body,
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
        "webhook-signature": new Webhook(secret).sign(id, date, body),
      },
    });
    assert.equal(res.statusCode, 202);
    await runtime.step();
  };
  try {
    output("SIMULACIÓN COMPLETA. Sin WhatsApp, IA ni dinero reales.");
    await say("hola");
    for (const answer of [
      "Taller Rafa",
      "Rafael Ortiz Méndez",
      "646180157034432952",
      "física",
    ])
      await say(answer);
    assert.equal(pey.accounts.size, 0, "No se registra sin consentimiento");
    await say("Sí, autorizo");
    const account = c.listAccounts()[0]!;
    assert.equal(account.status, "PENDING");
    assert.match(last(/cinco días hábiles/)!.text, /cinco días hábiles/);
    await say("agrega a Ana 5215550000002");
    await say("agrega a Luis 5215550000003");
    output("SIMULACIÓN: pey activa la cuenta (ficticio).");
    pey.accounts.get(account.providerId!)!.status = "ACTIVE";
    c.updateAccount(account.id, "ACTIVE");

    await chat(
      ana,
      "Rafa",
      "Ana, balatas 800 y mano de obra 400, total 1200. Anticipo 600.",
    );
    await chat(ana, "cliente", "Va, ¿cómo te pago?");
    await chat(ana, "cliente", "Sí, mándalo");
    const prompt = last(/¿Le envío a Ana/)!;
    assert.equal(prompt.channel, "PRODUCT");
    assert.equal(pey.charges.size, 0, "El sí del cliente no autoriza");
    await say("Sí");
    assert.equal(pey.charges.size, 1);
    const qrDelivery = wa.deliveries.find((d) => d.qrString)!;
    assert.equal(qrDelivery.channel, "MERCHANT");
    assert.equal(qrDelivery.recipientJid, ana);
    const qrId = [...pey.charges.keys()][0]!;
    pey.pay(qrId);
    await webhook(qrId, account.providerId!, "demo-webhook");
    assert.match(last(/Recibiste/)!.text, /verificado por pey/);
    const notices = wa.deliveries.filter((d) => /Recibiste/.test(d.text));
    await webhook(qrId, account.providerId!, "demo-webhook");
    assert.equal(
      wa.deliveries.filter((d) => /Recibiste/.test(d.text)).length,
      notices.length,
      "Reenviar el webhook no duplica el aviso",
    );

    await chat(
      luis,
      "Rafa",
      "Luis, balatas 800 y mano de obra 400, total 1200. Anticipo 1200.",
    );
    await chat(luis, "cliente", "Va");
    assert.match(last(/¿Le envío a Luis/)!.text, /\$1,200\.00/);
    await chat(
      luis,
      "Rafa",
      "Luis, balatas 800 y mano de obra 400 y cambio de disco 400, total 1600. Anticipo 1600.",
    );
    await chat(luis, "cliente", "Va, está bien");
    await say("Sí");
    const luisCharge = [...pey.charges.values()].find(
      (r) => r.amountCents === 160000,
    );
    assert.ok(luisCharge, "El «Sí» liga el cobro corregido de $1,600");
    assert.equal(
      [...pey.charges.values()].filter((r) => r.amountCents === 120000).length,
      0,
      "El precio anterior de Luis nunca se cobró",
    );
    await chat(luis, "cliente", "", { imageRef: "comprobante" });
    assert.match(last(/Comprobante de/)!.text, /No cuenta como pagado/);
    const luisQr = [...pey.charges.entries()].find(
      ([, r]) => r.amountCents === 160000,
    )![0];
    assert.equal(
      c.balance(luisCharge.workOrderId).verifiedCents,
      0,
      "La foto es reporte, no pago",
    );
    pey.pay(luisQr);
    await webhook(luisQr, account.providerId!, "demo-webhook-luis");
    assert.equal(c.balance(luisCharge.workOrderId).verifiedCents, 160000);
    output(
      "PASS: alta conversacional, cliente elegido, propuesta, «Sí» ligado, cambio de precio, QR por el chat del comerciante, webhook firmado, deduplicación y comprobante como reporte.",
    );
    return {
      directory,
      deliveries: wa.deliveries,
      balance: c.balance(luisCharge.workOrderId),
      checks: 14,
    };
  } finally {
    await server.close();
    store.close();
  }
}
if (
  process.argv[1]?.endsWith("/demo.ts") ||
  process.argv[1]?.endsWith("/demo.js")
) {
  const transcript: string[] = [];
  runDemo((text) => {
    console.log(text);
    transcript.push(text);
  })
    .then((result) => {
      if (process.env.DEMO_ARTIFACT_DIR) {
        mkdirSync(process.env.DEMO_ARTIFACT_DIR, { recursive: true });
        writeFileSync(
          join(process.env.DEMO_ARTIFACT_DIR, "demo.txt"),
          transcript.join("\n") + "\n",
        );
      }
      console.log(`Base ficticia de inspección: ${result.directory}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
