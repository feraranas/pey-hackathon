import { z } from "zod";
import { Webhook } from "standardwebhooks";
import {
  parsePesos,
  RemoteFailure,
  type AccountInput,
  type PeyPort,
  type ProviderEvent,
  type QrRequest,
  type Transaction,
} from "./contracts.js";

const nonempty = z.string().min(1);
const status = z.enum(["PENDING", "PROCESSING", "ACTIVE", "ERROR"]);
const accountInput = z
  .object({
    alias: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    clabe: z.string().regex(/^\d{18}$/),
    entity: z.enum(["PERSON", "BUSINESS"]),
  })
  .strict();
const accountResponse = accountInput
  .extend({ id: nonempty, codiStatus: status })
  .strip();
const qrInput = z
  .object({
    intentId: z.string().min(1).max(500),
    workOrderId: z.string().min(1).max(500),
    revision: z.number().int().nonnegative().safe(),
    amountCents: z.number().int().positive().safe(),
    concept: nonempty,
    expiration: z.number().int().min(360).safe(),
    numRef: z.string().regex(/^\d{1,7}$/),
    bankAccountId: nonempty,
  })
  .strict();
const transaction = z.object({
  id: nonempty,
  status: z.enum(["PENDING", "PAID"]),
  currency: nonempty,
  amount: z.number().nonnegative().finite(),
  amountBreakdown: z.object({ base: z.number().nonnegative().finite() }),
  paymentMethod: nonempty,
  payableType: nonempty,
  payableId: nonempty,
  metadata: z
    .object({
      clabe: z
        .string()
        .regex(/^\d{18}$/)
        .optional(),
    })
    .nullable()
    .optional(),
  datePaid: z.number().int().nonnegative().safe().nullable().optional(),
});
const event = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("codi.qr.payment_received"),
    transactionId: nonempty,
    codiQrId: nonempty,
    bankAccountId: nonempty.optional(),
    apiKeyId: nonempty,
  }),
  z.object({
    type: z.literal("bank.account.updated"),
    bankAccountId: nonempty,
  }),
]);

function toTransaction(value: z.infer<typeof transaction>): Transaction {
  return {
    id: value.id,
    status: value.status,
    currency: value.currency,
    amountCents: parsePesos(value.amount),
    baseCents: parsePesos(value.amountBreakdown.base),
    paymentMethod: value.paymentMethod,
    payableType: value.payableType,
    payableId: value.payableId,
    ...(value.metadata?.clabe ? { receiverClabe: value.metadata.clabe } : {}),
    ...(value.datePaid != null ? { datePaid: value.datePaid } : {}),
  };
}

export type PeyClientOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Permits plain HTTP, only to a loopback host: the local sandbox. */
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
export class PeyClient implements PeyPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(options: PeyClientOptions) {
    this.apiKey = nonempty.parse(options.apiKey);
    const url = new URL(options.baseUrl ?? "https://api.pey.mx");
    const loopbackHttp =
      options.allowLoopbackHttp === true &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Pey base URL");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = z
      .number()
      .int()
      .positive()
      .safe()
      .parse(options.timeoutMs ?? 10000);
    this.fetcher = options.fetch ?? fetch;
  }
  private async request(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.fetcher(`${this.baseUrl}${path}`, {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!response.ok)
        throw new RemoteFailure(
          `Pey request failed (${response.status})`,
          method === "POST" && response.status !== 400,
        );
      return await Promise.race([response.json(), timeout]);
    } catch (error) {
      if (error instanceof RemoteFailure) throw error;
      throw new RemoteFailure(
        "Pey request failed or returned invalid JSON",
        method === "POST",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private parse<T>(
    schema: z.ZodType<T>,
    value: unknown,
    uncertain: boolean,
  ): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new RemoteFailure("Invalid Pey response", uncertain);
    return result.data;
  }
  async registerAccount(input: AccountInput) {
    const data = accountInput.parse(input);
    const result = this.parse(
      z.object({ id: nonempty, codiStatus: status }),
      await this.request("/bank-account", "POST", data),
      true,
    );
    return { id: result.id, status: result.codiStatus };
  }
  async getAccount(id: string) {
    nonempty.parse(id);
    const result = this.parse(
      accountResponse,
      await this.request(`/bank-account/${encodeURIComponent(id)}`, "GET"),
      false,
    );
    if (result.id !== id)
      throw new RemoteFailure("Pey account identity mismatch", false);
    return {
      id: result.id,
      alias: result.alias,
      name: result.name,
      clabe: result.clabe,
      entity: result.entity,
      status: result.codiStatus,
    };
  }
  async createQr(input: QrRequest) {
    const data = qrInput.parse(input);
    const amount = data.amountCents / 100;
    if (parsePesos(amount) !== data.amountCents)
      throw new Error("Invalid MXN amount");
    return this.parse(
      z.object({ id: nonempty, qrString: nonempty }),
      await this.request("/codi/qr", "POST", {
        amount,
        concept: data.concept,
        expiration: data.expiration,
        numRef: data.numRef,
        generateImage: false,
        bankAccountId: data.bankAccountId,
        metadata: {
          chargeIntentId: data.intentId,
          workOrderId: data.workOrderId,
          revision: data.revision,
        },
      }),
      true,
    );
  }
  async getTransaction(id: string): Promise<Transaction> {
    nonempty.parse(id);
    const result = this.parse(
      transaction,
      await this.request(`/transaction/${encodeURIComponent(id)}`, "GET"),
      false,
    );
    if (result.id !== id)
      throw new RemoteFailure("Pey transaction identity mismatch", false);
    try {
      return toTransaction(result);
    } catch {
      throw new RemoteFailure("Invalid Pey transaction amount", false);
    }
  }
  /** Read-only: ids of the payments received through this API key, newest first. */
  async listApiKeyTransactions(nextToken?: string) {
    if (nextToken !== undefined) nonempty.parse(nextToken);
    const query =
      nextToken === undefined ? "" : `?${new URLSearchParams({ nextToken })}`;
    const page = this.parse(
      z.object({
        items: z.array(z.object({ id: nonempty })),
        nextToken: nonempty.nullable().optional(),
      }),
      await this.request(`/transaction/api-key${query}`, "GET"),
      false,
    );
    return {
      ids: page.items.map((item) => item.id),
      ...(page.nextToken ? { nextToken: page.nextToken } : {}),
    };
  }
  async listQrTransactions(id: string, nextToken?: string) {
    nonempty.parse(id);
    if (nextToken !== undefined) nonempty.parse(nextToken);
    const query =
      nextToken === undefined ? "" : `?${new URLSearchParams({ nextToken })}`;
    const page = this.parse(
      z.object({
        items: z.array(z.object({ id: nonempty })),
        nextToken: nonempty.nullable(),
      }),
      await this.request(
        `/transaction/codi/qr/${encodeURIComponent(id)}${query}`,
        "GET",
      ),
      false,
    );
    const transactions = await Promise.all(
      page.items.map((item) => this.getTransaction(item.id)),
    );
    if (transactions.some((item) => item.payableId !== id))
      throw new RemoteFailure("Pey QR identity mismatch", false);
    return {
      transactions,
      ...(page.nextToken ? { nextToken: page.nextToken } : {}),
    };
  }
}

export function verifyPeyWebhook(
  raw: string | Buffer,
  headers: Record<string, string>,
  secret: string,
): ProviderEvent {
  const payload = new Webhook(secret).verify(raw, headers);
  return event.parse(payload);
}
