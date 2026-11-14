import type { FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { randomUUID } from "node:crypto";
import { createPeySandbox } from "../pey-sandbox.js";

/** CLABE de ejemplo con dígito verificador válido (no es una cuenta real). */
export const SANDBOX_CLABE = "002010077777777771";
const SANDBOX_API_KEY = "sandbox-key-no-es-real";

type SandboxTx = {
  id: string;
  status: "PAID";
  currency: "MXN";
  amount: number;
  amountBreakdown: { base: number };
  paymentMethod: "CODI";
  payableType: string;
  payableId: string;
  metadata: { clabe: string };
  datePaid: number;
};
type Link = {
  id: string;
  amount: number;
  status: "pending" | "paid";
  successUrl: string;
  backUrl: string;
  clientReferenceId?: string;
  dateCreated: number;
};

/**
 * Pey de mentira para el servidor MCP. Reutiliza `createPeySandbox` (cuentas,
 * QR y transacciones) y le agrega, solo en este proceso, los endpoints que el
 * MCP necesita y el sandbox base aún no simula: listados de transacciones,
 * notificación push CoDi y links de pago. Si el sandbox ya trae alguno, se
 * respeta el suyo. Ningún dinero se mueve.
 */
export async function startMcpSandbox() {
  const sandbox = createPeySandbox({
    apiKey: SANDBOX_API_KEY,
    apiKeyId: "sandbox-key-id",
    webhookSecret: "whsec_c2FuZGJveC1tY3A=",
  });
  const { app, accounts, transactions } = sandbox;

  // Cuenta activa de ejemplo, para poder cobrar con QR desde el primer minuto.
  const accountId = `sbx-acc-${randomUUID()}`;
  accounts.set(accountId, {
    id: accountId,
    alias: "Cuenta de ejemplo",
    name: "Comercio de Ejemplo SA de CV",
    clabe: SANDBOX_CLABE,
    entity: "BUSINESS",
    codiStatus: "ACTIVE",
  });

  const links = new Map<string, Link>();
  const pushes = new Map<string, { id: string; amount: number }>();
  const txs = () => transactions as unknown as Map<string, SandboxTx>;
  const addRoute = (
    method: HTTPMethods,
    url: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => unknown,
  ) => {
    if (!app.hasRoute({ method, url })) app.route({ method, url, handler });
  };
  const newestFirst = () => [...txs().values()].reverse();

  addRoute("GET", "/transaction/api-key", async () => ({
    items: newestFirst(),
    nextToken: null,
  }));
  addRoute("GET", "/transaction/bank-account/:id", async (request, reply) => {
    const account = accounts.get((request.params as { id: string }).id);
    if (!account) return reply.code(404).send({ message: "Not found" });
    return {
      items: newestFirst().filter((t) => t.metadata.clabe === account.clabe),
      nextToken: null,
    };
  });
  addRoute("POST", "/codi/pn", async (request, reply) => {
    const body = request.body as { amount: number; phoneNumber: string };
    if (
      !(body.amount > 0 && body.amount <= 1_000_000) ||
      !/^\d{10}$/.test(body.phoneNumber ?? "")
    )
      return reply.code(400).send({ message: "Invalid push request" });
    const id = `sbx-pn-${randomUUID()}`;
    pushes.set(id, { id, amount: body.amount });
    return { transactionId: id, codiId: String(Date.now()) };
  });
  addRoute("POST", "/payment-link/create", async (request, reply) => {
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
  addRoute("GET", "/payment-link/:id", async (request, reply) => {
    const link = links.get((request.params as { id: string }).id);
    if (!link) return reply.code(404).send({ message: "Not found" });
    return {
      ...link,
      hasTip: false,
      paymentMethods: ["CODI", "CARD"],
      transactions: [...txs().values()]
        .filter((t) => t.payableId === link.id)
        .map((t) => ({
          transactionId: t.id,
          paymentMethod: t.paymentMethod,
          datePaid: t.datePaid,
          amount: t.amount,
        })),
    };
  });
  const settle = (
    payableType: string,
    payableId: string,
    amount: number,
    id?: string,
  ) => {
    const tx: SandboxTx = {
      id: id ?? `sbx-tx-${randomUUID()}`,
      status: "PAID",
      currency: "MXN",
      amount,
      amountBreakdown: { base: amount },
      paymentMethod: "CODI",
      payableType,
      payableId,
      metadata: { clabe: SANDBOX_CLABE },
      datePaid: Math.floor(Date.now() / 1000),
    };
    txs().set(tx.id, tx);
    return tx;
  };
  addRoute("POST", "/__sandbox/pn/:id/pay", async (request, reply) => {
    const push = pushes.get((request.params as { id: string }).id);
    if (!push) return reply.code(404).send({ message: "Not found" });
    return {
      transactionId: settle("API_CODI_PN", push.id, push.amount, push.id).id,
    };
  });
  addRoute(
    "POST",
    "/__sandbox/payment-links/:id/pay",
    async (request, reply) => {
      const link = links.get((request.params as { id: string }).id);
      if (!link) return reply.code(404).send({ message: "Not found" });
      link.status = "paid";
      return { transactionId: settle("PAYMENT_LINK", link.id, link.amount).id };
    },
  );

  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    url,
    apiKey: SANDBOX_API_KEY,
    accountId,
    close: () => app.close(),
  };
}
