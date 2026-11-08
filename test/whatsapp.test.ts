import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  encryptedAuthState,
  normalizeJid,
  parseObservation,
} from "../src/whatsapp.js";

const opts = {
  ownJids: ["521111:4@s.whatsapp.net", "777@lid"],
  allowedJids: ["522222@s.whatsapp.net"],
  pairedAt: 1000000,
};
const message = (remoteJid: string, fromMe = false, at = 1001) => ({
  key: { remoteJid, fromMe, id: "m1" },
  messageTimestamp: at,
  message: {
    extendedTextMessage: { text: "sí", contextInfo: { stanzaId: "prompt" } },
  },
});

describe("WhatsApp boundary", () => {
  it("normalizes devices and accepts only selected 1:1 and owner control messages", () => {
    expect(normalizeJid("521111:4@s.whatsapp.net")).toBe(
      "521111@s.whatsapp.net",
    );
    expect(
      parseObservation(message("522222@s.whatsapp.net"), opts),
    ).toMatchObject({
      chatJid: "522222@s.whatsapp.net",
      quotedMessageId: "prompt",
      fromMe: false,
    });
    expect(parseObservation(message("777@lid", true), opts)?.chatJid).toBe(
      "777@lid",
    );
    expect(parseObservation(message("777@lid", false), opts)).toBeNull();
    expect(parseObservation(message("522222@g.us"), opts)).toBeNull();
    expect(parseObservation(message("523333@s.whatsapp.net"), opts)).toBeNull();
    expect(
      parseObservation(message("522222@s.whatsapp.net", false, 999), opts),
    ).toBeNull();
    expect(
      parseObservation(message("522222@s.whatsapp.net"), {
        ...opts,
        ownJids: [],
      }),
    ).toBeNull();
  });
  it("persists authentication encrypted and rejects an incorrect key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-auth-"));
    try {
      const path = join(dir, "session");
      const key = Buffer.alloc(32, 7);
      const first = await encryptedAuthState(path, key);
      await first.state.keys.set({
        "lid-mapping": { "private-id": "secret-value" },
      });
      await first.saveCreds();
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from("secret-value"))).toBe(false);
      const restored = await encryptedAuthState(path, key);
      expect(
        await restored.state.keys.get("lid-mapping", ["private-id"]),
      ).toEqual({ "private-id": "secret-value" });
      await expect(
        encryptedAuthState(path, Buffer.alloc(32, 8)),
      ).rejects.toThrow();
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(path, bytes);
      await expect(encryptedAuthState(path, key)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { EventEmitter } from "node:events";
import { BaileysWhatsApp } from "../src/whatsapp.js";
import type { WASocket } from "baileys";

function fakeSocket() {
  const ev = new EventEmitter();
  const calls: { jid: string; id: string }[] = [];
  const socket = {
    ev,
    user: { id: "521111:4@s.whatsapp.net", lid: "777@lid" },
    sendMessage: async (
      jid: string,
      _content: unknown,
      options: { messageId: string },
    ) => {
      calls.push({ jid, id: options.messageId });
      return { key: { id: options.messageId } };
    },
    end: () => {},
  };
  return { socket: socket as unknown as WASocket, ev, calls };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delivery = {
  id: "d1",
  recipientJid: "521111@s.whatsapp.net",
  messageId: "probe",
  text: "Verificando sesión",
};

describe("WhatsApp socket behavior", () => {
  it("buffers offline control events until a matching acknowledgement, then replays them in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-socket-"));
    const fake = fakeSocket();
    const seen: string[] = [];
    const errors: unknown[] = [];
    const adapter = new BaileysWhatsApp({
      authPath: join(dir, "auth"),
      encryptionKey: Buffer.alloc(32, 1),
      allowedJids: opts.allowedJids,
      expectedOwnJids: ["521111@s.whatsapp.net"],
      pairedAt: opts.pairedAt,
      socketFactory: () => fake.socket,
      ackTimeoutMs: 100,
      onObservation: (o) => {
        seen.push(o.messageId);
      },
      onEcho: () => {},
      onError: (e) => {
        errors.push(e);
      },
    });
    try {
      await adapter.start();
      fake.ev.emit("connection.update", { connection: "open" });
      fake.ev.emit("messages.upsert", {
        type: "append",
        messages: [
          message("521111@s.whatsapp.net", true),
          {
            ...message("521111@s.whatsapp.net", true),
            key: { remoteJid: "521111@s.whatsapp.net", fromMe: true, id: "m2" },
          },
        ],
      });
      await tick();
      expect(seen).toEqual([]);
      const sent = adapter.deliver(delivery);
      await tick();
      expect(fake.calls).toEqual([{ jid: delivery.recipientJid, id: "probe" }]);
      fake.ev.emit("messages.update", [
        {
          key: {
            remoteJid: "522222@s.whatsapp.net",
            fromMe: true,
            id: "probe",
          },
          update: { status: 2 },
        },
      ]);
      await tick();
      expect(seen).toEqual([]);
      fake.ev.emit("messages.update", [
        {
          key: { remoteJid: delivery.recipientJid, fromMe: true, id: "probe" },
          update: { status: 2 },
        },
      ]);
      await sent;
      await tick();
      expect(seen).toEqual(["m1", "m2"]);
      expect(errors).toEqual([]);
    } finally {
      adapter.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("treats an unmatched acknowledgement as uncertain and keeps the gate closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-socket-"));
    const fake = fakeSocket();
    const seen: string[] = [];
    const adapter = new BaileysWhatsApp({
      authPath: join(dir, "auth"),
      encryptionKey: Buffer.alloc(32, 1),
      allowedJids: opts.allowedJids,
      expectedOwnJids: ["521111@s.whatsapp.net"],
      pairedAt: opts.pairedAt,
      socketFactory: () => fake.socket,
      ackTimeoutMs: 15,
      onObservation: (o) => {
        seen.push(o.messageId);
      },
      onEcho: () => {},
      onError: () => {},
    });
    try {
      await adapter.start();
      fake.ev.emit("connection.update", { connection: "open" });
      const sent = adapter.deliver(delivery);
      fake.ev.emit("messages.update", [
        {
          key: { remoteJid: delivery.recipientJid, fromMe: true, id: "wrong" },
          update: { status: 2 },
        },
      ]);
      await expect(sent).rejects.toMatchObject({ uncertain: true });
      fake.ev.emit("messages.upsert", {
        type: "append",
        messages: [message(delivery.recipientJid, true)],
      });
      await tick();
      expect(seen).toEqual([]);
    } finally {
      adapter.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("times out even when sendMessage never resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-socket-"));
    const fake = fakeSocket();
    fake.socket.sendMessage = (() =>
      new Promise(() => {})) as WASocket["sendMessage"];
    const adapter = new BaileysWhatsApp({
      authPath: join(dir, "auth"),
      encryptionKey: Buffer.alloc(32, 1),
      allowedJids: opts.allowedJids,
      expectedOwnJids: ["521111@s.whatsapp.net"],
      pairedAt: opts.pairedAt,
      socketFactory: () => fake.socket,
      ackTimeoutMs: 100,
      onObservation: () => {},
      onEcho: () => {},
      onError: () => {},
    });
    try {
      await adapter.start();
      fake.ev.emit("connection.update", { connection: "open" });
      vi.useFakeTimers();
      const sent = adapter.deliver(delivery);
      const rejection = expect(sent).rejects.toMatchObject({ uncertain: true });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
      adapter.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("fails closed and reports buffer overflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-socket-"));
    const fake = fakeSocket();
    const errors: unknown[] = [];
    const seen: string[] = [];
    const adapter = new BaileysWhatsApp({
      authPath: join(dir, "auth"),
      encryptionKey: Buffer.alloc(32, 1),
      allowedJids: opts.allowedJids,
      expectedOwnJids: ["521111@s.whatsapp.net"],
      pairedAt: opts.pairedAt,
      socketFactory: () => fake.socket,
      ackTimeoutMs: 100,
      controlBufferLimit: 1,
      onObservation: (o) => {
        seen.push(o.messageId);
      },
      onEcho: () => {},
      onError: (e) => {
        errors.push(e);
      },
    });
    try {
      await adapter.start();
      fake.ev.emit("connection.update", { connection: "open" });
      fake.ev.emit("messages.upsert", {
        type: "append",
        messages: [
          message(delivery.recipientJid, true),
          message(delivery.recipientJid, true),
        ],
      });
      const sent = adapter.deliver(delivery);
      await tick();
      fake.ev.emit("messages.update", [
        {
          key: { remoteJid: delivery.recipientJid, fromMe: true, id: "probe" },
          update: { status: 2 },
        },
      ]);
      await sent;
      await tick();
      expect(seen).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("overflow");
    } finally {
      adapter.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reconnects after a transient close and stops retrying after stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-socket-"));
    const fake = fakeSocket();
    let attempts = 0;
    const errors: unknown[] = [];
    const adapter = new BaileysWhatsApp({
      authPath: join(dir, "auth"),
      encryptionKey: Buffer.alloc(32, 1),
      allowedJids: opts.allowedJids,
      expectedOwnJids: ["521111@s.whatsapp.net"],
      pairedAt: opts.pairedAt,
      reconnectDelayMs: 5,
      socketFactory: () => {
        attempts++;
        if (attempts === 2) throw new Error("temporary");
        return fake.socket;
      },
      onObservation: () => {},
      onEcho: () => {},
      onError: (e) => {
        errors.push(e);
      },
    });
    try {
      await adapter.start();
      fake.ev.emit("connection.update", { connection: "open" });
      fake.ev.emit("connection.update", { connection: "close" });
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(attempts).toBe(3);
      expect(errors).toHaveLength(1);
      adapter.stop();
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(attempts).toBe(3);
    } finally {
      adapter.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
