// Everything the explorer shows to the browser goes through here first.
const BULLETS = "•";

export function maskDigits(value: string, keep = 4) {
  return `${BULLETS.repeat(Math.max(0, value.length - keep))}${value.slice(-keep)}`;
}

const SECRET_KEYS =
  /^(authorization|api[-_]?key|secret|token|password|webhook-signature)$/i;
const PHONE_KEYS = /^(phone|phoneNumber)$/i;

export function createRedactor(secrets: Array<string | undefined>) {
  const literals = secrets
    .filter((s): s is string => typeof s === "string" && s.length >= 6)
    .sort((a, b) => b.length - a.length);
  const text = (input: string) => {
    let out = input;
    for (const literal of literals) out = out.split(literal).join("[secreto]");
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [secreto]");
    out = out.replace(/whsec_[A-Za-z0-9+/=_-]+/g, "whsec_[secreto]");
    // Any 18-digit run is a CLABE: keep the last four digits.
    out = out.replace(/(?<!\d)\d{18}(?!\d)/g, (m) => maskDigits(m));
    return out;
  };
  /** Redacts a JSON-like value; long base64 blobs are summarised. */
  const value = (input: unknown, key = ""): unknown => {
    if (typeof input === "string") {
      if (SECRET_KEYS.test(key)) return "[secreto]";
      if (/^clabe$/i.test(key) && /^\d{10,}$/.test(input))
        return maskDigits(input);
      if (PHONE_KEYS.test(key) && /^\d{10}$/.test(input))
        return maskDigits(input);
      if (/^taxId$/i.test(key) && input.length > 3)
        return `${input.slice(0, 3)}${BULLETS.repeat(input.length - 3)}`;
      if (/^qrImage$/i.test(key) && input.length > 200)
        return `[imagen PNG en base64, ${input.length} caracteres]`;
      return text(input);
    }
    if (Array.isArray(input)) return input.map((item) => value(item, key));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, value(v, k)]),
      );
    return input;
  };
  return { text, value };
}
export type Redactor = ReturnType<typeof createRedactor>;
