import { transcribeVoice, type TranscriberPort } from "./transcription.js";
import { createConnection, type Socket } from "node:net";
import QRCode from "qrcode";
import {
  RemoteFailure,
  type Channel,
  type Delivery,
  type Observation,
  type WhatsAppPort,
} from "./contracts.js";

export const SIDECAR_PROTOCOL = 1;
const MAX_FRAME = 1 << 20;

type Frame = {
  v: number;
  t: string;
  ref?: string;
  id?: string;
  chat?: string;
  to?: string;
  chatAlt?: string;
  fromMe?: boolean;
  at?: number;
  text?: string;
  quotedId?: string;
  hasImage?: boolean;
  hasAudio?: boolean;
  audioB64?: string;
  audioMime?: string;
  outcome?: string;
  detail?: string;
  version?: string;
  protocol?: number;
  phase?: string;
  identity?: string[];
  code?: string;
  payload?: unknown;
};

export type SidecarOptions = {
  session: Channel;
  socketPath: string;
  expectedOwnJids: string[];
  allowedJids: string[] | (() => string[]);
  pairedAt: number;
  ackTimeoutMs?: number;
  reconnectDelayMs?: number;
  controlBufferLimit?: number;
  onIdentity?: (jids: string[]) => void | Promise<void>;
  onObservation: (observation: Observation) => void | Promise<void>;
  onEcho: (messageId: string, chatJid: string) => void | Promise<void>;
  onPairingQr?: (qr: string) => void;
  onPasskeyRequest?: (publicKey: unknown) => void;
  onPasskeyCode?: (code: string) => void;
  /** The 8-character code that links the number from the phone. A pairing secret. */
  onPairCode?: (code: string) => void;
  onPairCodeError?: (detail: string) => void;
  /** Turns voice notes into text. Without one, voice notes are marked failed. */
  transcriber?: TranscriberPort;
  onError: (error: unknown) => void;
};

const numberOf = (jid: string) => jid.split("@")[0]!.split(":")[0]!;
const bare = (jid: string) => {
  const [user, server] = jid.split("@");
  return user && server ? `${user.split(":")[0]}@${server}` : "";
};

/** Mexico has two WhatsApp spellings, 52 + 10 digits and 521 + 10 digits. */
export const phoneKey = (jid: string) => {
  const b = bare(jid);
  return b.replace(/^521(\d{10})@/, "52$1@");
};

/**
 * Transport over the whatsmeow sidecar (NDJSON on a Unix socket, protocol 1).
 * It fails closed: a different protocol version, a different linked number,
 * an oversized frame or a queue overflow stop sends and observations. A send
 * is never repeated; anything not proven to have failed before transmit is
 * reported as uncertain.
 */
