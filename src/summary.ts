import { formatPesos } from "./contracts.js";
import type { Coordinator } from "./coordinator.js";

type Row = Record<string, any>;

const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(ms));

/** Where one charge stands. Only a pey receipt counts as paid. */
export function statusOf(c: Coordinator, i: Row): string {
  if (i.payment_state === "PAID") return "PAID";
  if (i.payment_state === "REVIEW") return "PAID_REVIEW";
  if (i.approval_state === "SUPERSEDED" || i.approval_state === "REJECTED")
    return i.delivery_state === "NONE" ? i.approval_state : "SENT";
  if (i.approval_state === "EXPIRED") return "EXPIRED";
  if (i.approval_state === "PROPOSED") return "AWAITING_YES";
  if (["FAILED", "UNCERTAIN", "REVIEW"].includes(i.delivery_state))
    return "SEND_PROBLEM";
  if (i.delivery_state === "DELIVERED") {
    const reported = c.get(
      "SELECT 1 AS x FROM reports WHERE order_id=? LIMIT 1",
      i.order_id,
    );
    return reported ? "SENT_REPORTED" : "SENT";
  }
  return "TO_SEND";
}

/**
 * The merchant's summary for the local day: what pey confirmed, what is
 * pending, and what was discarded. Receipt photos are shown as reported and
 * never counted as money.
 */
export function buildSummary(
  c: Coordinator,
  options: { now: number; timeZone?: string },
): string | null {
  const timeZone = options.timeZone ?? "America/Mexico_City";
  const today = dayKey(options.now, timeZone);
  const intents = c.db
    .prepare(
      "SELECT i.*, i.rowid AS rowid FROM intents i JOIN orders o ON o.id=i.order_id WHERE o.merchant_id=? ORDER BY i.rowid",
    )
    .all(c.config.merchantId) as Row[];
  const lines: string[] = [];
  const notes: string[] = [];
  const orders = new Set<string>();
  let confirmed = 0;
  for (const i of intents) {
    const shown = c.promptShownAt(i.id);
    const status = statusOf(c, i);
    const open = ["AWAITING_YES", "TO_SEND", "SENT", "SENT_REPORTED"].includes(
      status,
    );
    if (!open && (shown === undefined || dayKey(shown, timeZone) !== today))
      continue;
    if (status === "SUPERSEDED") {
      // A charge replaced by an identical one is not a discarded quote.
      const later = intents.find(
        (j) =>
          j.order_id === i.order_id &&
          j.rowid > i.rowid &&
          JSON.parse(j.snapshot).amountCents ===
            JSON.parse(i.snapshot).amountCents,
      );
      if (later) continue;
    }
    const name = c.clientLabel(i.recipient);
    const amount = JSON.parse(i.snapshot).amountCents as number;
    const money = `$${formatPesos(amount)}`;
    switch (status) {
      case "PAID":
        lines.push(`✅ ${name} · ${money}`);
        break;
      case "PAID_REVIEW":
        lines.push(`⚠️ ${name} · ${money} · pagado, requiere revisión`);
        break;
      case "SENT_REPORTED":
        lines.push(
          `📎 ${name} · ${money} · comprobante reportado, esperando a pey`,
        );
        break;
      case "SENT":
        lines.push(`⏳ ${name} · ${money} · enviado, sin pago confirmado`);
        break;
      case "TO_SEND":
        lines.push(`⏳ ${name} · ${money} · autorizado, por enviar`);
        break;
      case "SEND_PROBLEM":
        lines.push(`⚠️ ${name} · ${money} · el envío requiere revisión`);
        break;
      case "AWAITING_YES":
        lines.push(`❔ ${name} · ${money} · esperando tu Sí`);
        break;
      case "SUPERSEDED":
        notes.push(
          `Cotización anterior de ${name} (${money}): descartada, no se envió`,
        );
        break;
      case "REJECTED":
        notes.push(`Cobro de ${name} (${money}): lo rechazaste, no se envió`);
        break;
      case "EXPIRED":
        notes.push(`Cobro de ${name} (${money}): venció sin enviarse`);
        break;
    }
    if (["PAID", "PAID_REVIEW"].includes(status))
      confirmed += (
        c.get(
          "SELECT COALESCE(SUM(amount),0) AS n FROM receipts WHERE intent_id=?",
          i.id,
        ) as Row
      ).n;
    if (
      ["PAID", "PAID_REVIEW", "SENT", "SENT_REPORTED", "TO_SEND"].includes(
        status,
      )
    )
      orders.add(i.order_id);
  }
  if (!lines.length && !notes.length) return null;
  let pending = 0;
  let cash = 0;
  let unknown = false;
  for (const orderId of orders) {
    const b = c.balance(orderId);
    cash += b.cashCents;
    if (b.pendingCents === null) unknown = true;
    else pending += Math.max(0, b.pendingCents);
  }
  return [
    "*Cobros de hoy*",
    ...lines,
    ...notes,
    `*Confirmado por pey: $${formatPesos(confirmed)}*`,
    ...(cash ? [`Efectivo registrado por ti: $${formatPesos(cash)}`] : []),
    `Pendiente por cobrar: $${formatPesos(pending)}${unknown ? " (hay totales sin definir)" : ""}`,
  ].join("\n");
}
