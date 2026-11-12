import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Coordinator } from "./coordinator.js";
import { RuleExtractor } from "./extraction.js";
import { PeyClient } from "./pey.js";
import { createPeySandbox } from "./pey-sandbox.js";
import { Runtime } from "./runtime.js";
import { createServer } from "./server.js";
import { SimulatedWhatsApp } from "./simulation.js";
import { Store } from "./store.js";
import type { Observation } from "./contracts.js";

export const MERCHANT_JID = "5215550000001@s.whatsapp.net";

/**
 * The whole product on one machine: the real coordinator, runtime, webhook
 * server and PeyClient, talking over HTTP to a Pey sandbox, with simulated
 * WhatsApp sessions. Nothing here reaches WhatsApp or moves money.
 */
export async function startLocal(
  options: {
    debounceMs?: number;
    output?: (text: string) => void;
    dataDir?: string;
  } = {},
) {
  const directory =
    options.dataDir ?? mkdtempSync(join(tmpdir(), "pey-local-"));
  const apiKey = `sandbox-${randomBytes(8).toString("hex")}`;
  const apiKeyId = "sandbox-key";
  const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
  const store = new Store(
    join(directory, "pey.sqlite"),
    randomBytes(32).toString("hex"),
  );
  const coordinator = new Coordinator(store, {
    merchantId: "local",
    selfJids: [MERCHANT_JID],
    controlChatJid: MERCHANT_JID,
    pairedAt: Date.now() - 1000,
  });
  const sandbox = createPeySandbox({ apiKey, apiKeyId, webhookSecret });
  await sandbox.app.listen({ host: "127.0.0.1", port: 0 });
  const sandboxUrl = `http://127.0.0.1:${(sandbox.app.server.address() as { port: number }).port}`;
  const whatsapp = new SimulatedWhatsApp(options.output);
  const runtime = new Runtime(
    coordinator,
    {
      pey: new PeyClient({
        apiKey,
        baseUrl: sandboxUrl,
        allowLoopbackHttp: true,
      }),
      whatsapp,
      extractor: new RuleExtractor(),
    },
    { debounceMs: options.debounceMs ?? 0 },
  );
  const server = createServer({
    secret: webhookSecret,
    apiKeyId,
    saveWebhook: (id, event) => coordinator.saveWebhook(id, event),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const appUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  sandbox.setWebhookUrl(`${appUrl}/webhooks/pey`);

  let sequence = 0;
  const clientJid = (name: string) => {
    const hit = coordinator
      .listClients()
      .find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw new Error(`Cliente desconocido: ${name}`);
    return hit.jid;
  };
  const observe = (o: Omit<Observation, "messageId" | "at">) =>
    runtime.accept({ ...o, messageId: `local-${++sequence}`, at: Date.now() });
  const sandboxPost = async (path: string) =>
    (await fetch(`${sandboxUrl}${path}`, { method: "POST" })).json() as Promise<
      Record<string, unknown>
    >;

  return {
    directory,
    appUrl,
    sandboxUrl,
    coordinator,
    runtime,
    whatsapp,
    sandbox,
    store,
    async merchantSays(text: string, quotedMessageId?: string) {
      observe({
        session: "PRODUCT",
        chatJid: MERCHANT_JID,
        fromMe: false,
        text,
        ...(quotedMessageId ? { quotedMessageId } : {}),
      });
      await runtime.step();
    },
    async inClientChat(
      name: string,
      who: "merchant" | "client",
      text: string,
      imageRef?: string,
    ) {
      observe({
        session: "MERCHANT",
        chatJid: clientJid(name),
        fromMe: who === "merchant",
        text,
        ...(imageRef ? { imageRef } : {}),
      });
      await runtime.step();
    },
    async activateAccounts() {
      for (const id of sandbox.accounts.keys())
        await sandboxPost(`/__sandbox/accounts/${id}/activate`);
      await runtime.step();
    },
    async payQr(qrId: string) {
      const result = await sandboxPost(`/__sandbox/qr/${qrId}/pay`);
      await runtime.step();
      return result;
    },
    resendWebhook: async (id: string) => {
      const result = await sandboxPost(`/__sandbox/webhooks/${id}/resend`);
      await runtime.step();
      return result;
    },
    async stop() {
      await server.close();
      await sandbox.app.close();
      store.close();
    },
  };
}

async function repl() {
  const say = (text: string) => console.log(text);
  const app = await startLocal({ debounceMs: 1500, output: say });
  say(
    `SIMULACIÓN LOCAL. Webhook ${app.appUrl}/webhooks/pey · pey sandbox ${app.sandboxUrl}. Sin WhatsApp ni dinero reales.`,
  );
  say(
    "Comandos: p <texto> (Rafa → producto) · r <cliente> <texto> (Rafa en el chat del cliente) · c <cliente> <texto> (el cliente) · foto <cliente> · activar · pagar · salir",
  );
  const timer = setInterval(() => void app.runtime.step(), 500);
  let lastQr: string | undefined;
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd = "", ...rest] = line.trim().split(/\s+/);
    try {
      if (cmd === "p") await app.merchantSays(rest.join(" "));
      else if (cmd === "r" || cmd === "c")
        await app.inClientChat(
          rest[0]!,
          cmd === "r" ? "merchant" : "client",
          rest.slice(1).join(" "),
        );
      else if (cmd === "foto")
        await app.inClientChat(rest[0]!, "client", "", "foto");
      else if (cmd === "activar") await app.activateAccounts();
      else if (cmd === "pagar") {
        const unpaid = [...app.sandbox.qrs.keys()].filter(
          (id) =>
            ![...app.sandbox.transactions.values()].some(
              (t) => t.payableId === id,
            ),
        );
        lastQr = unpaid.at(-1);
        if (!lastQr) say("No hay QR pendiente de pago.");
        else say(JSON.stringify(await app.payQr(lastQr)));
      } else if (cmd === "salir") break;
      else if (cmd) say("Comando desconocido.");
    } catch (error) {
      say(error instanceof Error ? error.message : "Error");
    }
  }
  clearInterval(timer);
  await app.stop();
}
if (
  process.argv[1]?.endsWith("/local.ts") ||
  process.argv[1]?.endsWith("/local.js")
)
  void repl();
