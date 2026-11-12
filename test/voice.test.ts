import { describe, expect, it } from "vitest";
import {
  FakeTranscriber,
  MAX_AUDIO_BYTES,
  OpenAITranscriber,
  createTranscriber,
  transcribeVoice,
} from "../src/transcription.js";
import { RuleExtractor } from "../src/extraction.js";
import { loadConfig } from "../src/config.js";
import { harness, ana, now } from "./harness.js";
import type { Observation } from "../src/contracts.js";

const base = {
  session: "MERCHANT" as const,
  chatJid: ana,
  messageId: "v",
  fromMe: true,
  at: now,
};

describe("transcription", () => {
  it("trims the transcript and marks it transcribed", async () => {
    const o = await transcribeVoice(
      base,
      Buffer.from("a"),
      "audio/ogg",
      new FakeTranscriber("  hola  "),
    );
    expect(o).toMatchObject({ text: "hola", voice: "transcribed" });
  });
  it("fails closed on empty transcript, oversize audio and provider errors", async () => {
    const t = new FakeTranscriber("");
    expect(
      await transcribeVoice(base, Buffer.from("a"), "audio/ogg", t),
    ).toMatchObject({ text: "", voice: "failed" });
    const big = new FakeTranscriber("x");
    expect(
      await transcribeVoice(
        base,
        Buffer.alloc(MAX_AUDIO_BYTES + 1),
        "audio/ogg",
        big,
      ),
    ).toMatchObject({ voice: "failed" });
    expect(big.calls).toHaveLength(0);
    expect(
      await transcribeVoice(base, Buffer.from("a"), "audio/ogg", {
        transcribe: async () => {
          throw new Error("down");
        },
      }),
    ).toMatchObject({ voice: "failed" });
  });
  it("the OpenAI provider sends Spanish audio and returns the text", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      audio: {
        transcriptions: {
          create: async (args: Record<string, unknown>) => {
            seen.push(args);
            return { text: " aceite $900 " };
          },
        },
      },
    };
    const t = new OpenAITranscriber({ client: client as never });
    expect(
      await t.transcribe(Buffer.from("abc"), "audio/ogg; codecs=opus"),
    ).toBe("aceite $900");
    expect(seen[0]).toMatchObject({
      language: "es",
      model: "gpt-4o-mini-transcribe",
    });
  });
  it("the provider is chosen by environment and needs a key", () => {
    expect(createTranscriber({})).toBeUndefined();
    expect(
      createTranscriber({ TRANSCRIPTION_PROVIDER: "none" }),
    ).toBeUndefined();
    expect(() =>
      createTranscriber({ TRANSCRIPTION_PROVIDER: "openai" }),
    ).toThrow("OPENAI_API_KEY");
    expect(() => createTranscriber({ TRANSCRIPTION_PROVIDER: "x" })).toThrow();
    expect(
      createTranscriber({
        TRANSCRIPTION_PROVIDER: "openai",
        OPENAI_API_KEY: "k",
      }),
    ).toBeInstanceOf(OpenAITranscriber);
    const env = {
      DATA_DIR: "/tmp/x",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
      PEY_API_KEY: "k",
      PEY_API_KEY_ID: "id",
      PEY_WEBHOOK_SECRET: "whsec_x",
      PUBLIC_BASE_URL: "https://example.test",
      MERCHANT_JID: "5215550000001@s.whatsapp.net",
      PRODUCT_JID: "5215550000009@s.whatsapp.net",
    };
    expect(() =>
      loadConfig({ ...env, TRANSCRIPTION_PROVIDER: "openai" }),
    ).toThrow("OPENAI_API_KEY");
    expect(
      loadConfig({
        ...env,
        TRANSCRIPTION_MODEL: "",
        PRODUCT_SIDECAR_SOCKET: "",
      }).TRANSCRIPTION_PROVIDER,
    ).toBe("none");
  });
});

describe("voice notes in the flow", () => {
  it("a transcribed voice quote followed by the client's yes proposes the charge", async () => {
    const h = harness();
    await h.activate();
    await h.chat(ana, true, "Balatas $800, mano de obra $400. Total $1,200.", {
      voice: "transcribed",
    });
    await h.chat(ana, false, "Va");
    expect(h.sent(/\$1200\.00 MXN/)).toHaveLength(1);
  });
  it("an unreadable voice note asks the merchant to type the price and proposes nothing", async () => {
    const h = harness();
    await h.activate();
    await h.chat(ana, true, "", { voice: "failed" });
    await h.chat(ana, false, "Va");
    expect(h.sent(/No pude transcribir una nota de voz/)).toHaveLength(1);
    expect(h.sent(/¿Le envío/)).toHaveLength(0);
  });
  it("a voice note on the control channel never authorizes anything", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    expect(h.sent(/¿Le envío/)).toHaveLength(1);
    // Even a perfect transcript of «Sí» is not an authorization.
    await h.product("Sí", { voice: "transcribed" });
    expect(h.pey.charges.size).toBe(0);
    expect(h.sent(/notas de voz no autorizan/)).toHaveLength(1);
    await h.product("Sí");
    expect(h.pey.charges.size).toBe(1);
  });
  it("the rule extractor reads a transcript with thousands separators and decimals", async () => {
    const facts = await new RuleExtractor().extract([
      {
        ...base,
        text: "Aceite $1,000.50, filtro $250. Total $1,250.50",
      } as Observation,
      { ...base, messageId: "y", fromMe: false, text: "Va 👍" },
    ]);
    expect(facts).toMatchObject({
      agreed: true,
      totalText: "1250.50",
      ambiguities: [],
    });
    expect(facts.lines.map((l) => l.amountText)).toEqual(["1000.50", "250"]);
  });
});
