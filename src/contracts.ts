export type AccountStatus = "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";
export type AccountInput = {
  alias: string;
  name: string;
  clabe: string;
  entity: "PERSON" | "BUSINESS";
};
export type Account = AccountInput & {
  id: string;
  merchantId: string;
  status: AccountStatus;
};
export type QrRequest = {
  intentId: string;
  workOrderId: string;
  revision: number;
  amountCents: number;
  concept: string;
  expiration: number;
  numRef: string;
  bankAccountId: string;
};
export type QrResult = { id: string; qrString: string };
export type Transaction = {
  id: string;
  status: "PENDING" | "PAID";
  currency: string;
  amountCents: number;
  baseCents: number;
  paymentMethod: string;
  payableType: string;
  payableId: string;
  receiverClabe?: string;
  datePaid?: number;
};
export type PaymentEvent = {
  type: "codi.qr.payment_received";
  transactionId: string;
  codiQrId: string;
  bankAccountId?: string;
  apiKeyId: string;
};
export type AccountEvent = {
  type: "bank.account.updated";
  bankAccountId: string;
};
export type ProviderEvent = PaymentEvent | AccountEvent;
export interface PeyPort {
  registerAccount(
    input: AccountInput,
  ): Promise<{ id: string; status: AccountStatus }>;
  getAccount(
    id: string,
  ): Promise<AccountInput & { id: string; status: AccountStatus }>;
  createQr(input: QrRequest): Promise<QrResult>;
  getTransaction(id: string): Promise<Transaction>;
  listQrTransactions(
    id: string,
    nextToken?: string,
  ): Promise<{ transactions: Transaction[]; nextToken?: string }>;
}
export type Channel = "PRODUCT" | "MERCHANT";
export type Observation = {
  session: Channel;
  chatJid: string;
  messageId: string;
  fromMe: boolean;
  at: number;
  text: string;
  quotedMessageId?: string;
  imageRef?: string;
  /** Set for voice notes. «failed» means there is no text to read. */
  voice?: "transcribed" | "failed";
};
export type Delivery = {
  channel: Channel;
  id: string;
  recipientJid: string;
  messageId: string;
  text: string;
  qrString?: string;
};
export interface WhatsAppPort {
  deliver(item: Delivery): Promise<void>;
}
export type CandidateFacts = {
  agreed: boolean;
  lines: { description: string; amountText: string }[];
  totalText: string | null;
  requestedNowText: string | null;
  kind: "DEPOSIT" | "BALANCE" | "FULL" | "EXTRA";
  ambiguities: string[];
  evidence: string[];
};
export interface ExtractorPort {
  extract(messages: Observation[]): Promise<CandidateFacts>;
}
export function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid integer cents");
  return value;
}
export function parsePesos(value: string | number): number {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("Invalid MXN amount");
  const [whole, fraction = ""] = text.split(".");
  return cents(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}
export function formatPesos(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid cents");
  return `${value < 0 ? "-" : ""}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, "0")}`;
}
export class RemoteFailure extends Error {
  constructor(
    message: string,
    public readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "RemoteFailure";
  }
}