export class SidecarWhatsApp implements WhatsAppPort {
  private socket?: Socket;
  private stopped = true;
  private ownJids: string[] = [];
  private compatible = false;
  private verifiedDelivery = false;
  private overflowed = false;
  private buffer: Observation[] = [];
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private events = Promise.resolve();
  private pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly options: SidecarOptions) {
    if (!options.expectedOwnJids.some(bare))
      throw new Error("Expected owner identity is required");
    if (!Number.isFinite(options.pairedAt) || options.pairedAt <= 0)
      throw new Error("A persisted pairing timestamp is required");
  }
  get ready(): boolean {
    return (
      !this.stopped &&
      this.compatible &&
      !this.overflowed &&
      this.ownJids.length > 0
    );
  }
  start(): Promise<void> {
    this.stopped = false;
    return this.connect();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reset();
    this.socket?.destroy();
    this.socket = undefined;
  }
  private reset() {
    this.ownJids = [];
    this.compatible = false;
    this.verifiedDelivery = false;
    for (const [ref, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new RemoteFailure("Sidecar connection lost; delivery uncertain", true),
      );
      this.pending.delete(ref);
    }
  }
  private fail(error: unknown) {
    this.options.onError(error);
  }
  private allowed(): string[] {
    const { allowedJids } = this.options;
    return (typeof allowedJids === "function" ? allowedJids() : allowedJids)
      .map(bare)
      .filter(Boolean);
  }
  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const socket = createConnection(this.options.socketPath);
      this.socket = socket;
      let received = "";
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      socket.setEncoding("utf8");
      socket.on("connect", done);
      socket.on("data", (chunk: string) => {
        if (this.socket !== socket) return;
        received += chunk;
        let index: number;
        while ((index = received.indexOf("\n")) >= 0) {
          const line = received.slice(0, index);
          received = received.slice(index + 1);
          this.onLine(socket, line);
        }
        if (received.length > MAX_FRAME) {
          this.fail(new Error("Sidecar frame too large"));
          socket.destroy();
        }
      });
      socket.on("error", (error) => {
        if (this.socket === socket) this.fail(error);
        done();
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.reset();
        done();
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }
  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) void this.connect();
    }, this.options.reconnectDelayMs ?? 3000);
  }
  private write(frame: Omit<Frame, "v">) {
    this.socket?.write(
      `${JSON.stringify({ v: SIDECAR_PROTOCOL, ...frame })}\n`,
    );
  }
  private enqueue(action: () => void | Promise<void>) {
    this.events = this.events.then(action).catch((e) => this.fail(e));
  }
  private onLine(socket: Socket, line: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      this.fail(new Error("Invalid sidecar frame"));
      socket.destroy();
      return;
    }
    if (frame.v !== SIDECAR_PROTOCOL) {
      this.fail(new Error("Incompatible sidecar frame version"));
      socket.destroy();
      return;
    }
    switch (frame.t) {
      case "hello":
        if (frame.protocol !== SIDECAR_PROTOCOL) {
          this.fail(new Error("Incompatible sidecar protocol version"));
          socket.destroy();
          return;
        }
        this.compatible = true;
        return;
      case "status":
        return this.onStatus(frame);
      case "message":
        return this.onMessage(frame);
      case "send_result":
        return this.onSendResult(frame);
      case "overflow":
        this.overflowed = true;
        this.fail(
          new Error(
            "Sidecar queue overflow; restart and review missed messages",
          ),
        );
        return;
      case "pair_qr":
        if (frame.code) this.options.onPairingQr?.(frame.code);
        return;
      case "passkey_request":
        this.options.onPasskeyRequest?.(frame.payload);
        return;
      case "passkey_code":
        if (frame.code) this.options.onPasskeyCode?.(frame.code);
        return;
      case "pair_code":
        if (frame.code) this.options.onPairCode?.(frame.code);
        return;
      case "pair_code_error":
        this.options.onPairCodeError?.(frame.detail ?? "unknown");
        return;
      case "protocol_error":
      case "passkey_error":
        this.fail(new Error(`Sidecar reported ${frame.t}`));
        return;
    }
  }
  private onStatus(frame: Frame) {
    if (!this.compatible) return;
    const identity = (frame.identity ?? []).map(bare).filter(Boolean);
    const expected = this.options.expectedOwnJids.map(phoneKey).filter(Boolean);
    const matches =
      frame.phase === "connected" &&
      identity.some((jid) => expected.includes(phoneKey(jid)));
    if (!matches) {
      if (this.ownJids.length) this.verifiedDelivery = false;
      this.ownJids = [];
      if (frame.phase === "connected" && identity.length)
        this.fail(
          new Error("WhatsApp owner identity does not match configured number"),
        );
      return;
    }
    const changed = identity.join() !== this.ownJids.join();
    this.ownJids = identity;
    if (changed) this.enqueue(() => this.options.onIdentity?.(identity));
  }
  private onMessage(frame: Frame) {
    if (!this.ready || !frame.id || !frame.chat) return;
    const allowed = new Set(this.allowed());
    const own = new Set(this.ownJids.map(bare));
    const candidates = [frame.chat, frame.chatAlt].map((j) => bare(j ?? ""));
    if (candidates.some((jid) => jid && own.has(jid))) return;
    const chatJid = candidates.find((jid) => jid && allowed.has(jid));
    const at = Number(frame.at);
    if (!chatJid || !Number.isFinite(at) || at < this.options.pairedAt) return;
    if (!frame.text && !frame.hasImage && !frame.hasAudio) return;
    if (frame.hasAudio) {
      const base = {
        session: this.options.session,
        chatJid,
        messageId: frame.id,
        fromMe: !!frame.fromMe,
        at,
        ...(frame.quotedId ? { quotedMessageId: frame.quotedId } : {}),
      };
      this.enqueue(async () => {
        const observation = await transcribeVoice(
          base,
          frame.audioB64 ? Buffer.from(frame.audioB64, "base64") : undefined,
          frame.audioMime ?? "audio/ogg",
          this.options.transcriber,
        );
        this.dispatch(observation, chatJid);
      });
      return;
    }
    const observation: Observation = {
      session: this.options.session,
      chatJid,
      messageId: frame.id,
      fromMe: !!frame.fromMe,
      at,
      text: frame.text ?? "",
      ...(frame.quotedId ? { quotedMessageId: frame.quotedId } : {}),
      ...(frame.hasImage ? { imageRef: frame.id } : {}),
    };
    this.dispatch(observation, chatJid);
  }
  private dispatch(observation: Observation, chatJid: string) {
    if (observation.fromMe)
      this.enqueue(() => this.options.onEcho(observation.messageId, chatJid));
    if (this.options.session !== "PRODUCT" || this.verifiedDelivery)
      this.enqueue(() => this.options.onObservation(observation));
    else if (this.buffer.length >= (this.options.controlBufferLimit ?? 1000)) {
      this.overflowed = true;
      this.fail(
        new Error(
          "WhatsApp control buffer overflow; restart and review missed messages",
        ),
      );
    } else this.buffer.push(observation);
  }
  private onSendResult(frame: Frame) {
    const entry = frame.ref ? this.pending.get(frame.ref) : undefined;
    if (!entry || !frame.ref) return;
    clearTimeout(entry.timer);
    this.pending.delete(frame.ref);
    if (frame.outcome === "acked") entry.resolve();
    else if (frame.outcome === "failed_before_transmit")
      entry.reject(new RemoteFailure("Sidecar refused before transmit", false));
    else
      entry.reject(
        new RemoteFailure(
          "WhatsApp delivery uncertain: send outcome unknown",
          true,
        ),
      );
  }
  async deliver(item: Delivery): Promise<void> {
    const jid = bare(item.recipientJid);
    if (
      !this.ready ||
      !this.socket ||
      !jid ||
      this.ownJids.map(bare).includes(jid) ||
      !this.allowed().includes(jid)
    )
      throw new Error("WhatsApp recipient or owner identity is not authorized");
    if (!item.messageId) throw new Error("A persisted message ID is required");
    if (this.pending.has(item.messageId))
      throw new Error("Message ID already in flight");
    const imageB64 = item.qrString
      ? (await QRCode.toBuffer(item.qrString)).toString("base64")
      : undefined;
    const outcome = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(item.messageId);
        reject(
          new RemoteFailure(
            "WhatsApp delivery uncertain: acknowledgement timed out",
            true,
          ),
        );
      }, this.options.ackTimeoutMs ?? 100_000);
      this.pending.set(item.messageId, { resolve, reject, timer });
    });
    this.write({
      t: "send",
      ref: item.messageId,
      id: item.messageId,
      to: jid,
      text: item.text,
      ...(imageB64 ? { imageB64 } : {}),
    } as Omit<Frame, "v">);
    await outcome;
    if (
      this.options.session === "PRODUCT" &&
      this.ready &&
      !this.verifiedDelivery
    ) {
      this.verifiedDelivery = true;
      for (const observation of this.buffer.splice(0))
        this.enqueue(() => this.options.onObservation(observation));
    }
  }
  /** Asks for a linking code for this phone number (digits, international form). */
  requestPairCode(phone: string) {
    this.write({ t: "pair_phone", to: phone });
  }
  sendPasskeyResponse(payload: unknown) {
    this.write({ t: "passkey_response", payload });
  }
  confirmPasskey() {
    this.write({ t: "passkey_confirm" });
  }
  cancelPasskey() {
    this.write({ t: "passkey_cancel" });
  }
  numberOfOwner(): string | undefined {
    return this.ownJids[0] ? numberOf(this.ownJids[0]) : undefined;
  }
}
