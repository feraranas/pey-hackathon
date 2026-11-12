import { FakeTranscriber } from "../src/transcription.js";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Observation } from "../src/contracts.js";
import { SidecarWhatsApp, type SidecarOptions } from "../src/sidecar.js";

const OWN = "5215550000001@s.whatsapp.net";
const CLIENT = "5215550000002@s.whatsapp.net";
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class FakeSidecar {
  server: Server;
  sockets: Socket[] = [];
  received: Record<string, unknown>[] = [];
  path: string;
  dir = mkdtempSync(join(tmpdir(), "sidecar-"));
  onSend: (frame: Record<string, unknown>, socket: Socket) => void = () => {};
  constructor(
    private readonly hello: Record<string, unknown> = {
      t: "hello",
      protocol: 1,
      version: "fake",
    },
    private readonly status: Record<string, unknown> = {
      t: "status",
      phase: "connected",
      identity: [OWN],
    },
  ) {
    this.path = join(this.dir, "wa.sock");
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const frame = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          this.received.push(frame);
          if (frame.t === "send") this.onSend(frame, socket);
        }
      });
      socket.on("error", () => {});
      this.emit({ v: 1, ...this.hello }, socket);
      this.emit({ v: 1, ...this.status }, socket);
    });
  }
  listen() {
    return new Promise<void>((r) => this.server.listen(this.path, r));
  }
  emit(frame: Record<string, unknown>, socket = this.sockets.at(-1)!) {
    socket.write(`${JSON.stringify({ v: 1, ...frame })}\n`);
  }
  get sends() {
    return this.received.filter((f) => f.t === "send");
  }
  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let fake: FakeSidecar | undefined;
let adapter: SidecarWhatsApp | undefined;
afterEach(async () => {
  adapter?.stop();
  await fake?.close();
  fake = adapter = undefined;
});

async function open(
  session: "PRODUCT" | "MERCHANT",
  overrides: Partial<SidecarOptions> = {},
  sidecar = new FakeSidecar(),
) {
  fake = sidecar;
  await fake.listen();
  const seen: Observation[] = [];
  const echoes: string[] = [];
  const errors: string[] = [];
  adapter = new SidecarWhatsApp({
    session,
    socketPath: fake.path,
    expectedOwnJids: [OWN],
    allowedJids: [CLIENT],
    pairedAt: 1000,
    reconnectDelayMs: 10,
    ackTimeoutMs: 200,
    onObservation: (o) => void seen.push(o),
    onEcho: (id) => void echoes.push(id),
    onError: (e) => void errors.push(String(e)),
    ...overrides,
  });
  await adapter.start();
  await tick();
  return { seen, echoes, errors };
}
const delivery = (id = "M1") => ({
  channel: "MERCHANT" as const,
  id: "d",
  recipientJid: CLIENT,
  messageId: id,
  text: "cobro",
});
const message = (over: Record<string, unknown> = {}) => ({
  t: "message",
  chat: CLIENT,
  id: "in1",
  fromMe: false,
  at: 2000,
  text: "Va",
  ...over,
});

describe("sidecar adapter fails closed", () => {
  it("refuses an incompatible protocol and never sends", async () => {
    const { errors } = await open(
      "MERCHANT",
      {},
      new FakeSidecar({ t: "hello", protocol: 2, version: "future" }),
    );
    expect(adapter!.ready).toBe(false);
    expect(errors.join()).toContain("Incompatible");
    await expect(adapter!.deliver(delivery())).rejects.toThrow(
      "not authorized",
    );
    expect(fake!.sends).toHaveLength(0);
  });
  it("accepts the other Mexican spelling of the configured number", async () => {
    await open(
      "PRODUCT",
      { expectedOwnJids: ["527715697632@s.whatsapp.net"] },
      new FakeSidecar(undefined, {
        t: "status",
        phase: "connected",
        identity: ["5217715697632@s.whatsapp.net"],
      }),
    );
    expect(adapter!.ready).toBe(true);
  });
  it("blocks sends and observations when the linked number is not the configured one", async () => {
    const { seen, errors } = await open(
      "MERCHANT",
      {},
      new FakeSidecar(undefined, {
        t: "status",
        phase: "connected",
        identity: ["5219999999999@s.whatsapp.net"],
      }),
    );
    expect(adapter!.ready).toBe(false);
    expect(errors.join()).toContain("identity does not match");
    fake!.emit(message());
    await tick();
    expect(seen).toEqual([]);
    await expect(adapter!.deliver(delivery())).rejects.toThrow();
  });
  it("closes on an oversized frame", async () => {
    const { errors } = await open("MERCHANT");
    fake!.sockets[0]!.write("a".repeat((1 << 20) + 10));
    await tick(50);
    expect(errors.join()).toContain("too large");
  });
  it("reports queue overflow and stops being ready", async () => {
    const { errors } = await open("MERCHANT");
    expect(adapter!.ready).toBe(true);
    fake!.emit({ t: "overflow" });
    await tick();
    expect(adapter!.ready).toBe(false);
    expect(errors.join()).toContain("overflow");
  });
});

