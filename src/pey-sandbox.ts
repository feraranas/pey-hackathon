import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Webhook } from "standardwebhooks";
import { validClabe } from "./clabe.js";

type Account = {
  id: string;
  alias: string;
  name: string;
  clabe: string;
  entity: "PERSON" | "BUSINESS";
  codiStatus: "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";
};
type Qr = { id: string; amount: number; bankAccountId: string };
type Tx = {
  id: string;
  status: "PAID";
  currency: "MXN";
  amount: number;
  amountBreakdown: { base: number };
  paymentMethod: "CODI";
  payableType: "API_CODI_QR";
  payableId: string;
  metadata: { clabe: string };
  datePaid: number;
};

/**
 * A local stand-in for api.pey.mx that speaks the documented wire shapes the
 * app uses, signs webhooks with Standard Webhooks and lets a human or a test
 * activate accounts and pay QRs. It is a sandbox, not Pey: no money moves.
 */
export function createPeySandbox(options: {
  apiKey: string;
  apiKeyId: string;
  webhookUrl?: string;
  webhookSecret: string;
}) {
  const accounts = new Map<string, Account>();
  const qrs = new Map<string, Qr>();
  const transactions = new Map<string, Tx>();
  const webhooks = new Map<string, { body: string }>();
  const app = Fastify();

  async function emit(event: unknown, id: string = randomUUID()) {
    const body = JSON.stringify(event);
    webhooks.set(id, { body });
    return send(id);
  }
  async function send(id: string) {
    const stored = webhooks.get(id);
    if (!stored || !options.webhookUrl) return 0;
    const date = new Date();
    const response = await fetch(options.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
        "webhook-signature": new Webhook(options.webhookSecret).sign(
          id,
          date,
          stored.body,
        ),
      },
      body: stored.body,
    });
    return response.status;
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/__sandbox/")) return;
    if (request.headers.authorization !== `Bearer ${options.apiKey}`)
      return reply.code(401).send({ message: "Unauthorized" });
  });

  app.post("/bank-account", async (request, reply) => {
    const body = request.body as Partial<Account>;
    if (
      !body.alias ||
      !body.name ||
      !body.clabe ||
      !validClabe(body.clabe) ||
      !["PERSON", "BUSINESS"].includes(body.entity ?? "")
    )
      return reply.code(400).send({ message: "Invalid bank account" });
    if ([...accounts.values()].some((a) => a.clabe === body.clabe))
      return reply.code(400).send({ message: "CLABE already registered" });
    const account: Account = {
      id: `sbx-acc-${randomUUID()}`,
      alias: body.alias,
      name: body.name,
      clabe: body.clabe,
      entity: body.entity as Account["entity"],
      codiStatus: "PENDING",
    };
    accounts.set(account.id, account);
    return reply.code(201).send(account);
  });
  app.get("/bank-account/:id", async (request, reply) => {
    const account = accounts.get((request.params as { id: string }).id);
    return account ?? reply.code(404).send({ message: "Not found" });
  });
  app.post("/codi/qr", async (request, reply) => {
    const body = request.body as {
      amount: number;
      bankAccountId: string;
      expiration: number;
    };
    const account = accounts.get(body.bankAccountId);
    if (
      !account ||
      account.codiStatus !== "ACTIVE" ||
      !(body.amount > 0) ||
      !(body.expiration >= 360)
    )
      return reply.code(400).send({ message: "Invalid QR request" });
    const qr: Qr = {
      id: `sbx-qr-${randomUUID()}`,
      amount: body.amount,
      bankAccountId: account.id,
    };
    qrs.set(qr.id, qr);
    return reply
      .code(201)
      .send({ id: qr.id, qrString: `SANDBOX-PEY:NO-ES-UN-COBRO:${qr.id}` });
  });
  app.get("/transaction/:id", async (request, reply) => {
    const tx = transactions.get((request.params as { id: string }).id);
    return tx ?? reply.code(404).send({ message: "Not found" });
  });
  app.get("/transaction/codi/qr/:id", async (request) => {
    const id = (request.params as { id: string }).id;
    return {
      items: [...transactions.values()]
        .filter((t) => t.payableId === id)
        .map((t) => ({ id: t.id })),
      nextToken: null,
    };
  });

  app.post("/__sandbox/accounts/:id/activate", async (request, reply) => {
    const account = accounts.get((request.params as { id: string }).id);
    if (!account) return reply.code(404).send({ message: "Not found" });
    account.codiStatus = "ACTIVE";
    const status = await emit({
      type: "bank.account.updated",
      bankAccountId: account.id,
    });
    return { status: account.codiStatus, webhookStatus: status };
  });
  app.post("/__sandbox/qr/:id/pay", async (request, reply) => {
    const qr = qrs.get((request.params as { id: string }).id);
    if (!qr) return reply.code(404).send({ message: "Not found" });
    const account = accounts.get(qr.bankAccountId)!;
    const tx: Tx = {
      id: `sbx-tx-${randomUUID()}`,
      status: "PAID",
      currency: "MXN",
      amount: qr.amount,
      amountBreakdown: { base: qr.amount },
      paymentMethod: "CODI",
      payableType: "API_CODI_QR",
      payableId: qr.id,
      metadata: { clabe: account.clabe },
      datePaid: Math.floor(Date.now() / 1000),
    };
    transactions.set(tx.id, tx);
    const webhookId = `sbx-wh-${randomUUID()}`;
    const status = await emit(
      {
        type: "codi.qr.payment_received",
        transactionId: tx.id,
        codiQrId: qr.id,
        bankAccountId: account.id,
        apiKeyId: options.apiKeyId,
      },
      webhookId,
    );
    return { transactionId: tx.id, webhookId, webhookStatus: status };
  });
  app.post("/__sandbox/webhooks/:id/resend", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!webhooks.has(id))
      return reply.code(404).send({ message: "Not found" });
    return { webhookStatus: await send(id) };
  });

  return {
    app,
    accounts,
    qrs,
    transactions,
    setWebhookUrl(url: string) {
      options.webhookUrl = url;
    },
  };
}
