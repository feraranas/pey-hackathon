import Fastify, { LogController } from "fastify";
import type { Logger } from "pino";
import type { ProviderEvent } from "./contracts.js";
import { verifyPeyWebhook } from "./pey.js";

export function createServer(options: {
  secret: string;
  apiKeyId: string;
  saveWebhook: (id: string, event: ProviderEvent) => boolean;
  logger?: Logger;
}) {
  const app = Fastify({
    loggerInstance: options.logger,
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/webhooks/pey", async (request, reply) => {
    let event: ProviderEvent;
    const headers: Record<string, string> = {};
    for (const name of [
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]) {
      const value = request.headers[name];
      if (typeof value !== "string")
        return reply.code(401).send({ error: "Invalid signature headers" });
      headers[name] = value;
    }
    try {
      if (typeof request.body !== "string")
        return reply.code(400).send({ error: "Expected JSON raw body" });
      event = verifyPeyWebhook(request.body, headers, options.secret);
    } catch {
      return reply.code(401).send({ error: "Invalid signed event" });
    }
    if (
      event.type === "codi.qr.payment_received" &&
      event.apiKeyId !== options.apiKeyId
    )
      return reply.code(403).send({ error: "Wrong API key" });
    try {
      options.saveWebhook(headers["webhook-id"]!, event);
    } catch {
      options.logger?.error("Webhook persistence failed");
      return reply.code(503).send({ error: "Persistence unavailable" });
    }
    return reply.code(202).send({ accepted: true });
  });
  return app;
}