describe("observations", () => {
  it("accepts only picked 1:1 chats after pairing, matching either address, never the owner's own chat", async () => {
    const { seen, echoes } = await open("MERCHANT", {
      allowedJids: () => [CLIENT, "777@lid"],
    });
    fake!.emit(message({ id: "a" }));
    fake!.emit(message({ id: "old", at: 10 }));
    fake!.emit(message({ id: "other", chat: "5215550000009@s.whatsapp.net" }));
    fake!.emit(message({ id: "own", chat: OWN }));
    fake!.emit(
      message({ id: "lid", chat: "777@lid", chatAlt: "x@s.whatsapp.net" }),
    );
    fake!.emit(
      message({ id: "alt", chat: "888@lid", chatAlt: CLIENT, fromMe: true }),
    );
    fake!.emit(message({ id: "empty", text: "" }));
    await tick();
    expect(seen.map((o) => [o.messageId, o.chatJid, o.session])).toEqual([
      ["a", CLIENT, "MERCHANT"],
      ["lid", "777@lid", "MERCHANT"],
      ["alt", CLIENT, "MERCHANT"],
    ]);
    expect(echoes).toEqual(["alt"]);
  });
  it("buffers product commands until a delivery to the merchant is acknowledged", async () => {
    const { seen } = await open("PRODUCT");
    fake!.onSend = (f, s) =>
      fake!.emit({ t: "send_result", ref: f.ref, outcome: "acked" }, s);
    fake!.emit(message({ id: "early" }));
    await tick();
    expect(seen).toEqual([]);
    await adapter!.deliver({ ...delivery("probe"), channel: "PRODUCT" });
    await tick();
    expect(seen.map((o) => o.messageId)).toEqual(["early"]);
  });
});

describe("deliveries", () => {
  it("sends once with the reserved ID and resolves on a server acknowledgement", async () => {
    await open("MERCHANT");
    fake!.onSend = (f, s) =>
      fake!.emit({ t: "send_result", ref: f.ref, outcome: "acked" }, s);
    await adapter!.deliver({ ...delivery("M7"), qrString: "SANDBOX" });
    expect(fake!.sends).toHaveLength(1);
    expect(fake!.sends[0]).toMatchObject({
      id: "M7",
      to: CLIENT,
      text: "cobro",
    });
    expect(typeof fake!.sends[0]!.imageB64).toBe("string");
  });
  it.each([
    ["failed_before_transmit", false],
    ["uncertain", true],
  ])("maps outcome %s to uncertain=%s", async (outcome, uncertain) => {
    await open("MERCHANT");
    fake!.onSend = (f, s) =>
      fake!.emit({ t: "send_result", ref: f.ref, outcome }, s);
    await expect(adapter!.deliver(delivery())).rejects.toMatchObject({
      uncertain,
    });
  });
  it("treats a timeout as uncertain and does not resend after reconnecting", async () => {
    await open("MERCHANT");
    await expect(adapter!.deliver(delivery())).rejects.toMatchObject({
      uncertain: true,
    });
    fake!.sockets[0]!.destroy();
    await tick(60);
    expect(adapter!.ready).toBe(true);
    expect(fake!.sends).toHaveLength(1);
  });
  it("treats a dropped connection with a send in flight as uncertain", async () => {
    await open("MERCHANT", { ackTimeoutMs: 5000 });
    fake!.onSend = (_f, s) => s.destroy();
    await expect(adapter!.deliver(delivery())).rejects.toMatchObject({
      uncertain: true,
    });
  });
  it("refuses recipients that are not picked clients or are the owner", async () => {
    await open("MERCHANT");
    for (const to of ["5215550000009@s.whatsapp.net", OWN])
      await expect(
        adapter!.deliver({ ...delivery(), recipientJid: to }),
      ).rejects.toThrow("not authorized");
    expect(fake!.sends).toHaveLength(0);
  });
});

