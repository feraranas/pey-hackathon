import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  initAuthCreds,
  jidNormalizedUser,
  proto,
  type AuthenticationState,
  type WASocket,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import {
  RemoteFailure,
  type Delivery,
  type Observation,
  type WhatsAppPort,
} from "./contracts.js";

export function normalizeJid(jid: string): string {
  const normalized = jidNormalizedUser(jid);
  return /^(\d+)@(s\.whatsapp\.net|lid)$/.test(normalized) ? normalized : "";
}

type RawMessage = proto.IWebMessageInfo;
export function connectionDiagnostic(
  update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  },
  registered: boolean,
) {
  const status = (
    update.lastDisconnect?.error as
      { output?: { statusCode?: unknown } } | undefined
  )?.output?.statusCode;
  return {
    connection: ["connecting", "open", "close"].includes(
      update.connection ?? "",
    )
      ? update.connection
      : "update",
    registered: Boolean(registered),
    qrAvailable: Boolean(update.qr),
    statusCode:
      typeof status === "number" && Number.isFinite(status) ? status : null,
    willReconnect:
      update.connection === "close" && status !== DisconnectReason.loggedOut,
  };
}
export function parseObservation(
  message: RawMessage,
  options: { ownJids: string[]; allowedJids: string[]; pairedAt: number },
): Observation | null {
  const own = new Set(options.ownJids.map(normalizeJid).filter(Boolean));
  const allowed = new Set(
    options.allowedJids.map(normalizeJid).filter(Boolean),
  );
  const chatJid = normalizeJid(message.key?.remoteJid ?? "");
  const messageId = message.key?.id;
  const timestamp = Number(message.messageTimestamp) * 1000;
  if (
    !own.size ||
    !chatJid ||
    !messageId ||
    !Number.isFinite(timestamp) ||
    timestamp < options.pairedAt
  )
    return null;
  const control = own.has(chatJid);
  if (control ? !message.key?.fromMe : !allowed.has(chatJid)) return null;
  const content =
    message.message?.ephemeralMessage?.message ??
    message.message?.viewOnceMessage?.message ??
    message.message;
  if (!content) return null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    "";
  if (!text && !content.imageMessage) return null;
  return {
    chatJid,
    messageId,
    fromMe: !!message.key?.fromMe,
    at: timestamp,
    text,
    ...(content.extendedTextMessage?.contextInfo?.stanzaId
      ? { quotedMessageId: content.extendedTextMessage.contextInfo.stanzaId }
      : {}),
    ...(content.imageMessage ? { imageRef: messageId } : {}),
  };
}

export async function encryptedAuthState(
  path: string,
  key: Buffer,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  if (key.length !== 32)
    throw new Error("Session encryption key must be 32 bytes");
  let stored: {
    creds: AuthenticationState["creds"];
    keys: Record<string, Record<string, unknown>>;
  };
  try {
    const data = await readFile(path);
    if (data.length < 29 || data[0] !== 1)
      throw new Error("Invalid encrypted session");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
    decipher.setAuthTag(data.subarray(13, 29));
    stored = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(29)),
        decipher.final(),
      ]).toString(),
      BufferJSON.reviver,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    stored = { creds: initAuthCreds(), keys: {} };
  }
  let pending = Promise.resolve();
  const save = () => {
    const plain = Buffer.from(JSON.stringify(stored, BufferJSON.replacer));
    pending = pending.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(
        temp,
        Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]),
        { mode: 0o600 },
      );
      await rename(temp, path);
    });
    return pending;
  };
  const state: AuthenticationState = {
    creds: stored.creds,
    keys: {
      get: async (type, ids) => {
        const result: Record<string, any> = {};
        for (const id of ids) {
          let value = stored.keys[type]?.[id];
          if (type === "app-state-sync-key" && value)
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
            );
          if (value) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        for (const [type, values] of Object.entries(data)) {
          const bucket = (stored.keys[type] ??= {});
          for (const [id, value] of Object.entries(values ?? {})) {
            if (value == null) delete bucket[id];
            else bucket[id] = value;
          }
        }
        await save();
      },
    },
  };
  return { state, saveCreds: save };
}

