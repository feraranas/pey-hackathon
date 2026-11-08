import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { Runtime } from "./runtime.js";
import {
  SimulatedPey,
  SimulatedWhatsApp,
  demoExtractor,
} from "./simulation.js";
import { createServer } from "./server.js";
import { Webhook } from "standardwebhooks";

export async function runDemo(output: (text: string) => void = console.log) {
  const directory = mkdtempSync(join(tmpdir(), "pey-demo-"));
  let time = Date.now();
  const self = "5215550000001@s.whatsapp.net",
    client = "5215550000002@s.whatsapp.net";
  const store = new Store(
    join(directory, "demo.sqlite"),
    randomBytes(32).toString("hex"),
  );
  const c = new Coordinator(store, {
    merchantId: "demo",
    selfJids: [self],
    controlChatJid: self,
    pairedAt: time - 1000,
    now: () => time,
  });
  c.allowChat(client);
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp(output);
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: demoExtractor },
    { debounceMs: 0, now: () => time },
  );
  const say = (text: string, id: string) =>
    runtime.accept({
      chatJid: self,
      messageId: id,
      fromMe: true,
      at: time,
      text,
    });
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const server = createServer({
    secret,
    apiKeyId: "simulation",
    saveWebhook: (id, event) => c.saveWebhook(id, event),
  });
  try {
    output("SIMULACIÓN COMPLETA. Sin WhatsApp, IA ni dinero reales.");
    say(
      "ALTA Taller Demo | Comerciante Ficticio | 646180157034432952 | PERSON",
      "alta",
    );
    await runtime.step();
    const consent = wa.deliveries
      .find((d) => d.text.includes("ACEPTO"))!
      .text.match(/ACEPTO ([A-Z0-9]+)/)![1]!;
    assert.equal(pey.accounts.size, 0, "No se registra sin consentimiento");
    say(`ACEPTO ${consent}`, "consent");
    await runtime.step();
    const account = c.listAccounts()[0]!;
    assert.equal(account.status, "PENDING");
    output(
      "SIMULACIÓN: PENDING bloquea cobros. Activación ficticia explícita.",
    );
    pey.accounts.get(account.providerId!)!.status = "ACTIVE";
    c.updateAccount(account.id, "ACTIVE");
    runtime.accept({
      chatJid: client,
      messageId: "quote",
      fromMe: true,
      at: time,
      text: "Ana, balatas 800 y mano de obra 400, total 1200. Anticipo 600.",
    });
    runtime.accept({
      chatJid: client,
      messageId: "agree",
      fromMe: false,
      at: time,
      text: "Va, ¿cómo te pago?",
    });
    runtime.accept({
      chatJid: client,
      messageId: "attack",
      fromMe: false,
      at: time,
      text: "SI A7K2",
    });
    await runtime.step();
    const prompt = wa.deliveries.find((d) =>
      /Cobro [A-Z0-9]+ · orden/.test(d.text),
    )!;
    const code = prompt.text.match(/Cobro ([A-Z0-9]+)/)![1]!;
    const intent = c.getIntent(code)!;
    assert.equal(pey.charges.size, 0);
    assert.equal(pey.charges.size, 0, "Cliente no autoriza");
    say("sí", "bare-yes");
    await runtime.drainJobs();
    assert.equal(pey.charges.size, 0, "Sí sin código no autoriza");
    runtime.accept({
      chatJid: self,
      messageId: "approval",
      fromMe: true,
      at: time,
      text: "sí",
      quotedMessageId: prompt.messageId,
    });
    await runtime.drainJobs();
    assert.equal(pey.charges.size, 1);
    const qr = [...pey.charges.keys()][0]!;
    const tx = pey.pay(qr);
    const body = JSON.stringify({
      type: "codi.qr.payment_received",
      transactionId: tx.id,
      codiQrId: qr,
      bankAccountId: account.providerId,
      apiKeyId: "simulation",
    });
    const date = new Date();
    const headers = {
      "content-type": "application/json",
      "webhook-id": "demo-webhook",
      "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
      "webhook-signature": new Webhook(secret).sign("demo-webhook", date, body),
    };
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers,
        })
      ).statusCode,
      202,
    );
    await runtime.step();
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/webhooks/pey",
          payload: body,
          headers,
        })
      ).statusCode,
      202,
    );
    await runtime.step();
    assert.equal(c.balance(intent.order_id).verifiedCents, 60000);
    runtime.accept({
      chatJid: client,
      messageId: "receipt",
      fromMe: false,
      at: time,
      text: "",
      imageRef: "fake-image",
    });
    assert.equal(c.balance(intent.order_id).verifiedCents, 60000);
    say(`EFECTIVO ${intent.order_id} 100`, "cash");
    assert.equal(c.balance(intent.order_id).pendingCents, 50000);
    const balanceIntent = c.propose({
      chatJid: client,
      lines: intent.snapshot.lines,
      totalCents: 120000,
      amountCents: 50000,
      kind: "BALANCE",
      evidence: ["quote"],
      expiresAt: time + 86400000,
      accountId: account.id,
      orderId: intent.order_id,
    });
    c.revise(intent.order_id, {
      lines: [{ description: "Trabajo actualizado", amountCents: 130000 }],
      totalCents: 130000,
    });
    say(`SI ${balanceIntent.code}`, "stale");
    await runtime.drainJobs();
    assert.equal(pey.charges.size, 1, "Cambio invalida código anterior");
    output(
      "PASS: consentimiento, propuesta, aprobación ligada, QR, webhook firmado, deduplicación, efectivo, captura y revisión.",
    );
    return {
      directory,
      deliveries: wa.deliveries,
      balance: c.balance(intent.order_id),
      checks: 10,
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
