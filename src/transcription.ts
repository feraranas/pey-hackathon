import OpenAI, { toFile } from "openai";
import type { Observation } from "./contracts.js";

/** Turns a voice note into text. The audio never leaves memory. */
export interface TranscriberPort {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/** Deterministic transcriber for tests and the local demo. */
export class FakeTranscriber implements TranscriberPort {
  readonly calls: { bytes: number; mimeType: string }[] = [];
  constructor(
    private readonly script: string | ((audio: Buffer) => string) = "",
  ) {}
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    this.calls.push({ bytes: audio.length, mimeType });
    return typeof this.script === "function" ? this.script(audio) : this.script;
  }
}

export class OpenAITranscriber implements TranscriberPort {
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(
    options: { apiKey?: string; model?: string; client?: OpenAI } = {},
  ) {
    this.client =
      options.client ??
      new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: 30_000 });
    this.model = options.model ?? "gpt-4o-mini-transcribe";
  }
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const extension = /ogg|opus/.test(mimeType)
      ? "ogg"
      : /mp4|m4a|aac/.test(mimeType)
        ? "m4a"
        : /mpeg|mp3/.test(mimeType)
          ? "mp3"
          : "ogg";
    const file = await toFile(audio, `voice.${extension}`, {
      type: mimeType.split(";")[0] || "audio/ogg",
    });
    const result = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      language: "es",
      response_format: "json",
    });
    return result.text.trim();
  }
}

/** TRANSCRIPTION_PROVIDER=openai needs OPENAI_API_KEY; the default is none. */
export function createTranscriber(env: {
  TRANSCRIPTION_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  TRANSCRIPTION_MODEL?: string;
}): TranscriberPort | undefined {
  const provider = env.TRANSCRIPTION_PROVIDER ?? "none";
  if (provider === "none") return undefined;
  if (provider !== "openai")
    throw new Error("TRANSCRIPTION_PROVIDER debe ser none u openai");
  if (!env.OPENAI_API_KEY)
    throw new Error("TRANSCRIPTION_PROVIDER=openai requiere OPENAI_API_KEY");
  return new OpenAITranscriber({
    apiKey: env.OPENAI_API_KEY,
    model: env.TRANSCRIPTION_MODEL,
  });
}

/** Voice notes longer than this are not sent to a provider. */
export const MAX_AUDIO_BYTES = 600 * 1024;

/**
 * Builds the text of a voice-note observation. A failure never throws and
 * never invents text: the observation is marked `voice: "failed"` with no text.
 */
export async function transcribeVoice(
  base: Omit<Observation, "text" | "voice">,
  audio: Buffer | undefined,
  mimeType: string,
  transcriber: TranscriberPort | undefined,
): Promise<Observation> {
  if (!audio || !transcriber || audio.length > MAX_AUDIO_BYTES)
    return { ...base, text: "", voice: "failed" };
  try {
    const text = (await transcriber.transcribe(audio, mimeType)).trim();
    return text
      ? { ...base, text, voice: "transcribed" }
      : { ...base, text: "", voice: "failed" };
  } catch {
    return { ...base, text: "", voice: "failed" };
  }
}
