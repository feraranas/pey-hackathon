import { randomUUID } from "node:crypto";
import type {
  AccountInput,
  AccountStatus,
  Delivery,
  ExtractorPort,
  PeyPort,
  QrRequest,
  Transaction,
  WhatsAppPort,
} from "./contracts.js";

export class SimulatedPey implements PeyPort {
  readonly accounts = new Map<
    string,
    AccountInput & { id: string; status: AccountStatus }
  >();
  readonly charges = new Map<string, QrRequest>();
  readonly transactions = new Map<string, Transaction>();
  async registerAccount(input: AccountInput) {
    const id = `sim-account-${randomUUID()}`;
    this.accounts.set(id, { ...input, id, status: "PENDING" });
    return { id, status: "PENDING" as const };
  }
  async getAccount(id: string) {
    const account = this.accounts.get(id);
    if (!account) throw new Error("Simulated account missing");
    return { ...account };
  }
  async createQr(request: QrRequest) {
    if (this.accounts.get(request.bankAccountId)?.status !== "ACTIVE")
      throw new Error("Simulated account is not active");
    const id = `sim-qr-${randomUUID()}`;
    this.charges.set(id, request);
    return {
      id,
      qrString: `SIMULACION:NO-ES-UN-COBRO:${id}:${request.amountCents}`,
    };
  }
  async getTransaction(id: string) {
    const transaction = this.transactions.get(id);
    if (!transaction) throw new Error("Simulated transaction missing");
    return { ...transaction };
  }
  async listQrTransactions(id: string) {
    return {
      transactions: [...this.transactions.values()].filter(
        (t) => t.payableId === id,
      ),
    };
  }
  pay(qrId: string): Transaction {
    const charge = this.charges.get(qrId);
    if (!charge) throw new Error("Simulated QR missing");
    const account = this.accounts.get(charge.bankAccountId)!;
    const transaction: Transaction = {
      id: `sim-tx-${randomUUID()}`,
      status: "PAID",
      currency: "MXN",
      amountCents: charge.amountCents,
      baseCents: charge.amountCents,
      paymentMethod: "CODI",
      payableType: "API_CODI_QR",
      payableId: qrId,
      receiverClabe: account.clabe,
      datePaid: Math.floor(Date.now() / 1000),
    };
    this.transactions.set(transaction.id, transaction);
    return transaction;
  }
}
export class SimulatedWhatsApp implements WhatsAppPort {
  readonly deliveries: Delivery[] = [];
  constructor(private readonly output?: (text: string) => void) {}
  async deliver(delivery: Delivery) {
    this.deliveries.push({ ...delivery });
    this.output?.(
      `[SIMULACIÓN ${delivery.channel === "PRODUCT" ? "número del producto" : "WhatsApp del comerciante"}] → ${delivery.recipientJid.split("@")[0]}: ${delivery.qrString ? "[QR ficticio] " : ""}${delivery.text}`,
    );
  }
}
export const demoExtractor: ExtractorPort = {
  async extract(messages) {
    const quote = messages.findLast(
      (m) => m.fromMe && m.text.includes("balatas"),
    );
    const agreement = messages.findLast(
      (m) => !m.fromMe && m.text.includes("Va"),
    );
    return {
      agreed: !!quote && !!agreement,
      lines: [
        { description: "balatas", amountText: "800" },
        { description: "mano de obra", amountText: "400" },
      ],
      totalText: "1200",
      requestedNowText: "600",
      kind: "DEPOSIT",
      ambiguities: [],
      evidence: [quote?.messageId, agreement?.messageId].filter(
        (id): id is string => !!id,
      ),
    };
  },
};
