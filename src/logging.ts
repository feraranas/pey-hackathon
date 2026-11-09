import pino from "pino";

function scrub(
  value: unknown,
  secrets: string[],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    let cleaned = value
      .replace(/\b\d{18}\b/g, "[CLABE]")
      .replace(/\b(?:whsec_|sk-)[A-Za-z0-9_\-+/=]+/g, "[SECRET]")
      .replace(/Bearer\s+\S+/gi, "Bearer [SECRET]");
    for (const secret of secrets)
      if (secret.length > 3) cleaned = cleaned.split(secret).join("[SECRET]");
    return cleaned;
  }
  if (value instanceof Error)
    return { type: value.name, message: scrub(value.message, secrets) };
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /clabe|token|secret|authorization|raw|body|api.?key|qrString|text|name|alias/i.test(
          key,
        )
          ? "[REDACTED]"
          : scrub(v, secrets, seen),
      ]),
    );
  }
  return value;
}
export function createLogger(
  secrets: string[] = [],
  destination?: pino.DestinationStream,
) {
  const options: pino.LoggerOptions = {
    level: "info",
    redact: [
      "clabe",
      "token",
      "secret",
      "body",
      "raw",
      "req.headers.authorization",
    ],
    hooks: {
      logMethod(args, method) {
        const safe = args.map((v) => scrub(v, secrets));
        method.apply(this, safe as Parameters<typeof method>);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