describe("pairing", () => {
  it("surfaces QR, passkey requests and codes, and forwards the human's answers", async () => {
    const qrs: string[] = [];
    const passkeys: unknown[] = [];
    const codes: string[] = [];
    await open("MERCHANT", {
      onPairingQr: (q) => void qrs.push(q),
      onPasskeyRequest: (p) => void passkeys.push(p),
      onPasskeyCode: (c) => void codes.push(c),
    });
    fake!.emit({ t: "pair_qr", code: "qr" });
    fake!.emit({ t: "passkey_request", payload: { challenge: "c" } });
    fake!.emit({ t: "passkey_code", code: "ABCD-12345" });
    await tick();
    expect([qrs, passkeys, codes]).toEqual([
      ["qr"],
      [{ challenge: "c" }],
      ["ABCD-12345"],
    ]);
    adapter!.sendPasskeyResponse({ id: "x" });
    adapter!.confirmPasskey();
    adapter!.cancelPasskey();
    await tick();
    expect(fake!.received.map((f) => f.t)).toEqual([
      "passkey_response",
      "passkey_confirm",
      "passkey_cancel",
    ]);
  });

  it("asks for a phone linking code and surfaces the answer or the refusal", async () => {
    const codes: string[] = [];
    const errors: string[] = [];
    await open("PRODUCT", {
      onPairCode: (c) => void codes.push(c),
      onPairCodeError: (d) => void errors.push(d),
    });
    adapter!.requestPairCode("5215550000001");
    await tick();
    expect(fake!.received.at(-1)).toMatchObject({
      t: "pair_phone",
      to: "5215550000001",
    });
    fake!.emit({ t: "pair_code", code: "AAAA-BBBB" });
    fake!.emit({ t: "pair_code_error", detail: "not connected" });
    await tick();
    expect(codes).toEqual(["AAAA-BBBB"]);
    expect(errors).toEqual(["not connected"]);
  });

  it("turns a voice note into text through the transcriber, never storing audio", async () => {
    const transcriber = new FakeTranscriber("aceite $900, total $900");
    const { seen } = await open("MERCHANT", { transcriber });
    fake!.emit(
      message({
        id: "v1",
        text: undefined,
        fromMe: true,
        hasAudio: true,
        audioMime: "audio/ogg; codecs=opus",
        audioB64: Buffer.from("opus-bytes").toString("base64"),
      }),
    );
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      messageId: "v1",
      text: "aceite $900, total $900",
      voice: "transcribed",
      fromMe: true,
    });
    expect(transcriber.calls).toEqual([
      { bytes: 10, mimeType: "audio/ogg; codecs=opus" },
    ]);
  });
  it("marks a voice note failed when there is no transcriber, no audio, or the provider throws", async () => {
    const failing = {
      transcribe: async () => {
        throw new Error("provider down SECRET");
      },
    };
    for (const [overrides, frame] of [
      [{}, { audioB64: "AAAA" }],
      [{ transcriber: new FakeTranscriber("x") }, {}],
      [{ transcriber: failing }, { audioB64: "AAAA" }],
    ] as const) {
      const { seen, errors } = await open("MERCHANT", overrides);
      fake!.emit(
        message({ id: "v2", text: undefined, hasAudio: true, ...frame }),
      );
      await tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ text: "", voice: "failed" });
      expect(errors.join()).not.toContain("SECRET");
      await adapter!.stop();
      await fake!.close();
    }
  });
});
