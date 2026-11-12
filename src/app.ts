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
import { OpenAIExtractor, RuleExtractor } from "./extraction.js";
import { RoutedWhatsApp } from "./router.js";
import { SidecarWhatsApp } from "./sidecar.js";
import type { Observation } from "./contracts.js";
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
    ...(config.OPENAI_API_KEY ? [config.OPENAI_API_KEY] : []),
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
  const merchantJids = [
    config.MERCHANT_JID,
    ...(config.MERCHANT_LID ? [config.MERCHANT_LID] : []),
  ];
  const coordinator = new Coordinator(store, {
    merchantId: config.MERCHANT_ID,
    selfJids: merchantJids,
    controlChatJid: config.MERCHANT_JID,
    pairedAt,
  });
  for (const jid of config.allowedChatJids) coordinator.allowChat(jid);
  let runtime: Runtime;
  const pairingPrinter = (label: string) => (qr: string) => {
    try {
      const matrix = QRCode.create(qr).modules;
      const margin = 4;
      const width = matrix.size + margin * 2;
      const dark = (row: number, col: number) =>
        row >= margin &&
        col >= margin &&
        row < matrix.size + margin &&
        col < matrix.size + margin &&
        Boolean(matrix.get(row - margin, col - margin));
      let rendered = "";
      for (let row = 0; row < width; row += 2) {
        rendered += "\x1b[0;30;47m";
        for (let col = 0; col < width; col++) {
          const top = dark(row, col),
            bottom = dark(row + 1, col);
          rendered += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
        }
        rendered += "\x1b[0m\n";
      }
      process.stdout.write(
        `QR PRIVADO (${label}). Amplía la terminal a ${width} columnas como mínimo y escanea desde WhatsApp → Dispositivos vinculados.\n${rendered}`,
      );
    } catch {
      logger.error("No se pudo mostrar el QR de vinculación");
    }
  };
  const session = (
    channel: "PRODUCT" | "MERCHANT",
    ownJid: string,
    allowedJids: string[] | (() => string[]),
    authFile: string,
  ) => {
    const common = {
      session: channel,
      pairedAt,
      allowedJids,
      onObservation: (observation: Observation) => {
        runtime.accept(observation);
      },
      onEcho: (messageId: string, chatJid: string) =>
        coordinator.markDeliveryEcho(messageId, chatJid),
      onIdentity: (jids: string[]) => {
        logger.info(
          { channel, identityCount: jids.length },
          "Sesión de WhatsApp identificada",
        );
        if (channel === "PRODUCT") {
          coordinator.bindSelfJids(merchantJids);
          coordinator.notifyControl(
            "Verificando el canal de cobros. Si recibes este mensaje, escríbeme «hola» para empezar.",
            `session-probe:${randomUUID()}`,
          );
        }
      },
      onPairingQr: pairingPrinter(channel),
      onError: (error: unknown) =>
        logger.error({ err: error, channel }, "Error de WhatsApp"),
    };
    if (config[`${channel}_TRANSPORT`] === "whatsmeow")
      return new SidecarWhatsApp({
        ...common,
        socketPath: config[`${channel}_SIDECAR_SOCKET`]!,
        expectedOwnJids: [ownJid],
        onPasskeyRequest: () =>
          logger.warn(
            { channel },
            "WhatsApp pide una passkey: paso humano pendiente (ver docs/plan-tres-horas/01-whatsmeow.md)",
          ),
        onPasskeyCode: () =>
          logger.warn(
            { channel },
            "Hay un código de comparación de vinculación pendiente",
          ),
      });
    return new BaileysWhatsApp({
      ...common,
      onConnectionDiagnostic: (diagnostic) => {
        logger.info(
          { channel, ...diagnostic },
          "WhatsApp connection diagnostic",
        );
      },
      pairingPhoneNumber:
        config.WHATSAPP_PAIRING_MODE === "code"
          ? ownJid.split("@")[0]
          : undefined,
      onPairingCode: (code) => {
        process.stdout.write(
          `Código PRIVADO de vinculación (${channel}): ${code}\nEn WhatsApp: Dispositivos vinculados → Vincular con número de teléfono.\n`,
        );
      },
      authPath: join(config.DATA_DIR, authFile),
      encryptionKey: Buffer.from(config.SESSION_ENCRYPTION_KEY, "hex"),
      expectedOwnJids: [ownJid],
    });
  };
  const productSession = session(
    "PRODUCT",
    config.PRODUCT_JID,
    merchantJids,
    "whatsapp-product.enc",
  );
  const merchantSession = session(
    "MERCHANT",
    config.MERCHANT_JID,
    () => coordinator.listClients().map((client) => client.jid),
    "whatsapp.enc",
  );
  const whatsapp = new RoutedWhatsApp({
    PRODUCT: productSession,
    MERCHANT: merchantSession,
  });
  runtime = new Runtime(
    coordinator,
    {
      pey: new PeyClient({ apiKey: config.PEY_API_KEY }),
      whatsapp,
      extractor: config.OPENAI_API_KEY
        ? new OpenAIExtractor({
            apiKey: config.OPENAI_API_KEY,
            model: config.OPENAI_MODEL,
          })
        : new RuleExtractor(),
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
    productSession.stop();
    merchantSession.stop();
    await active;
    await server.close();
    store.close();
    await release();
  };
  try {
    await server.listen({ host: config.HOST, port: config.PORT });
    await productSession.start();
    await merchantSession.start();
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
