import { createHash, randomBytes, randomUUID, randomInt } from "node:crypto";
import type {
  AccountInput,
  AccountStatus,
  Delivery,
  Observation,
  PaymentEvent,
  QrRequest,
  QrResult,
  Transaction,
} from "./contracts.js";
import { cents, formatPesos, parsePesos } from "./contracts.js";
import { Store } from "./store.js";
import { converse } from "./conversation.js";
import { validClabe } from "./clabe.js";

type Row = Record<string, any>;
type Line = { description: string; amountCents: number };
export type Proposal = {
  chatJid: string;
  lines: Line[];
  totalCents: number | null;
  amountCents: number;
  kind: "DEPOSIT" | "BALANCE" | "FULL" | "EXTRA";
  evidence: string[];
  expiresAt: number;
  accountId: string;
  orderId?: string;
};
export type Command =
  | { kind: "repropose"; code: string; messageId: string }
  | {
      kind: "approve" | "reject";
      code?: string | null;
      quotedPromptId?: string | null;
      clientName?: string | null;
      /** When the merchant sent the message. Plain Sí/No binds only to
       * proposals whose prompt was delivered before this moment. */
      sentAt?: number;
      messageId: string;
    }
  | { kind: "onboarding_data"; input: AccountInput; messageId: string }
  | { kind: "consent"; code: string; messageId: string }
  | { kind: "cash"; orderId: string; amountCents: number; messageId: string }
  | {
      kind: "set_total";
      orderId: string;
      totalCents: number | null;
      messageId: string;
    };
export type Job =
  | { id: string; kind: "create_qr"; request: QrRequest }
  | { id: string; kind: "deliver"; delivery: Delivery }
  | { id: string; kind: "register_account"; input: AccountInput };
const uid = () => randomUUID();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const code = () => randomBytes(4).toString("hex").toUpperCase();
const linesMatch = (lines: Line[], total: number | null) => {
  let sum = 0;
  for (const line of lines) {
    sum += line.amountCents;
    if (!Number.isSafeInteger(sum)) return false;
  }
  return total === null || sum === total;
};
const positive = (v: number) => {
  cents(v);
  if (!v) throw new Error("Amount must be positive");
  return v;
};

