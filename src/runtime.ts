import { createHash } from "node:crypto";
import type { Logger } from "pino";
import {
  parsePesos,
  RemoteFailure,
  type ExtractorPort,
  type Observation,
  type PeyPort,
  type ProviderEvent,
  type WhatsAppPort,
} from "./contracts.js";
import { Coordinator } from "./coordinator.js";

type ChatState = {
  chat_jid: string;
  due_at: number;
  generation: number;
  processed: number;
  order_id: string | null;
  last_fingerprint: string | null;
};
export class Runtime {
  private running = false;
  private lastAccountPoll = 0;
  private lastReconciliation = 0;
  private extractionUnavailable = false;
  private retryAt = new Map<string, number>();
  constructor(
    readonly coordinator: Coordinator,
    private readonly ports: {
      pey: PeyPort;
      whatsapp: WhatsAppPort;
      extractor: ExtractorPort;
    },
    private readonly options: {
      debounceMs?: number;
      now?: () => number;
      logger?: Logger;
      canDeliver?: () => boolean;
    } = {},
  ) {
    coordinator.db.exec(`
   CREATE TABLE IF NOT EXISTS runtime_messages(chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, payload_enc TEXT NOT NULL, PRIMARY KEY(chat_jid,message_id));
   CREATE TABLE IF NOT EXISTS runtime_chats(chat_jid TEXT PRIMARY KEY, due_at INTEGER NOT NULL, generation INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, order_id TEXT, last_fingerprint TEXT);
  `);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  accept(observation: Observation): "accepted" | "duplicate" | "ignored" {
    return this.coordinator.db.transaction(() => {
      const result = this.coordinator.observe(observation);
      if (result !== "accepted") return result;
      if (observation.session === "PRODUCT") {
        const command = observation.text.trim().match(/^NUEVA\s+(\S+)$/i);
        if (
          command &&
          this.coordinator.db
            .prepare("SELECT jid FROM chats WHERE merchant_id=? AND jid=?")
            .get(this.coordinator.config.merchantId, command[1]!)
        ) {
          this.coordinator.db
            .prepare("DELETE FROM runtime_messages WHERE chat_jid=?")
            .run(command[1]!);
          this.coordinator.db
            .prepare("DELETE FROM runtime_chats WHERE chat_jid=?")
            .run(command[1]!);
        }
        return result;
      }
      const state = this.coordinator.db
        .prepare("SELECT * FROM runtime_chats WHERE chat_jid=?")
        .get(observation.chatJid) as ChatState | undefined;
      if (observation.imageRef && !observation.fromMe) {
        this.coordinator.reportReceipt(
          state?.order_id ?? null,
          observation.imageRef,
          observation.messageId,
        );
        this.coordinator.notifyControl(
          `Comprobante de ${this.coordinator.clientLabel(observation.chatJid)} reportado, pendiente de verificar. No cuenta como pagado hasta que pey lo confirme.`,
          `report:${observation.messageId}`,
        );
      }
      if (!observation.text) return result;
      this.coordinator.suspendPendingForChat(observation.chatJid);
      this.coordinator.db
        .prepare("INSERT INTO runtime_messages VALUES(?,?,?,?)")
        .run(
          observation.chatJid,
          observation.messageId,
          observation.at,
          this.coordinator.store.encrypt(observation),
        );
      this.coordinator.db
        .prepare(
          `INSERT INTO runtime_chats(chat_jid,due_at,generation) VALUES(?,?,1) ON CONFLICT(chat_jid) DO UPDATE SET due_at=excluded.due_at,generation=generation+1`,
        )
        .run(
          observation.chatJid,
          this.now() + (this.options.debounceMs ?? 30_000),
        );
      return result;
    })();
  }
  async step(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.coordinator.tick(this.now());
      await this.processWebhooks();
      await this.pollAccounts();
      await this.reconcileCharges();
      await this.extractDue();
      await this.drainJobs();
    } finally {
      this.running = false;
    }
  }
  async drainJobs(limit = 50): Promise<void> {
    if (this.options.canDeliver && !this.options.canDeliver()) return;
    for (let i = 0; i < limit; i++) {
      const job = this.coordinator.claimJob();
      if (!job) return;
      try {
        switch (job.kind) {
          case "create_qr":
            this.coordinator.completeJob(
              job.id,
              await this.ports.pey.createQr(job.request),
            );
            break;
          case "register_account":
            this.coordinator.completeJob(
              job.id,
              await this.ports.pey.registerAccount(job.input),
            );
            break;
          case "deliver":
            await this.ports.whatsapp.deliver(job.delivery);
            this.coordinator.completeJob(job.id);
            break;
        }
      } catch (error) {
        this.coordinator.failJob(
          job.id,
          error instanceof RemoteFailure ? error.uncertain : true,
        );
        this.options.logger?.warn(
          { jobId: job.id, kind: job.kind },
          "Operación detenida para revisión",
        );
      }
    }
  }
  private async processWebhooks() {
    for (const pending of this.coordinator.pendingWebhooks()) {
      if ((this.retryAt.get(pending.id) ?? 0) > this.now()) continue;
      try {
        const event = pending.event as ProviderEvent;
        if (event.type === "codi.qr.payment_received") {
          const transaction = await this.ports.pey.getTransaction(
            event.transactionId,
          );
          if (transaction.status === "PENDING") {
            this.retryAt.set(pending.id, this.now() + 30_000);
            continue;
          }
          this.coordinator.db.transaction(() => {
            this.coordinator.payment({
              webhookId: pending.id,
              event,
              transaction,
            });
            this.coordinator.completeWebhook(pending.id);
          })();
        } else {
          const owned = this.coordinator
            .listAccounts()
            .find((a) => a.providerId === event.bankAccountId);
          if (owned) await this.refreshAccount(owned);
          this.coordinator.completeWebhook(pending.id);
        }
        this.retryAt.delete(pending.id);
      } catch {
        this.retryAt.set(pending.id, this.now() + 30_000);
        this.options.logger?.warn(
          { webhookId: pending.id },
          "Consulta de verificación pendiente",
        );
      }
    }
  }
  private async refreshAccount(
    account: ReturnType<Coordinator["listAccounts"]>[number],
  ) {
    if (!account.providerId) return;
    const remote = await this.ports.pey.getAccount(account.providerId);
    if (
      remote.id !== account.providerId ||
      remote.clabe !== account.input.clabe ||
      remote.entity !== account.input.entity
    ) {
      this.coordinator.updateAccount(account.id, "ERROR");
      this.coordinator.notifyControl(
        "La cuenta no coincide con el registro autorizado. Cobros bloqueados.",
        `account-mismatch:${account.id}`,
      );
      return;
    }
    this.coordinator.updateAccount(account.id, remote.status);
    if (remote.status !== account.status)
      this.coordinator.notifyControl(
        `Estado de cuenta ${remote.status}. ${remote.status === "ACTIVE" ? "Ya puedes cobrar: cuando acuerdes un precio con un cliente de tu lista, te pregunto aquí si le envío el cobro." : remote.status === "ERROR" ? "El registro requiere revisión." : "La activación puede tardar hasta cinco días hábiles."}`,
        `account-status:${account.id}:${remote.status}`,
      );
  }
  private async pollAccounts() {
    if (this.lastAccountPoll && this.now() - this.lastAccountPoll < 60_000)
      return;
    this.lastAccountPoll = this.now();
    for (const account of this.coordinator
      .listAccounts()
      .filter((a) => a.providerId)) {
      try {
        await this.refreshAccount(account);
      } catch {
        this.options.logger?.warn(
          { accountId: account.id },
          "Consulta de cuenta pendiente",
        );
      }
    }
  }
  private async reconcileCharges() {
    if (
      this.lastReconciliation &&
      this.now() - this.lastReconciliation < 60_000
    )
      return;
    this.lastReconciliation = this.now();
    const charges = this.coordinator.db
      .prepare(
        `SELECT c.qr_id,i.code,i.id,i.expires_at FROM charges c JOIN intents i ON i.id=c.intent_id WHERE c.qr_id IS NOT NULL AND i.expires_at>?`,
      )
      .all(this.now() - 7 * 86400000) as {
      qr_id: string;
      code: string;
      id: string;
      expires_at: number;
    }[];
    for (const charge of charges) {
      try {
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await this.ports.pey.listQrTransactions(
            charge.qr_id,
            token,
          );
          for (const tx of page.transactions) {
            if (
              tx.status !== "PAID" ||
              this.coordinator.db
                .prepare(
                  "SELECT transaction_id FROM receipts WHERE transaction_id=?",
                )
                .get(tx.id)
            )
              continue;
            this.coordinator.db
              .prepare("INSERT OR IGNORE INTO reviews VALUES(?,?,?,?)")
              .run(
                `missing-webhook:${tx.id}`,
                "AWAITING_SIGNED_WEBHOOK",
                charge.id,
                "Payment detected by authenticated query; signed webhook required",
              );
            this.coordinator.notifyControl(
              `Hay una transacción pendiente de conciliar para ${charge.code}. Falta confirmar su webhook firmado; todavía no cambia el saldo.`,
              `missing-webhook:${tx.id}`,
            );
          }
          token = page.nextToken;
          if (token && seen.has(token))
            throw new Error("Repeated reconciliation cursor");
          if (token) seen.add(token);
        } while (token);
      } catch {
        this.options.logger?.warn(
          { intentId: charge.id },
          "Conciliación de QR pendiente",
        );
      }
    }
  }
  private async extractDue() {
    if (this.extractionUnavailable) return;
    const chats = this.coordinator.db
      .prepare(
        "SELECT r.* FROM runtime_chats r JOIN chats c ON c.jid=r.chat_jid WHERE c.merchant_id=? AND r.generation>r.processed AND r.due_at<=?",
      )
      .all(this.coordinator.config.merchantId, this.now()) as ChatState[];
    for (const chat of chats) {
      const rows = this.coordinator.db
        .prepare(
          "SELECT payload_enc FROM runtime_messages WHERE chat_jid=? ORDER BY at DESC,rowid DESC LIMIT 40",
        )
        .all(chat.chat_jid) as { payload_enc: string }[];
      const messages = rows
        .reverse()
        .map((row) =>
          this.coordinator.store.decrypt<Observation>(row.payload_enc),
        );
      try {
        const facts = await this.ports.extractor.extract(messages);
        this.coordinator.db.transaction(() => {
          const current = this.coordinator.db
            .prepare("SELECT generation FROM runtime_chats WHERE chat_jid=?")
            .get(chat.chat_jid) as { generation: number };
          if (current.generation !== chat.generation) return;
          this.coordinator.db
            .prepare("UPDATE runtime_chats SET processed=? WHERE chat_jid=?")
            .run(chat.generation, chat.chat_jid);
          if (!facts.agreed && !facts.ambiguities.length) return;
          const accounts = this.coordinator
            .listAccounts()
            .filter((a) => a.status === "ACTIVE" && a.providerId);
          const account = accounts.length === 1 ? accounts[0] : undefined;
          if (
            facts.ambiguities.length ||
            !facts.requestedNowText ||
            !facts.lines.length ||
            !account
          ) {
            const reason = !account
              ? "Primero registra y activa tu cuenta con ALTA."
              : facts.ambiguities.length
                ? "Hay datos ambiguos; confirma importe y desglose en el chat del cliente."
                : "Falta el importe del cobro o su desglose.";
            this.coordinator.notifyControl(
              reason,
              `extract:${chat.chat_jid}:${chat.generation}:clarify`,
            );
            return;
          }
          const lines = facts.lines.map((l) => ({
            description: l.description,
            amountCents: parsePesos(l.amountText),
          }));
          const totalCents =
            facts.totalText === null ? null : parsePesos(facts.totalText);
          const amountCents = parsePesos(facts.requestedNowText);
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                lines,
                totalCents,
                amountCents,
                kind: facts.kind,
                accountId: account.id,
              }),
            )
            .digest("hex");
          const superseded = this.coordinator.db
            .prepare(
              "SELECT id FROM intents WHERE id=(SELECT id FROM intents WHERE order_id=? ORDER BY rowid DESC LIMIT 1) AND approval_state='SUPERSEDED'",
            )
            .get(chat.order_id);
          if (fingerprint === chat.last_fingerprint && !superseded) {
            const latest = this.coordinator.db
              .prepare(
                "SELECT code,approval_state,creation_state FROM intents WHERE order_id=? ORDER BY rowid DESC LIMIT 1",
              )
              .get(chat.order_id) as
              | { code: string; approval_state: string; creation_state: string }
              | undefined;
            if (
              latest &&
              (["EXPIRED", "REJECTED"].includes(latest.approval_state) ||
                ["UNCERTAIN", "FAILED"].includes(latest.creation_state))
            )
              this.coordinator.notifyControl(
                `El cobro ${latest.code} requiere una propuesta nueva. Usa REPROPONER ${latest.code} y aprueba el nuevo código.`,
                `extract-terminal:${latest.code}`,
              );
            return;
          }
          let orderId = chat.order_id ?? undefined;
          const order = orderId
            ? this.coordinator.getOrder(orderId)
            : undefined;
          if (
            order &&
            (JSON.stringify(order.lines) !== JSON.stringify(lines) ||
              order.totalCents !== totalCents ||
              order.account_id !== account.id)
          ) {
            this.coordinator.revise(orderId!, {
              lines,
              totalCents,
              accountId: account.id,
            });
          }
          const proposal = this.coordinator.propose({
            chatJid: chat.chat_jid,
            lines,
            totalCents,
            amountCents,
            kind: facts.kind,
            evidence: facts.evidence,
            expiresAt: this.now() + 86_400_000,
            accountId: account.id,
            ...(orderId ? { orderId } : {}),
          });
          this.coordinator.db
            .prepare(
              "UPDATE runtime_chats SET order_id=?,last_fingerprint=? WHERE chat_jid=?",
            )
            .run(proposal.orderId, fingerprint, chat.chat_jid);
        })();
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (["credit_balance_exhausted", "insufficient_quota"].includes(code)) {
          this.extractionUnavailable = true;
          this.coordinator.notifyControl(
            "La extracción con IA no tiene saldo disponible. Usa COBRAR chat | concepto | importe | total. Ningún cobro se envía sin SI código.",
            "extraction-unavailable",
          );
        }
        this.coordinator.db
          .prepare("UPDATE runtime_chats SET due_at=? WHERE chat_jid=?")
          .run(this.now() + 30_000, chat.chat_jid);
        this.options.logger?.warn(
          { chatJid: chat.chat_jid },
          "Extracción pendiente; no se autorizó ningún cobro",
        );
      }
    }
  }
}
