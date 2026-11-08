import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { lockDataDirectory } from "./lifecycle.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { Store } from "./store.js";
import { Coordinator } from "./coordinator.js";
import { PeyClient } from "./pey.js";
import { BaileysWhatsApp } from "./whatsapp.js";
import { OpenAIExtractor } from "./extraction.js";
import { Runtime } from "./runtime.js";
import { createServer } from "./server.js";

export async function main() {
  const config = loadConfig();
  if (config.MODE !== "live")
    throw new Error(
      "Para simulación usa npm run demo; el servidor requiere MODE=live.",
    );
  const logger = createLogger([
    config.PEY_API_KEY,
    config.OPENAI_API_KEY,
    config.PEY_WEBHOOK_SECRET,
    config.SESSION_ENCRYPTION_KEY,
  ]);
  await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(config.DATA_DIR, 0o700);
  const release = await lockDataDirectory(config.DATA_DIR, () => {
    logger.fatal("Se perdió el bloqueo exclusivo del proceso");
    process.exit(1);
  });
  const store = new Store(
    join(config.DATA_DIR, "pey.sqlite"),
    config.SESSION_ENCRYPTION_KEY,
  );
  await chmod(join(config.DATA_DIR, "pey.sqlite"), 0o600);
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  const prior = store.db
    .prepare("SELECT value FROM app_settings WHERE key='paired_at'")
    .get() as { value: string } | undefined;
  const pairedAt = prior
    ? Number(prior.value)
    : Math.floor(Date.now() / 1000) * 1000;
  if (!prior)
    store.db
      .prepare("INSERT INTO app_settings VALUES(?,?)")
      .run("paired_at", String(pairedAt));
  const selfJids = [
    config.SELF_JID,
    ...(config.SELF_LID ? [config.SELF_LID] : []),
  ];
  const coordinator = new Coordinator(store, {
    merchantId: config.MERCHANT_ID,
    selfJids,
    controlChatJid: config.SELF_JID,
    pairedAt,
  });
  coordinator.setAllowedChats(config.allowedChatJids);
  let runtime: Runtime;
  const whatsapp = new BaileysWhatsApp({
    authPath: join(config.DATA_DIR, "whatsapp.enc"),
    encryptionKey: Buffer.from(config.SESSION_ENCRYPTION_KEY, "hex"),
    allowedJids: config.allowedChatJids,
    expectedOwnJids: selfJids,
    pairedAt,
    onObservation: (observation) => {
      runtime.accept(observation);
    },
    onEcho: (messageId, chatJid) =>
      coordinator.markDeliveryEcho(messageId, chatJid),
    onIdentity: (jids) => {
      coordinator.bindSelfJids(jids);
      coordinator.notifyControl(
        "Verificando sesión de cobros. Al recibir este mensaje puedes usar ALTA o aprobar un código vigente.",
        `session-probe:${randomUUID()}`,
      );
      logger.info(
        { identityCount: jids.length },
        "Sesión de WhatsApp identificada",
      );
    },
    onPairingQr: (qr) => {
      void QRCode.toString(qr, { type: "terminal", small: true })
        .then((rendered) =>
          process.stdout.write(
            `Vincula el teléfono del comerciante. Este QR es privado.\n${rendered}`,
          ),
        )
        .catch(() => logger.error("No se pudo mostrar el QR de vinculación"));
    },
    onError: (error) => logger.error({ err: error }, "Error de WhatsApp"),
  });
  runtime = new Runtime(
    coordinator,
    {
      pey: new PeyClient({ apiKey: config.PEY_API_KEY }),
      whatsapp,
      extractor: new OpenAIExtractor({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_MODEL,
      }),
    },
    {
      debounceMs: config.EXTRACTION_DELAY_MS,
      logger,
      canDeliver: () => whatsapp.ready,
    },
  );
  const server = createServer({
    secret: config.PEY_WEBHOOK_SECRET,
    apiKeyId: config.PEY_API_KEY_ID,
    saveWebhook: (id, event) => coordinator.saveWebhook(id, event),
    logger,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let active: Promise<void> = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    active = runtime
      .step()
      .catch((error) => logger.error({ err: error }, "Ciclo de trabajo falló"))
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 500);
      });
  };
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    whatsapp.stop();
    await active;
    await server.close();
    store.close();
    await release();
  };
  try {
    await server.listen({ host: config.HOST, port: config.PORT });
    await whatsapp.start();
    schedule();
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    logger.info(
      { port: config.PORT },
      "Servicio iniciado; esperando vinculación y verificación de WhatsApp",
    );
  } catch (error) {
    await shutdown();
    throw error;
  }
  return { shutdown, server };
}
if (
  process.argv[1]?.endsWith("/app.ts") ||
  process.argv[1]?.endsWith("/app.js")
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "No se pudo iniciar",
    );
    process.exitCode = 1;
  });
}
