import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import QRCode from "qrcode";
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
type Qr = {
  id: string;
  amount: number;
  bankAccountId: string;
  concept?: string;
  numRef?: string;
};
type Link = {
  id: string;
  amount: number;
  status: "pending" | "processing" | "paid";
  successUrl: string;
  backUrl: string;
  hasTip: boolean;
  clientReferenceId?: string;
  dateCreated: number;
};
type Tx = {
  id: string;
  status: "PAID";
  currency: "MXN";
  amount: number;
  amountBreakdown: { base: number };
  paymentMethod: "CODI";
  payableType: "API_CODI_QR" | "API_CODI_PN" | "PAYMENT_LINK";
  payableId: string;
  metadata: { clabe: string };
  datePaid: number;
  bankAccountId?: string;
};
const PAGE_SIZES = { all: 80, qr: 20 };
function page<T>(items: T[], size: number, token?: string) {
  const start = token ? Number(Buffer.from(token, "base64url").toString()) : 0;
  if (!Number.isInteger(start) || start < 0) return undefined;
  const next = start + size < items.length ? start + size : null;
  return {
    items: items.slice(start, start + size),
    nextToken:
      next === null ? null : Buffer.from(String(next)).toString("base64url"),
  };
}

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
  const links = new Map<string, Link>();
  const pushes = new Map<
    string,
    { id: string; amount: number; bankAccountId?: string; concept?: string }
  >();
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
      bankAccountId?: string;
      expiration?: number;
      concept?: string;
      numRef?: string;
      generateImage?: boolean;
    };
    // As in pey, omitting bankAccountId uses the key's default account.
    const account = body.bankAccountId
      ? accounts.get(body.bankAccountId)
      : [...accounts.values()].find((a) => a.codiStatus === "ACTIVE");
    if (
      !account ||
      account.codiStatus !== "ACTIVE" ||
      !(body.amount >= 0) ||
      !(
        body.expiration === undefined ||
        body.expiration === 0 ||
        body.expiration >= 360
      )
    )
      return reply.code(400).send({ message: "Invalid QR request" });
    const qr: Qr = {
      id: `sbx-qr-${randomUUID()}`,
      amount: body.amount,
      bankAccountId: account.id,
      ...(body.concept ? { concept: body.concept } : {}),
      ...(body.numRef ? { numRef: body.numRef } : {}),
    };
    qrs.set(qr.id, qr);
    const qrString = `SANDBOX-PEY:NO-ES-UN-COBRO:${qr.id}`;
    return reply.code(201).send({
      id: qr.id,
      qrString,
      ...(body.generateImage
        ? { qrImage: (await QRCode.toBuffer(qrString)).toString("base64") }
        : {}),
    });
  });
  app.get("/transaction/:id", async (request, reply) => {
    const tx = transactions.get((request.params as { id: string }).id);
    return tx ?? reply.code(404).send({ message: "Not found" });
  });
  app.get("/transaction/codi/qr/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!qrs.has(id)) return reply.code(404).send({ message: "Not found" });
    const result = page(
      [...transactions.values()].filter((t) => t.payableId === id),
      PAGE_SIZES.qr,
      (request.query as { nextToken?: string }).nextToken,
    );
    return result ?? reply.code(400).send({ message: "Invalid nextToken" });
  });
  app.get("/transaction/api-key", async (request, reply) => {
    const result = page(
      [...transactions.values()].reverse(),
      PAGE_SIZES.all,
      (request.query as { nextToken?: string }).nextToken,
    );
    return result ?? reply.code(400).send({ message: "Invalid nextToken" });
  });
  app.get("/transaction/bank-account/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!accounts.has(id))
      return reply.code(404).send({ message: "Not found" });
    const result = page(
      [...transactions.values()]
        .filter((t) => t.bankAccountId === id)
        .reverse(),
      PAGE_SIZES.all,
      (request.query as { nextToken?: string }).nextToken,
    );
    return result ?? reply.code(400).send({ message: "Invalid nextToken" });
  });
  app.post("/codi/pn", async (request, reply) => {
    const body = request.body as {
      amount: number;
      phoneNumber: string;
      concept?: string;
      bankAccountId?: string;
    };
    if (
      !(body.amount > 0 && body.amount <= 1_000_000) ||
      !/^\d{10}$/.test(body.phoneNumber ?? "") ||
      (body.bankAccountId && !accounts.has(body.bankAccountId))
    )
      return reply.code(400).send({ message: "Invalid push request" });
    const id = `sbx-pn-${randomUUID()}`;
    pushes.set(id, {
      id,
      amount: body.amount,
      ...(body.bankAccountId ? { bankAccountId: body.bankAccountId } : {}),
      ...(body.concept ? { concept: body.concept } : {}),
    });
    return { transactionId: id, codiId: String(Date.now()) };
  });
  app.post("/payment-link/create", async (request, reply) => {
    const body = request.body as Partial<Link>;
    if (
      !(Number(body.amount) > 0) ||
      !String(body.successUrl).startsWith("https://") ||
      !String(body.backUrl).startsWith("https://")
    )
      return reply.code(400).send({ message: "Invalid payment link" });
    const link: Link = {
      id: `sbx-pl-${randomUUID()}`,
      amount: Number(body.amount),
      status: "pending",
      successUrl: String(body.successUrl),
      backUrl: String(body.backUrl),
      hasTip: body.hasTip === true,
      ...(body.clientReferenceId
        ? { clientReferenceId: body.clientReferenceId }
        : {}),
      dateCreated: Math.floor(Date.now() / 1000),
    };
    links.set(link.id, link);
    return {
      id: link.id,
      url: `https://sandbox.invalid/payment-link/${link.id}`,
    };
  });
  app.post("/payment-link/update", async (request, reply) => {
    const body = request.body as { paymentLinkId?: string; amount?: number };
    const link = links.get(body.paymentLinkId ?? "");
    if (!link) return reply.code(404).send({ message: "Not found" });
    if (link.status !== "pending")
      return reply.code(409).send({ message: "Payment link is not pending" });
    if (!(Number(body.amount) > 0))
      return reply.code(400).send({ message: "Invalid amount" });
    link.amount = Number(body.amount);
    return { id: link.id, amount: link.amount };
  });
  app.get("/payment-link/:id", async (request, reply) => {
    const link = links.get((request.params as { id: string }).id);
    if (!link) return reply.code(404).send({ message: "Not found" });
    return {
      ...link,
      paymentMethods: ["CODI", "CARD"],
      transactions: [...transactions.values()]
        .filter((t) => t.payableId === link.id)
        .map((t) => ({
          transactionId: t.id,
          paymentMethod: "CODI",
          datePaid: t.datePaid,
          amount: t.amount,
          amountBreakdown: t.amountBreakdown,
        })),
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
      bankAccountId: account.id,
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
        amount: qr.amount,
        concept: qr.concept ?? "",
        datePaid: tx.datePaid,
        numRef: qr.numRef ?? "0",
        metadata: { clabe: account.clabe },
      },
      webhookId,
    );
    return { transactionId: tx.id, webhookId, webhookStatus: status };
  });
  app.post("/__sandbox/pn/:id/pay", async (request, reply) => {
    const push = pushes.get((request.params as { id: string }).id);
    if (!push) return reply.code(404).send({ message: "Not found" });
    const account =
      accounts.get(push.bankAccountId ?? "") ?? [...accounts.values()][0];
    const tx: Tx = {
      id: push.id,
      status: "PAID",
      currency: "MXN",
      amount: push.amount,
      amountBreakdown: { base: push.amount },
      paymentMethod: "CODI",
      payableType: "API_CODI_PN",
      payableId: push.id,
      metadata: { clabe: account?.clabe ?? "000000000000000000" },
      datePaid: Math.floor(Date.now() / 1000),
      ...(account ? { bankAccountId: account.id } : {}),
    };
    transactions.set(tx.id, tx);
    const status = await emit({
      type: "codi.pn.payment_received",
      transactionId: tx.id,
      apiKeyId: options.apiKeyId,
      ...(account ? { bankAccountId: account.id } : {}),
      amount: push.amount,
      concept: push.concept ?? "",
      datePaid: tx.datePaid,
      numRef: "0",
      metadata: tx.metadata,
    });
    return { transactionId: tx.id, webhookStatus: status };
  });
  app.post("/__sandbox/payment-links/:id/pay", async (request, reply) => {
    const link = links.get((request.params as { id: string }).id);
    if (!link) return reply.code(404).send({ message: "Not found" });
    link.status = "paid";
    const tx: Tx = {
      id: `sbx-tx-${randomUUID()}`,
      status: "PAID",
      currency: "MXN",
      amount: link.amount,
      amountBreakdown: { base: link.amount },
      paymentMethod: "CODI",
      payableType: "PAYMENT_LINK",
      payableId: link.id,
      metadata: { clabe: "000000000000000000" },
      datePaid: Math.floor(Date.now() / 1000),
    };
    transactions.set(tx.id, tx);
    const status = await emit({
      type: "payment_link.status_updated",
      apiKeyId: options.apiKeyId,
      paymentLinkId: link.id,
      status: "paid",
      ...(link.clientReferenceId
        ? { clientReferenceId: link.clientReferenceId }
        : {}),
      transactions: [
        {
          transactionId: tx.id,
          paymentMethod: "CODI",
          datePaid: tx.datePaid,
          amount: tx.amount,
          amountBreakdown: tx.amountBreakdown,
        },
      ],
    });
    return { transactionId: tx.id, webhookStatus: status };
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
    links,
    transactions,
    setWebhookUrl(url: string) {
      options.webhookUrl = url;
    },
    /** Adds an ACTIVE account without a webhook; used to seed demos. */
    seedAccount(input: Omit<Account, "id" | "codiStatus">) {
      const account: Account = {
        ...input,
        id: `sbx-acc-${randomUUID()}`,
        codiStatus: "ACTIVE",
      };
      accounts.set(account.id, account);
      return account;
    },
  };
}