export class Coordinator {
  readonly db;
  private now: () => number;
  private pairedAt: number;
  constructor(
    readonly store: Store,
    readonly config: {
      merchantId: string;
      selfJids: string[];
      controlChatJid: string;
      pairedAt: number;
      now?: () => number;
    },
  ) {
    this.db = store.db;
    this.now = config.now ?? Date.now;
    const existing = this.db
      .prepare("SELECT * FROM merchants WHERE id=?")
      .get(config.merchantId) as Row | undefined;
    if (
      existing &&
      (existing.control_jid !== config.controlChatJid ||
        !config.selfJids.includes(config.controlChatJid))
    )
      throw new Error("Merchant identity changed");
    if (existing)
      config.selfJids = [
        ...new Set([
          ...config.selfJids,
          ...(JSON.parse(existing.self_jids) as string[]),
        ]),
      ];
    this.pairedAt = existing?.paired_at ?? config.pairedAt;
    this.db
      .prepare("INSERT OR IGNORE INTO merchants VALUES(?,?,?,?)")
      .run(
        config.merchantId,
        JSON.stringify(config.selfJids),
        config.controlChatJid,
        this.pairedAt,
      );
    this.db
      .prepare("INSERT OR IGNORE INTO cursor VALUES(?,?)")
      .run(config.merchantId, this.pairedAt);
    this.reconcileUncertain();
  }
  private reconcileUncertain(): void {
    this.db.transaction(() => {
      const jobs = this.db
        .prepare("SELECT * FROM jobs WHERE state='UNCERTAIN'")
        .all() as Row[];
      for (const job of jobs) {
        if (job.kind === "register_account") {
          const payload = this.store.decrypt<{ accountId: string }>(
            job.payload_enc,
          );
          this.run(
            "UPDATE accounts SET status='REGISTRATION_UNCERTAIN' WHERE id=? AND status='REGISTERING'",
            payload.accountId,
          );
        }
        this.run(
          "INSERT OR IGNORE INTO reviews VALUES(?,?,?,?)",
          `job:${job.id}`,
          "EFFECT_UNCERTAIN",
          job.intent_id ?? job.id,
          job.kind,
        );
        if (job.kind !== "deliver" || job.intent_id)
          this.notifyControl(
            `Resultado incierto de ${job.kind}; requiere revisión.${job.kind === "create_qr" ? " Usa REPROPONER con el código para solicitar una nueva aprobación." : ""}`,
            `job:${job.id}:recovery`,
          );
      }
    })();
  }
  get(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  private enqueue(
    kind: Job["kind"],
    semantic: string,
    payload: unknown,
    intentId: string | null = null,
    recipient: string | null = null,
    messageId: string | null = null,
  ) {
    const id = uid();
    this.run(
      "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)",
      id,
      kind,
      semantic,
      intentId,
      recipient,
      messageId,
      this.store.encrypt(payload),
      "QUEUED",
    );
    return id;
  }
  private control(text: string, semantic: string, messageId = uid()) {
    this.enqueue(
      "deliver",
      semantic,
      {
        channel: "PRODUCT",
        id: uid(),
        recipientJid: this.config.controlChatJid,
        messageId,
        text: `🤖 Agente de cobros\n${text}`,
      },
      null,
      null,
      messageId,
    );
  }
  bindSelfJids(jids: string[]): void {
    if (
      !jids.includes(this.config.controlChatJid) ||
      jids.some((jid) => !jid || jid.includes("@g.us"))
    )
      throw new Error("Invalid self identity");
    const merged = [...new Set([...this.config.selfJids, ...jids])];
    this.run(
      "UPDATE merchants SET self_jids=? WHERE id=?",
      JSON.stringify(merged),
      this.config.merchantId,
    );
    this.config.selfJids = merged;
  }
  allowChat(jid: string): void {
    if (!jid || jid.includes("@g.us") || jid === this.config.controlChatJid)
      throw new Error("Expected client chat");
    this.run(
      "INSERT OR IGNORE INTO chats VALUES(?,?)",
      this.config.merchantId,
      jid,
    );
  }
  setAllowedChats(jids: string[]): void {
    if (
      jids.some(
        (jid) =>
          !jid || jid.includes("@g.us") || this.config.selfJids.includes(jid),
      )
    )
      throw new Error("Expected client chats");
    this.db.transaction(() => {
      this.run("DELETE FROM chats WHERE merchant_id=?", this.config.merchantId);
      for (const jid of new Set(jids))
        this.run("INSERT INTO chats VALUES(?,?)", this.config.merchantId, jid);
    })();
  }
  suspendPendingForChat(chatJid: string): void {
    this.db.transaction(() => {
      const intents = this.db
        .prepare(
          `SELECT i.* FROM intents i JOIN orders o ON o.id=i.order_id WHERE o.merchant_id=? AND i.recipient=? AND i.approval_state IN ('PROPOSED','APPROVED') AND i.delivery_state<>'DELIVERED'`,
        )
        .all(this.config.merchantId, chatJid) as Row[];
      for (const intent of intents) {
        this.run(
          "UPDATE intents SET approval_state='SUPERSEDED' WHERE id=?",
          intent.id,
        );
        this.run(
          "UPDATE jobs SET state='CANCELLED' WHERE intent_id=? AND state='QUEUED' AND kind IN ('create_qr','deliver')",
          intent.id,
        );
        const inFlight = this.get(
          "SELECT id,kind FROM jobs WHERE intent_id=? AND state IN ('IN_FLIGHT','UNCERTAIN') AND kind IN ('create_qr','deliver')",
          intent.id,
        );
        if (inFlight)
          this.run(
            "INSERT OR IGNORE INTO reviews VALUES(?,?,?,?)",
            `job:${inFlight.id}:superseded`,
            "SUPERSEDED_IN_FLIGHT",
            intent.id,
            inFlight.kind,
          );
      }
    })();
  }
  observe(o: Observation): "accepted" | "duplicate" | "ignored" {
    return this.db.transaction(() => {
      if (
        o.at < this.pairedAt ||
        !o.messageId ||
        this.get("SELECT id FROM jobs WHERE message_id=?", o.messageId)
      )
        return "ignored";
      const merchantChat = this.config.selfJids.includes(o.chatJid);
      const control = o.session === "PRODUCT";
      if (control) {
        if (o.fromMe || !merchantChat) return "ignored";
      } else if (
        merchantChat ||
        !this.get(
          "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
          this.config.merchantId,
          o.chatJid,
        )
      )
        return "ignored";
      const result = this.run(
        "INSERT OR IGNORE INTO events VALUES(?,?,?)",
        o.chatJid,
        o.messageId,
        o.at,
      );
      if (!result.changes) return "duplicate";
      this.run(
        "UPDATE cursor SET last_at=MAX(last_at,?) WHERE merchant_id=?",
        o.at,
        this.config.merchantId,
      );
      if (control) converse(this, o);
      return "accepted";
    })();
  }
  propose(p: Proposal): {
    orderId: string;
    intentId: string;
    code: string;
    promptId: string;
  } {
    positive(p.amountCents);
    if (p.totalCents !== null) positive(p.totalCents);
    if (
      !p.lines.length ||
      p.lines.some(
        (l) =>
          !l.description.trim() ||
          !Number.isSafeInteger(l.amountCents) ||
          l.amountCents < 0,
      ) ||
      !linesMatch(p.lines, p.totalCents) ||
      !Number.isFinite(p.expiresAt) ||
      p.expiresAt <= this.now()
    )
      throw new Error("Invalid proposal");
    if (
      !this.get(
        "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
        this.config.merchantId,
        p.chatJid,
      )
    )
      throw new Error("Chat is not allowed");
    const account = this.get(
      "SELECT * FROM accounts WHERE id=? AND merchant_id=?",
      p.accountId,
      this.config.merchantId,
    );
    if (!account) throw new Error("Account not owned");
    return this.db.transaction(() => {
      let orderId = p.orderId;
      let revision = 1;
      if (orderId) {
        const order = this.get(
          "SELECT * FROM orders WHERE id=? AND merchant_id=?",
          orderId,
          this.config.merchantId,
        );
        if (
          !order ||
          order.chat_jid !== p.chatJid ||
          order.account_id !== p.accountId
        )
          throw new Error("Order mismatch");
        revision = order.revision;
        const version = this.get(
          "SELECT * FROM versions WHERE order_id=? AND revision=?",
          orderId,
          revision,
        )!;
        if (
          version.lines !== JSON.stringify(p.lines) ||
          version.total !== p.totalCents
        )
          throw new Error("Revise order first");
      } else {
        orderId = uid();
        this.run(
          "INSERT INTO orders VALUES(?,?,?,?,?)",
          orderId,
          this.config.merchantId,
          p.chatJid,
          p.accountId,
          revision,
        );
        this.run(
          "INSERT INTO versions VALUES(?,?,?,?)",
          orderId,
          revision,
          JSON.stringify(p.lines),
          p.totalCents,
        );
      }
      const intentId = uid(),
        intentCode = code(),
        promptId = uid();
      const snapshot = JSON.stringify({
        id: intentId,
        code: intentCode,
        orderId,
        revision,
        recipientJid: p.chatJid,
        accountId: p.accountId,
        lines: p.lines,
        totalCents: p.totalCents,
        amountCents: p.amountCents,
        kind: p.kind,
        evidence: p.evidence,
        expiresAt: p.expiresAt,
      });
      this.run(
        "INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        intentId,
        intentCode,
        orderId,
        revision,
        p.chatJid,
        p.accountId,
        snapshot,
        hash(snapshot),
        p.expiresAt,
        "PROPOSED",
        "NONE",
        "NONE",
        "UNPAID",
        promptId,
      );
      const kindLabel = {
        DEPOSIT: "anticipo",
        BALANCE: "saldo",
        FULL: "pago total",
        EXTRA: "cobro adicional",
      }[p.kind];
      this.control(
        `¿Le envío a ${this.clientLabel(p.chatJid)} el cobro de $${formatPesos(p.amountCents)} MXN (${kindLabel})? ${p.lines.map((l) => `${l.description} $${formatPesos(l.amountCents)}`).join(" + ")}${p.totalCents === null ? "" : `. Total $${formatPesos(p.totalCents)}`}. Responde Sí o No.`,
        `prompt:${intentId}`,
        promptId,
      );
      return { orderId, intentId, code: intentCode, promptId };
    })();
  }
  revise(
    orderId: string,
    change: {
      lines: Line[];
      totalCents: number | null;
      chatJid?: string;
      accountId?: string;
    },
  ): number {
    if (change.totalCents !== null) positive(change.totalCents);
    if (
      !change.lines.length ||
      change.lines.some(
        (l) =>
          !l.description.trim() ||
          !Number.isSafeInteger(l.amountCents) ||
          l.amountCents < 0,
      ) ||
      !linesMatch(change.lines, change.totalCents)
    )
      throw new Error("Invalid lines");
    return this.db.transaction(() => {
      const o = this.get(
        "SELECT * FROM orders WHERE id=? AND merchant_id=?",
        orderId,
        this.config.merchantId,
      );
      if (!o) throw new Error("Order not found");
      const chat = change.chatJid ?? o.chat_jid,
        account = change.accountId ?? o.account_id;
      if (
        !this.get(
          "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
          this.config.merchantId,
          chat,
        ) ||
        !this.get(
          "SELECT id FROM accounts WHERE id=? AND merchant_id=?",
          account,
          this.config.merchantId,
        )
      )
        throw new Error("Invalid recipient or account");
      const rev = o.revision + 1;
      this.run(
        "UPDATE orders SET revision=?,chat_jid=?,account_id=? WHERE id=?",
        rev,
        chat,
        account,
        orderId,
      );
      this.run(
        "INSERT INTO versions VALUES(?,?,?,?)",
        orderId,
        rev,
        JSON.stringify(change.lines),
        change.totalCents,
      );
      this.run(
        "UPDATE intents SET approval_state='SUPERSEDED' WHERE order_id=? AND (approval_state='PROPOSED' OR creation_state IN ('NONE','QUEUED'))",
        orderId,
      );
      this.run(
        "UPDATE jobs SET state='CANCELLED' WHERE kind='create_qr' AND state='QUEUED' AND intent_id IN (SELECT id FROM intents WHERE order_id=? AND approval_state='SUPERSEDED')",
        orderId,
      );
      return rev;
    })();
  }
  command(c: Command): "accepted" | "clarification" | "rejected" {
    return this.db.transaction(() => {
      if (c.kind === "onboarding_data") {
        if (
          !validClabe(c.input.clabe) ||
          !c.input.alias.trim() ||
          !c.input.name.trim() ||
          !["PERSON", "BUSINESS"].includes(c.input.entity)
        )
          return "rejected";
        const accounts = this.db
          .prepare("SELECT * FROM accounts WHERE merchant_id=?")
          .all(this.config.merchantId) as Row[];
        if (
          accounts.some(
            (a) =>
              this.store.decrypt<AccountInput>(a.data_enc).clabe ===
                c.input.clabe &&
              [
                "CAPTURING",
                "REGISTERING",
                "REGISTRATION_UNCERTAIN",
                "PENDING",
                "PROCESSING",
                "ACTIVE",
              ].includes(a.status),
          )
        ) {
          this.notifyControl(
            "Esta cuenta ya se registró o su registro requiere revisión.",
            `onboarding-duplicate:${c.messageId}`,
          );
          return "rejected";
        }
        const accountId = uid(),
          consentId = uid(),
          consentCode = code(),
          text = `Declaro ser titular de esta cuenta y autorizo su registro en pey para recibir cobros CoDi. Acepto los términos de pey (v2026-10-13).`;
        this.run(
          "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
          accountId,
          this.config.merchantId,
          this.store.encrypt(c.input),
          "CAPTURING",
          null,
          consentId,
        );
        this.run(
          "INSERT INTO consents VALUES(?,?,?,?,?,?,?,?)",
          consentId,
          this.config.merchantId,
          consentCode,
          text,
          "2026-10-13",
          accountId,
          null,
          null,
        );
        this.control(
          `Confirma tus datos: ${c.input.alias} · ${c.input.name} · CLABE ****${c.input.clabe.slice(-4)} · ${c.input.entity === "PERSON" ? "persona física" : "persona moral"}. ${text} La activación puede tardar hasta cinco días hábiles. Responde «Sí, autorizo» para registrar la cuenta.`,
          `consent:${consentId}`,
        );
        return "accepted";
      }
      if (c.kind === "consent") {
        const consent = this.get(
          "SELECT * FROM consents WHERE code=? AND merchant_id=?",
          c.code,
          this.config.merchantId,
        );
        if (
          !consent ||
          consent.accepted_at !== null ||
          this.get("SELECT id FROM consents WHERE message_id=?", c.messageId)
        )
          return "rejected";
        const account = this.get(
          "SELECT * FROM accounts WHERE id=? AND merchant_id=?",
          consent.account_id,
          this.config.merchantId,
        )!;
        this.run(
          "UPDATE consents SET message_id=?,accepted_at=? WHERE id=?",
          c.messageId,
          this.now(),
          consent.id,
        );
        this.run(
          "UPDATE accounts SET status='REGISTERING' WHERE id=?",
          account.id,
        );
        this.enqueue("register_account", `account:${account.id}:register`, {
          accountId: account.id,
          input: this.store.decrypt<AccountInput>(account.data_enc),
        });
        return "accepted";
      }
      if (c.kind === "repropose") {
        const old = this.get("SELECT * FROM intents WHERE code=?", c.code);
        if (
          !old ||
          (!["UNCERTAIN", "FAILED"].includes(old.creation_state) &&
            !["EXPIRED", "REJECTED"].includes(old.approval_state) &&
            !(
              old.approval_state === "PROPOSED" && old.expires_at <= this.now()
            ))
        ) {
          this.notifyControl(
            "Ese cobro no se puede volver a proponer.",
            `repropose-rejected:${c.messageId}`,
          );
          return "rejected";
        }
        const order = this.get(
          "SELECT * FROM orders WHERE id=? AND merchant_id=?",
          old.order_id,
          this.config.merchantId,
        );
        if (!order || order.revision !== old.revision) {
          this.notifyControl(
            "La orden cambió; crea una propuesta actualizada.",
            `repropose-stale:${c.messageId}`,
          );
          return "rejected";
        }
        if (
          this.get(
            "SELECT id FROM jobs WHERE semantic_key=?",
            `repropose:${old.id}`,
          )
        )
          return "rejected";
        const snapshot = JSON.parse(old.snapshot);
        const p = this.propose({
          orderId: old.order_id,
          chatJid: old.recipient,
          accountId: old.account_id,
          lines: snapshot.lines,
          totalCents: snapshot.totalCents,
          amountCents: snapshot.amountCents,
          kind: snapshot.kind,
          evidence: snapshot.evidence,
          expiresAt: this.now() + 86400000,
        });
        this.notifyControl(
          `Nueva propuesta ${p.code}; requiere una nueva aprobación.${old.creation_state === "UNCERTAIN" ? " El QR anterior podría existir." : ""}`,
          `repropose:${old.id}`,
        );
        return "accepted";
      }
      if (c.kind === "cash") {
        positive(c.amountCents);
        if (
          !this.get(
            "SELECT id FROM orders WHERE id=? AND merchant_id=?",
            c.orderId,
            this.config.merchantId,
          )
        )
          return "rejected";
        const current = this.balance(c.orderId);
        if (
          !Number.isSafeInteger(current.cashCents + c.amountCents) ||
          !Number.isSafeInteger(
            current.cashCents + c.amountCents + current.verifiedCents,
          )
        )
          return "rejected";
        if (
          !this.run(
            "INSERT OR IGNORE INTO cash VALUES(?,?,?,?)",
            uid(),
            c.orderId,
            c.amountCents,
            c.messageId,
          ).changes
        )
          return "rejected";
        const b = this.balance(c.orderId);
        this.notifyControl(
          `Efectivo $${formatPesos(c.amountCents)} registrado por ti. Verificado $${formatPesos(b.verifiedCents)} · efectivo $${formatPesos(b.cashCents)} · falta ${b.pendingCents === null ? "desconocido" : "$" + formatPesos(b.pendingCents)}.`,
          `cash:${c.messageId}`,
        );
        return "accepted";
      }
      if (c.kind === "set_total") {
        const order = this.get(
          "SELECT * FROM orders WHERE id=? AND merchant_id=?",
          c.orderId,
          this.config.merchantId,
        );
        if (!order) return "rejected";
        const version = this.get(
          "SELECT * FROM versions WHERE order_id=? AND revision=?",
          c.orderId,
          order.revision,
        )!;
        const lines = JSON.parse(version.lines) as Line[];
        if (!linesMatch(lines, c.totalCents)) {
          this.notifyControl(
            "El total no coincide con las partidas. Crea una nueva orden con COBRAR.",
            `total-mismatch:${c.messageId}`,
          );
          return "rejected";
        }
        this.revise(c.orderId, { lines, totalCents: c.totalCents });
        return "accepted";
      }
      let i: Row | undefined;
      if (!c.code && !c.quotedPromptId) {
        const everyOpen = this.openProposals();
        const sentAt = c.sentAt ?? this.now();
        const open = everyOpen.filter((p) => {
          const shown = this.promptShownAt(p.id);
          return shown !== undefined && shown <= sentAt;
        });
        const wanted = c.clientName?.trim().toLowerCase();
        const matching = wanted
          ? open.filter((p) =>
              this.clientLabel(p.recipient).toLowerCase().includes(wanted),
            )
          : open;
        if (!open.length) {
          this.notifyControl(
            everyOpen.length
              ? "Tu respuesta llegó antes de que vieras el cobro actual, o el cobro cambió mientras respondías. Revisa la propuesta nueva y responde Sí o No otra vez."
              : "No tengo ningún cobro pendiente de tu aprobación.",
            `no-open:${c.messageId}`,
          );
          return "rejected";
        }
        if (matching.length !== 1) {
          this.control(
            `¿Cuál cobro? ${open.map((p) => `${this.clientLabel(p.recipient)} $${formatPesos(JSON.parse(p.snapshot).amountCents)}`).join(" o ")}. Responde «${c.kind === "reject" ? "No" : "Sí"}, el de ${this.clientLabel(open[0]!.recipient)}» o cita el mensaje del cobro.`,
            `clarify:${c.messageId}`,
          );
          return "clarification";
        }
        i = matching[0];
      } else {
        const byCode = c.code
          ? this.get("SELECT * FROM intents WHERE code=?", c.code)
          : undefined;
        const byQuote = c.quotedPromptId
          ? this.get(
              "SELECT * FROM intents WHERE prompt_id=?",
              c.quotedPromptId,
            )
          : undefined;
        if (
          (c.code && !byCode) ||
          (c.quotedPromptId && !byQuote) ||
          (byCode && byQuote && byCode.id !== byQuote.id)
        )
          return "clarification";
        i = byCode ?? byQuote;
      }
      if (
        !i ||
        i.approval_state !== "PROPOSED" ||
        i.expires_at <= this.now() ||
        hash(i.snapshot) !== i.digest
      ) {
        this.notifyControl(
          "El cobro ya no está vigente o cambió; solicita una nueva propuesta.",
          `approval-rejected:${c.messageId}`,
        );
        return "rejected";
      }
      const order = this.get(
        "SELECT * FROM orders WHERE id=? AND merchant_id=?",
        i.order_id,
        this.config.merchantId,
      );
      if (
        !order ||
        order.revision !== i.revision ||
        !this.get(
          "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
          this.config.merchantId,
          i.recipient,
        )
      ) {
        this.notifyControl(
          "La orden cambió; solicita una nueva propuesta.",
          `approval-stale:${c.messageId}`,
        );
        return "rejected";
      }
      if (c.kind === "reject") {
        this.run(
          "UPDATE intents SET approval_state='REJECTED' WHERE id=?",
          i.id,
        );
        return "accepted";
      }
      const account = this.get(
        "SELECT * FROM accounts WHERE id=? AND merchant_id=? AND status='ACTIVE' AND provider_id IS NOT NULL",
        i.account_id,
        this.config.merchantId,
      );
      if (!account) {
        this.notifyControl(
          "La cuenta receptora todavía no está activa.",
          `approval-account:${c.messageId}`,
        );
        return "rejected";
      }
      if (
        this.get(
          "SELECT intent_id FROM approvals WHERE message_id=?",
          c.messageId,
        )
      )
        return "rejected";
      const snap = JSON.parse(i.snapshot);
      let numRef: string;
      do {
        numRef = String(randomInt(1, 10000000));
      } while (
        this.get("SELECT intent_id FROM charges WHERE num_ref=?", numRef)
      );
      this.run(
        "INSERT INTO approvals VALUES(?,?,?,?)",
        i.id,
        c.messageId,
        i.digest,
        this.now(),
      );
      this.run(
        "UPDATE intents SET approval_state='APPROVED',creation_state='QUEUED' WHERE id=?",
        i.id,
      );
      this.run("INSERT INTO charges VALUES(?,?,?,?)", i.id, numRef, null, null);
      const request: QrRequest = {
        intentId: i.id,
        workOrderId: i.order_id,
        revision: i.revision,
        amountCents: snap.amountCents,
        concept: snap.lines.map((l: Line) => l.description).join(", "),
        expiration: Math.floor((i.expires_at - this.now()) / 1000),
        numRef,
        bankAccountId: account.provider_id,
      };
      this.enqueue(
        "create_qr",
        `intent:${i.id}:create`,
        request,
        i.id,
        i.recipient,
      );
      return "accepted";
    })();
  }
  /** When the prompt for this proposal was acknowledged, if it was. */
  promptShownAt(intentId: string): number | undefined {
    return (
      this.get(
        "SELECT shown_at FROM prompt_seen WHERE intent_id=?",
        intentId,
      ) as { shown_at: number } | undefined
    )?.shown_at;
  }
  private markPromptShown(job: Row): void {
    const m = /^prompt:(.+)$/.exec(job.semantic_key);
    if (m)
      this.run(
        "INSERT OR IGNORE INTO prompt_seen VALUES(?,?)",
        m[1],
        this.now(),
      );
  }
  openProposals(): Row[] {
    return this.db
      .prepare(
        `SELECT i.* FROM intents i JOIN orders o ON o.id=i.order_id WHERE o.merchant_id=? AND i.approval_state='PROPOSED' AND i.expires_at>? ORDER BY i.rowid`,
      )
      .all(this.config.merchantId, this.now()) as Row[];
  }
  clientLabel(jid: string): string {
    const row = this.get(
      "SELECT name FROM clients WHERE merchant_id=? AND jid=?",
      this.config.merchantId,
      jid,
    );
    return row?.name ?? jid.split("@")[0]!;
  }
  addClient(jid: string, name: string): void {
    this.allowChat(jid);
    this.run(
      "INSERT INTO clients VALUES(?,?,?) ON CONFLICT(merchant_id,jid) DO UPDATE SET name=excluded.name",
      this.config.merchantId,
      jid,
      name,
    );
  }
  removeClient(jid: string): void {
    this.suspendPendingForChat(jid);
    this.run(
      "DELETE FROM chats WHERE merchant_id=? AND jid=?",
      this.config.merchantId,
      jid,
    );
    this.run(
      "DELETE FROM clients WHERE merchant_id=? AND jid=?",
      this.config.merchantId,
      jid,
    );
  }
  listClients(): { jid: string; name: string }[] {
    return this.db
      .prepare(
        "SELECT c.jid, COALESCE(k.name, c.jid) AS name FROM chats c LEFT JOIN clients k ON k.merchant_id=c.merchant_id AND k.jid=c.jid WHERE c.merchant_id=?",
      )
      .all(this.config.merchantId) as { jid: string; name: string }[];
  }
  currentTime(): number {
    return this.now();
  }
  notifyControl(text: string, semanticKey: string): void {
    if (!this.get("SELECT id FROM jobs WHERE semantic_key=?", semanticKey))
      this.control(text, semanticKey);
  }
  listAccounts(): Array<{
    id: string;
    merchantId: string;
    status: string;
    providerId: string | null;
    input: AccountInput;
  }> {
    return (
      this.db
        .prepare("SELECT * FROM accounts WHERE merchant_id=?")
        .all(this.config.merchantId) as Row[]
    ).map((a) => ({
      id: a.id,
      merchantId: a.merchant_id,
      status: a.status,
      providerId: a.provider_id,
      input: this.store.decrypt<AccountInput>(a.data_enc),
    }));
  }
  updateAccount(id: string, status: AccountStatus): void {
    this.run(
      "UPDATE accounts SET status=? WHERE merchant_id=? AND (id=? OR provider_id=?)",
      status,
      this.config.merchantId,
      id,
      id,
    );
  }
  getIntent(idOrCode: string): Row | undefined {
    const i = this.get(
      "SELECT * FROM intents WHERE id=? OR code=?",
      idOrCode,
      idOrCode,
    );
    return i ? { ...i, snapshot: JSON.parse(i.snapshot) } : undefined;
  }
  getOrder(id: string): Row | undefined {
    const o = this.get(
      "SELECT * FROM orders WHERE id=? AND merchant_id=?",
      id,
      this.config.merchantId,
    );
    if (!o) return;
    const v = this.get(
      "SELECT * FROM versions WHERE order_id=? AND revision=?",
      id,
      o.revision,
    )!;
    return {
      ...o,
      lines: JSON.parse(v.lines),
      totalCents: v.total,
      balance: this.balance(id),
    };
  }
  balance(orderId: string) {
    const o = this.get(
      "SELECT * FROM orders WHERE id=? AND merchant_id=?",
      orderId,
      this.config.merchantId,
    );
    if (!o) throw new Error("Order not found");
    const v = this.get(
      "SELECT total FROM versions WHERE order_id=? AND revision=?",
      orderId,
      o.revision,
    )!;
    const verified = this.get(
      "SELECT COALESCE(SUM(r.amount),0) AS n FROM receipts r JOIN intents i ON i.id=r.intent_id WHERE i.order_id=?",
      orderId,
    )!.n as number;
    const cash = this.get(
      "SELECT COALESCE(SUM(amount),0) AS n FROM cash WHERE order_id=?",
      orderId,
    )!.n as number;
    const pending = v.total === null ? null : v.total - verified - cash;
    return {
      totalCents: v.total as number | null,
      verifiedCents: verified,
      cashCents: cash,
      pendingCents: pending,
      status:
        pending === null
          ? "UNKNOWN"
          : pending < 0
            ? "OVERPAID"
            : pending === 0
              ? "PAID"
              : verified + cash
                ? "PARTIAL"
                : "DUE",
    };
  }
  reportReceipt(
    orderId: string | null,
    mediaRef: string,
    messageId: string,
  ): void {
    if (
      orderId &&
      !this.get(
        "SELECT id FROM orders WHERE id=? AND merchant_id=?",
        orderId,
        this.config.merchantId,
      )
    )
      throw new Error("Order not found");
    this.run(
      "INSERT OR IGNORE INTO reports VALUES(?,?,?,?)",
      uid(),
      orderId,
      mediaRef,
      messageId,
    );
  }
  saveWebhook(id: string, event: unknown): boolean {
    return !!this.run(
      "INSERT OR IGNORE INTO webhooks VALUES(?,?,'PENDING')",
      id,
      this.store.encrypt(event),
    ).changes;
  }
  pendingWebhooks(): Array<{ id: string; event: any }> {
    return (
      this.db
        .prepare("SELECT * FROM webhooks WHERE state='PENDING'")
        .all() as Row[]
    ).map((w) => ({ id: w.id, event: this.store.decrypt(w.event_enc) }));
  }
  completeWebhook(id: string): void {
    this.run("UPDATE webhooks SET state='DONE' WHERE id=?", id);
  }
  /**
   * Applies a verified transaction. A payment for a QR this app has not
   * recorded yet (the webhook can outrun the QR creation result) is "deferred"
   * until `final` is set, then it goes to review.
   */
  payment(
    p: {
      webhookId: string;
      event: PaymentEvent;
      transaction: Transaction;
    },
    options: { final?: boolean } = {},
  ): "applied" | "duplicate" | "quarantined" | "deferred" {
    const final = options.final ?? true;
    return this.db.transaction(() => {
      const { event: e, transaction: t } = p;
      if (
        this.get(
          "SELECT transaction_id FROM receipts WHERE transaction_id=?",
          t.id,
        )
      )
        return "duplicate";
      const charge = this.get(
        "SELECT * FROM charges WHERE qr_id=?",
        e.codiQrId,
      );
      const i =
        charge &&
        this.get("SELECT * FROM intents WHERE id=?", charge.intent_id);
      const account =
        i &&
        this.get(
          "SELECT * FROM accounts WHERE id=? AND merchant_id=?",
          i.account_id,
          this.config.merchantId,
        );
      const snap = i && JSON.parse(i.snapshot);
      const input =
        account && this.store.decrypt<AccountInput>(account.data_enc);
      if (!final && !i && t.status === "PAID") return "deferred";
      const valid =
        i &&
        account &&
        t.id === e.transactionId &&
        t.payableId === e.codiQrId &&
        t.status === "PAID" &&
        t.currency === "MXN" &&
        t.paymentMethod === "CODI" &&
        t.payableType === "API_CODI_QR" &&
        Number.isSafeInteger(t.baseCents) &&
        t.baseCents === snap.amountCents &&
        (!e.bankAccountId || e.bankAccountId === account.provider_id) &&
        (!t.receiverClabe || t.receiverClabe === input!.clabe);
      if (!valid) {
        this.run(
          "INSERT INTO reviews VALUES(?,?,?,?)",
          uid(),
          "PAYMENT_QUARANTINED",
          e.transactionId,
          "Payment mismatch",
        );
        this.notifyControl(
          `Pago ${e.transactionId} requiere revisión.`,
          `quarantine:${e.transactionId}`,
        );
        return "quarantined";
      }
      const current = this.balance(i.order_id);
      if (
        !Number.isSafeInteger(current.verifiedCents + t.baseCents) ||
        !Number.isSafeInteger(
          current.verifiedCents + t.baseCents + current.cashCents,
        )
      ) {
        this.run(
          "INSERT INTO reviews VALUES(?,?,?,?)",
          uid(),
          "PAYMENT_QUARANTINED",
          e.transactionId,
          "Balance exceeds safe integer",
        );
        return "quarantined";
      }
      const previous = this.get(
        "SELECT transaction_id FROM receipts WHERE intent_id=?",
        i.id,
      );
      const order = this.get("SELECT * FROM orders WHERE id=?", i.order_id)!;
      const flags = [
        ...(previous ? ["REPEATED"] : []),
        ...(order.revision !== i.revision ? ["OLD_VERSION"] : []),
        ...(t.datePaid && t.datePaid * 1000 > i.expires_at ? ["LATE"] : []),
      ];
      this.run(
        "INSERT INTO receipts VALUES(?,?,?,?)",
        t.id,
        i.id,
        t.baseCents,
        JSON.stringify(flags),
      );
      this.run(
        "UPDATE intents SET payment_state=? WHERE id=?",
        flags.length ? "REVIEW" : "PAID",
        i.id,
      );
      if (flags.length)
        this.run(
          "INSERT INTO reviews VALUES(?,?,?,?)",
          uid(),
          "PAYMENT_REVIEW",
          i.id,
          flags.join(","),
        );
      const b = this.balance(i.order_id);
      this.control(
        `Recibiste $${formatPesos(t.baseCents)} de ${this.clientLabel(i.recipient)} (verificado por pey). Verificado $${formatPesos(b.verifiedCents)} · efectivo registrado $${formatPesos(b.cashCents)} · falta ${b.pendingCents === null ? "desconocido" : "$" + formatPesos(b.pendingCents)}.${flags.length ? " Requiere revisión: " + flags.join(", ") : ""}`,
        `payment:${t.id}`,
      );
      return "applied";
    })();
  }
  claimJob(): Job | null {
    return this.db.transaction(() => {
      const row = this.get(
        "SELECT * FROM jobs WHERE state='QUEUED' ORDER BY rowid LIMIT 1",
      );
      if (!row) return null;
      if (row.kind === "create_qr") {
        const intent = this.get(
          "SELECT * FROM intents WHERE id=?",
          row.intent_id,
        );
        const order =
          intent &&
          this.get(
            "SELECT * FROM orders WHERE id=? AND merchant_id=?",
            intent.order_id,
            this.config.merchantId,
          );
        const account =
          intent &&
          this.get(
            "SELECT * FROM accounts WHERE id=? AND merchant_id=? AND status='ACTIVE'",
            intent.account_id,
            this.config.merchantId,
          );
        const ttl = intent
          ? Math.floor((intent.expires_at - this.now()) / 1000)
          : 0;
        if (
          !intent ||
          !order ||
          !account ||
          !this.get(
            "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
            this.config.merchantId,
            intent.recipient,
          ) ||
          order.revision !== intent.revision ||
          intent.approval_state !== "APPROVED" ||
          hash(intent.snapshot) !== intent.digest ||
          ttl < 360
        ) {
          this.run("UPDATE jobs SET state='CANCELLED' WHERE id=?", row.id);
          if (intent)
            this.run(
              "UPDATE intents SET creation_state='FAILED' WHERE id=?",
              intent.id,
            );
          this.notifyControl(
            "El cobro venció o cambió antes de crear el QR; crea una nueva propuesta.",
            `job:${row.id}:cancelled`,
          );
          return null;
        }
        const request = this.store.decrypt<QrRequest>(row.payload_enc);
        request.expiration = ttl;
        this.run(
          "UPDATE jobs SET payload_enc=? WHERE id=?",
          this.store.encrypt(request),
          row.id,
        );
        row.payload_enc = this.store.encrypt(request);
      }
      if (row.kind === "deliver" && row.intent_id) {
        const intent = this.get(
          "SELECT * FROM intents WHERE id=?",
          row.intent_id,
        );
        const order =
          intent &&
          this.get(
            "SELECT * FROM orders WHERE id=? AND merchant_id=?",
            intent.order_id,
            this.config.merchantId,
          );
        const account =
          intent &&
          this.get(
            "SELECT id FROM accounts WHERE id=? AND merchant_id=? AND status='ACTIVE'",
            intent.account_id,
            this.config.merchantId,
          );
        if (
          !intent ||
          !order ||
          !account ||
          !this.get(
            "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
            this.config.merchantId,
            intent.recipient,
          ) ||
          order.revision !== intent.revision ||
          intent.expires_at <= this.now() ||
          intent.approval_state !== "APPROVED"
        ) {
          this.run("UPDATE jobs SET state='CANCELLED' WHERE id=?", row.id);
          if (intent) {
            this.run(
              "UPDATE intents SET delivery_state='REVIEW' WHERE id=?",
              intent.id,
            );
            this.run(
              "INSERT INTO reviews VALUES(?,?,?,?)",
              uid(),
              "DELIVERY_CANCELLED",
              intent.id,
              "Order or account changed before delivery",
            );
          }
          return null;
        }
      }
      this.run(
        "UPDATE jobs SET state='IN_FLIGHT' WHERE id=? AND state='QUEUED'",
        row.id,
      );
      if (row.intent_id && row.kind === "create_qr")
        this.run(
          "UPDATE intents SET creation_state='IN_FLIGHT' WHERE id=?",
          row.intent_id,
        );
      if (row.intent_id && row.kind === "deliver")
        this.run(
          "UPDATE intents SET delivery_state='SENDING' WHERE id=?",
          row.intent_id,
        );
      const payload = this.store.decrypt<any>(row.payload_enc);
      if (row.kind === "create_qr")
        return { id: row.id, kind: "create_qr", request: payload };
      if (row.kind === "register_account")
        return { id: row.id, kind: "register_account", input: payload.input };
      return { id: row.id, kind: "deliver", delivery: payload };
    })() as Job | null;
  }
  completeJob(
    id: string,
    result?: QrResult | { id: string; status: AccountStatus },
  ): void {
    this.db.transaction(() => {
      const job = this.get("SELECT * FROM jobs WHERE id=?", id);
      if (!job || job.state !== "IN_FLIGHT") return;
      const payload = this.store.decrypt<any>(job.payload_enc);
      if (job.kind === "create_qr") {
        if (
          !result ||
          !("qrString" in result) ||
          !result.id ||
          !result.qrString
        )
          throw new Error("Invalid QR result");
        const i = this.get("SELECT * FROM intents WHERE id=?", job.intent_id)!;
        const snap = JSON.parse(i.snapshot);
        this.run(
          "UPDATE charges SET qr_id=?,qr_enc=? WHERE intent_id=?",
          result.id,
          this.store.encrypt(result.qrString),
          i.id,
        );
        const order = this.get(
          "SELECT * FROM orders WHERE id=? AND merchant_id=?",
          i.order_id,
          this.config.merchantId,
        );
        const account = this.get(
          "SELECT id FROM accounts WHERE id=? AND merchant_id=? AND status='ACTIVE'",
          i.account_id,
          this.config.merchantId,
        );
        if (
          !order ||
          !account ||
          !this.get(
            "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
            this.config.merchantId,
            i.recipient,
          ) ||
          order.revision !== i.revision ||
          i.approval_state !== "APPROVED" ||
          i.expires_at <= this.now()
        ) {
          this.run(
            "UPDATE intents SET creation_state='CREATED',delivery_state='REVIEW' WHERE id=?",
            i.id,
          );
          this.run(
            "INSERT INTO reviews VALUES(?,?,?,?)",
            uid(),
            "QR_NOT_DELIVERED",
            i.id,
            "Order or account changed during creation",
          );
          this.notifyControl(
            "El QR se creó pero cambió la orden o cuenta; requiere revisión.",
            `intent:${i.id}:stale`,
          );
          this.run("UPDATE jobs SET state='DONE' WHERE id=?", id);
          return;
        }
        this.run(
          "UPDATE intents SET creation_state='CREATED',delivery_state='RESERVED' WHERE id=?",
          i.id,
        );
        const messageId = uid();
        const delivery: Delivery = {
          channel: "MERCHANT",
          id: uid(),
          recipientJid: i.recipient,
          messageId,
          qrString: result.qrString,
          text: `🤖 Cobro automático\n${snap.kind}: ${snap.lines.map((l: Line) => `${l.description} $${formatPesos(l.amountCents)}`).join(" + ")}. Total ${snap.totalCents === null ? "desconocido" : "$" + formatPesos(snap.totalCents)}. QR $${formatPesos(snap.amountCents)} MXN. Paga desde tu app bancaria con CoDi.`,
        };
        this.enqueue(
          "deliver",
          `intent:${i.id}:qr`,
          delivery,
          i.id,
          i.recipient,
          messageId,
        );
      } else if (job.kind === "register_account") {
        if (!result || !("status" in result))
          throw new Error("Invalid account result");
        this.run(
          "UPDATE accounts SET provider_id=?,status=? WHERE id=? AND merchant_id=?",
          result.id,
          result.status,
          payload.accountId,
          this.config.merchantId,
        );
        this.control(
          "Cuenta registrada en pey. La activación puede tardar hasta cinco días hábiles; te aviso cuando esté activa. Mientras tanto agrega los clientes cuyos chats quieres que lea, por ejemplo «agrega a Ana 5215550000002».",
          `account:${payload.accountId}:registered`,
        );
      } else if (job.intent_id)
        this.run(
          "UPDATE intents SET delivery_state='DELIVERED' WHERE id=?",
          job.intent_id,
        );
      this.run("UPDATE jobs SET state='DONE' WHERE id=?", id);
      if (job.kind === "deliver") this.markPromptShown(job);
    })();
  }
  failJob(id: string, uncertain: boolean): void {
    this.db.transaction(() => {
      const j = this.get("SELECT * FROM jobs WHERE id=?", id);
      if (!j || j.state !== "IN_FLIGHT") return;
      this.run(
        "UPDATE jobs SET state=? WHERE id=?",
        uncertain ? "UNCERTAIN" : "FAILED",
        id,
      );
      if (j.kind === "create_qr")
        this.run(
          "UPDATE intents SET creation_state=? WHERE id=?",
          uncertain ? "UNCERTAIN" : "FAILED",
          j.intent_id,
        );
      if (j.kind === "deliver" && j.intent_id)
        this.run(
          "UPDATE intents SET delivery_state=? WHERE id=?",
          uncertain ? "UNCERTAIN" : "FAILED",
          j.intent_id,
        );
      if (j.kind === "register_account") {
        const payload = this.store.decrypt<{ accountId: string }>(
          j.payload_enc,
        );
        this.run(
          "UPDATE accounts SET status=? WHERE id=?",
          uncertain ? "REGISTRATION_UNCERTAIN" : "ERROR",
          payload.accountId,
        );
      }
      if (uncertain)
        this.run(
          "INSERT OR IGNORE INTO reviews VALUES(?,?,?,?)",
          `job:${id}`,
          "EFFECT_UNCERTAIN",
          j.intent_id ?? id,
          j.kind,
        );
      if (j.kind !== "deliver" || j.intent_id)
        this.notifyControl(
          `No se pudo confirmar ${j.kind}. Requiere revisión.${j.kind === "create_qr" ? " Usa REPROPONER con el código para solicitar una nueva aprobación." : ""}`,
          `job:${id}:failed`,
        );
    })();
  }
  markDeliveryEcho(messageId: string, chatJid: string): void {
    this.db.transaction(() => {
      const j = this.get(
        "SELECT * FROM jobs WHERE message_id=? AND kind='deliver'",
        messageId,
      );
      if (!j) return;
      const delivery = this.store.decrypt<Delivery>(j.payload_enc);
      if (
        delivery.recipientJid !== chatJid &&
        !(
          delivery.recipientJid === this.config.controlChatJid &&
          this.config.selfJids.includes(chatJid)
        )
      )
        return;
      this.run("UPDATE jobs SET state='DONE' WHERE id=?", j.id);
      this.markPromptShown(j);
      if (j.intent_id)
        this.run(
          "UPDATE intents SET delivery_state='DELIVERED' WHERE id=?",
          j.intent_id,
        );
    })();
  }
  tick(now: number): void {
    this.run(
      "UPDATE intents SET approval_state='EXPIRED' WHERE approval_state='PROPOSED' AND expires_at<=?",
      now,
    );
  }
}