export type WhatsAppOptions = {
  authPath: string;
  encryptionKey: Buffer;
  allowedJids: string[];
  expectedOwnJids: string[];
  pairedAt: number;
  ackTimeoutMs?: number;
  reconnectDelayMs?: number;
  controlBufferLimit?: number;
  socketFactory?: typeof makeWASocket;
  onIdentity?: (jids: string[]) => void | Promise<void>;
  onObservation: (observation: Observation) => void | Promise<void>;
  onEcho: (messageId: string, chatJid: string) => void | Promise<void>;
  onPairingQr?: (qr: string) => void;
  pairingPhoneNumber?: string;
  onPairingCode?: (code: string) => void;
  onConnectionDiagnostic?: (
    diagnostic: ReturnType<typeof connectionDiagnostic>,
  ) => void;
  onError: (error: unknown) => void;
};
export class BaileysWhatsApp implements WhatsAppPort {
  private socket?: WASocket;
  private auth?: Awaited<ReturnType<typeof encryptedAuthState>>;
  private ownJids: string[] = [];
  private stopped = true;
  private verifiedDelivery = false;
  private controlBuffer: Observation[] = [];
  private bufferOverflow = false;
  get ready(): boolean {
    return !this.stopped && this.ownJids.length > 0;
  }
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private events = Promise.resolve();
  private pending = new Map<string, { jid: string; resolve: () => void }>();
  constructor(private readonly options: WhatsAppOptions) {
    if (
      options.pairingPhoneNumber &&
      (!/^[1-9]\d{6,14}$/.test(options.pairingPhoneNumber) ||
        !options.expectedOwnJids
          .map(normalizeJid)
          .includes(`${options.pairingPhoneNumber}@s.whatsapp.net`))
    )
      throw new Error("Pairing number must match configured owner");
    if (!options.expectedOwnJids.some(normalizeJid))
      throw new Error("Expected owner identity is required");
    if (!Number.isFinite(options.pairedAt) || options.pairedAt <= 0)
      throw new Error("A persisted pairing timestamp is required");
  }
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }
  private async connect(): Promise<void> {
    this.auth ??= await encryptedAuthState(
      this.options.authPath,
      this.options.encryptionKey,
    );
    const { state, saveCreds } = this.auth;
    const socket = (this.options.socketFactory ?? makeWASocket)({
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      logger: pino({ level: "silent" }),
    });
    this.socket = socket;
    let pairingRequested = false;
    socket.ev.on("creds.update", () => {
      void saveCreds().catch(this.options.onError);
    });
    socket.ev.on("connection.update", (update) => {
      if (this.socket !== socket || this.stopped) return;
      this.options.onConnectionDiagnostic?.(
        connectionDiagnostic(update, state.creds.registered),
      );
      if (update.qr && this.options.pairingPhoneNumber) {
        if (!state.creds.registered && !pairingRequested) {
          pairingRequested = true;
          void socket
            .requestPairingCode(this.options.pairingPhoneNumber)
            .then((code) => {
              if (this.socket === socket && !this.stopped)
                this.options.onPairingCode?.(code);
            })
            .catch(() =>
              this.options.onError(
                new Error(
                  "No se pudo solicitar el código de vinculación; reinicia para reintentar",
                ),
              ),
            );
        }
      } else if (update.qr) this.options.onPairingQr?.(update.qr);
      if (update.connection === "open") {
        const actual = [socket.user?.id, socket.user?.lid]
          .filter((jid): jid is string => !!jid)
          .map(normalizeJid)
          .filter(Boolean);
        const expected = this.options.expectedOwnJids
          .map(normalizeJid)
          .filter(Boolean);
        const actualNumber = actual.find((jid) =>
          jid.endsWith("@s.whatsapp.net"),
        );
        if (!actualNumber || !expected.includes(actualNumber)) {
          this.ownJids = [];
          this.options.onError?.(
            new Error(
              "WhatsApp owner identity does not match configured merchant",
            ),
          );
          return;
        }
        this.ownJids = actual;
        try {
          void Promise.resolve(this.options.onIdentity?.(actual)).catch(
            (error) => this.options.onError?.(error),
          );
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      if (update.connection === "close") {
        this.ownJids = [];
        this.verifiedDelivery = false;
        const code = (
          update.lastDisconnect?.error as
            { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (!this.stopped && code !== DisconnectReason.loggedOut)
          this.scheduleReconnect();
      }
    });
    socket.ev.on("messages.upsert", (event) => {
      if (this.socket !== socket || this.stopped) return;
      if (event.type !== "notify" && event.type !== "append") return;
      for (const raw of event.messages) {
        const observation = parseObservation(raw, {
          ownJids: this.ownJids,
          allowedJids: this.options.allowedJids,
          pairedAt: this.options.pairedAt,
        });
        if (!observation) continue;
        if (observation.fromMe)
          this.ack(observation.messageId, observation.chatJid);
        const isControl = this.ownJids.includes(observation.chatJid);
        if (observation.fromMe)
          this.enqueue(() =>
            this.options.onEcho(observation.messageId, observation.chatJid),
          );
        if (!isControl || this.verifiedDelivery)
          this.enqueue(() => this.options.onObservation(observation));
        else if (!this.bufferOverflow) {
          if (
            this.controlBuffer.length >=
            (this.options.controlBufferLimit ?? 1000)
          ) {
            this.bufferOverflow = true;
            this.options.onError?.(
              new Error(
                "WhatsApp control buffer overflow; restart and review missed messages",
              ),
            );
          } else this.controlBuffer.push(observation);
        }
      }
    });
    socket.ev.on("messages.update", (updates) => {
      if (this.socket !== socket || this.stopped) return;
      for (const update of updates) {
        if (
          (update.update.status ?? 0) >=
            proto.WebMessageInfo.Status.SERVER_ACK &&
          update.key.fromMe &&
          update.key.id &&
          update.key.remoteJid
        )
          this.ack(update.key.id, normalizeJid(update.key.remoteJid));
      }
    });
  }
  private enqueue(action: () => void | Promise<void>): void {
    this.events = this.events.then(action).catch((error) => {
      this.options.onError?.(error);
    });
  }
  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      void this.connect().catch((error) => {
        this.options.onError?.(error);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, this.options.reconnectDelayMs ?? 3000);
  }
  private ack(id: string, jid: string): void {
    const entry = this.pending.get(id);
    if (entry?.jid === jid) entry.resolve();
  }
  async deliver(item: Delivery): Promise<void> {
    const jid = normalizeJid(item.recipientJid);
    const allowed = this.options.allowedJids.map(normalizeJid);
    if (
      !this.socket ||
      !this.ownJids.length ||
      !jid ||
      (!this.ownJids.includes(jid) && !allowed.includes(jid))
    )
      throw new Error("WhatsApp recipient or owner identity is not authorized");
    if (!item.messageId) throw new Error("A persisted message ID is required");
    const content = item.qrString
      ? { image: await QRCode.toBuffer(item.qrString), caption: item.text }
      : { text: item.text };
    if (this.pending.has(item.messageId))
      throw new Error("Message ID already in flight");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ack = new Promise<void>((resolve) => {
      this.pending.set(item.messageId, { jid, resolve });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error("WhatsApp delivery uncertain: acknowledgement timed out"),
          ),
        this.options.ackTimeoutMs ?? 15000,
      );
    });
    const socket = this.socket;
    try {
      await Promise.race([
        timeout,
        (async () => {
          const sent = await socket.sendMessage(jid, content, {
            messageId: item.messageId,
          });
          if (!sent || sent.key.id !== item.messageId)
            throw new Error(
              "WhatsApp delivery uncertain: supplied message ID was not preserved",
            );
          await ack;
        })(),
      ]);
      if (!this.bufferOverflow && this.socket === socket && this.ready) {
        this.verifiedDelivery = true;
        for (const observation of this.controlBuffer.splice(0))
          this.enqueue(() => this.options.onObservation(observation));
      }
    } catch (error) {
      throw new RemoteFailure(
        error instanceof Error ? error.message : "WhatsApp delivery uncertain",
        true,
      );
    } finally {
      clearTimeout(timer);
      this.pending.delete(item.messageId);
    }
  }
  stop(): void {
    this.stopped = true;
    this.verifiedDelivery = false;
    clearTimeout(this.reconnectTimer);
    this.ownJids = [];
    this.socket?.end(undefined);
    this.socket = undefined;
  }
}
