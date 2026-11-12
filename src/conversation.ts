import { buildSummary } from "./summary.js";
import type { AccountInput, Observation } from "./contracts.js";
import { formatPesos, parsePesos } from "./contracts.js";
import type { Coordinator } from "./coordinator.js";
import { validClabe } from "./clabe.js";

type Draft = Partial<AccountInput>;
type Step = "ALIAS" | "NAME" | "CLABE" | "ENTITY";
const STEPS: Step[] = ["ALIAS", "NAME", "CLABE", "ENTITY"];

const HELP =
  "Esto puedo hacer por ti: «agrega a Ana 5215550000002» (clientes cuyo chat leo), «quita a Ana», «mis clientes», «cobra 600 a Ana por balatas, total 1200», responder Sí o No a un cobro propuesto, «resumen» de hoy, «estado» de tu cuenta.";
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

function resolveClient(
  c: Coordinator,
  name: string,
): { jid: string } | "none" | "ambiguous" {
  const wanted = fold(name);
  const all = c.listClients();
  const exact = all.filter((x) => fold(x.name) === wanted);
  const hits = exact.length
    ? exact
    : all.filter((x) => fold(x.name).includes(wanted));
  if (hits.length === 1) return { jid: hits[0]!.jid };
  return hits.length ? "ambiguous" : "none";
}

export function toJid(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const full = digits.length === 10 ? `52${digits}` : digits;
  return /^\d{11,15}$/.test(full) ? `${full}@s.whatsapp.net` : null;
}

function onboardingState(c: Coordinator) {
  const row = c.get(
    "SELECT step,data_enc FROM onboarding WHERE merchant_id=?",
    c.config.merchantId,
  );
  return row
    ? { step: row.step as Step, draft: c.store.decrypt<Draft>(row.data_enc) }
    : null;
}
function saveOnboarding(c: Coordinator, step: Step, draft: Draft) {
  c.run(
    "INSERT INTO onboarding VALUES(?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET step=excluded.step,data_enc=excluded.data_enc",
    c.config.merchantId,
    step,
    c.store.encrypt(draft),
  );
}
function clearOnboarding(c: Coordinator) {
  c.run("DELETE FROM onboarding WHERE merchant_id=?", c.config.merchantId);
}

const PROMPTS: Record<Step, string> = {
  ALIAS:
    "¿Con qué alias quieres identificar tu cuenta? Por ejemplo, «Taller Rafa».",
  NAME: "¿Cuál es tu nombre legal completo, tal como aparece en tu cuenta bancaria?",
  CLABE:
    "Escribe tu CLABE de 18 dígitos. Solo se registra tras tu autorización.",
  ENTITY: "¿Eres persona física o persona moral? Responde «física» o «moral».",
};

function onboardingStep(c: Coordinator, o: Observation, text: string): boolean {
  const state = onboardingState(c);
  if (!state) return false;
  const say = (msg: string) => c.notifyControl(msg, `onb:${o.messageId}`);
  const draft = { ...state.draft };
  if (/^(cancelar|reiniciar)$/i.test(text)) {
    clearOnboarding(c);
    say("Alta cancelada. Cuando quieras empezar de nuevo, escríbeme «hola».");
    return true;
  }
  if (state.step === "ALIAS") draft.alias = text.slice(0, 60);
  else if (state.step === "NAME") draft.name = text.slice(0, 120);
  else if (state.step === "CLABE") {
    const clabe = text.replace(/[\s-]/g, "");
    if (!validClabe(clabe)) {
      say(
        "Esa CLABE no es válida; debe tener 18 dígitos y dígito verificador correcto. Inténtalo de nuevo.",
      );
      return true;
    }
    draft.clabe = clabe;
  } else {
    const t = fold(text);
    if (/^fisica$|persona fisica/.test(t)) draft.entity = "PERSON";
    else if (/^moral$|persona moral/.test(t)) draft.entity = "BUSINESS";
    else {
      say("Responde «física» o «moral».");
      return true;
    }
  }
  const next = STEPS[STEPS.indexOf(state.step) + 1];
  if (next) {
    saveOnboarding(c, next, draft);
    say(PROMPTS[next]);
    return true;
  }
  clearOnboarding(c);
  c.command({
    kind: "onboarding_data",
    input: draft as AccountInput,
    messageId: o.messageId,
  });
  return true;
}

function startOnboarding(c: Coordinator, o: Observation): boolean {
  const live = c.listAccounts().some((a) => !["ERROR"].includes(a.status));
  if (live || onboardingState(c)) return false;
  saveOnboarding(c, "ALIAS", {});
  c.notifyControl(
    `¡Hola! Soy el Agente de cobros. Voy a leer solo los chats de clientes que tú elijas y enviaré cobros únicamente cuando tú los autorices aquí. Para registrar tu cuenta de cobro en pey necesito cuatro datos. ${PROMPTS.ALIAS}`,
    `onb-start:${o.messageId}`,
  );
  return true;
}

function pendingConsent(c: Coordinator) {
  return c.get(
    "SELECT code FROM consents WHERE merchant_id=? AND accepted_at IS NULL ORDER BY rowid DESC LIMIT 1",
    c.config.merchantId,
  ) as { code: string } | undefined;
}

export function converse(c: Coordinator, o: Observation): void {
  const text = o.text.trim();
  let m: RegExpMatchArray | null;
  const reply = (msg: string, key = o.messageId) =>
    c.notifyControl(msg, `reply:${key}`);

  if (
    (m = text.match(
      /^(?:s[ií]|no)(?:[,.\s]+(?:el|la)\s+(?:cobro\s+)?de\s+([^\d].*?))?[.!\s]*$/i,
    ))
  ) {
    const negative = /^no/i.test(text);
    if (!negative && pendingConsent(c) && !c.openProposals().length) {
      reply("Para registrar la cuenta responde «Sí, autorizo».");
      return;
    }
    c.command({
      kind: negative ? "reject" : "approve",
      clientName: m[1] ?? null,
      quotedPromptId: o.quotedMessageId,
      sentAt: o.at,
      messageId: o.messageId,
    });
    return;
  }
  if ((m = text.match(/^(?:SI|SÍ|NO)\s+([A-Z0-9]+)$/i))) {
    c.command({
      kind: /^NO/i.test(text) ? "reject" : "approve",
      code: m[1]!.toUpperCase(),
      quotedPromptId: o.quotedMessageId,
      sentAt: o.at,
      messageId: o.messageId,
    });
    return;
  }
  if (
    /^(?:s[ií][,.\s]+)?(?:autorizo|acepto)[.!\s]*$/i.test(text) ||
    (m = text.match(/^ACEPTO\s+([A-Z0-9]+)$/i))
  ) {
    const code = m?.[1]?.toUpperCase() ?? pendingConsent(c)?.code;
    if (!code) reply("No tengo ningún registro pendiente de autorización.");
    else c.command({ kind: "consent", code, messageId: o.messageId });
    return;
  }
  if ((m = text.match(/^REPROPONER\s+([A-Z0-9]+)$/i))) {
    c.command({
      kind: "repropose",
      code: m[1]!.toUpperCase(),
      messageId: o.messageId,
    });
    return;
  }
  if (
    (m = text.match(
      /^ALTA\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(\d{18})\s*\|\s*(PERSON|BUSINESS)$/i,
    ))
  ) {
    clearOnboarding(c);
    c.command({
      kind: "onboarding_data",
      input: {
        alias: m[1]!,
        name: m[2]!,
        clabe: m[3]!,
        entity: m[4]!.toUpperCase() as "PERSON" | "BUSINESS",
      },
      messageId: o.messageId,
    });
    return;
  }
  if (onboardingStep(c, o, text)) return;

  if ((m = text.match(/^EFECTIVO\s+(\S+)\s+(\d+(?:\.\d{1,2})?)$/i))) {
    c.command({
      kind: "cash",
      orderId: m[1]!,
      amountCents: parsePesos(m[2]!),
      messageId: o.messageId,
    });
    return;
  }
  if ((m = text.match(/^TOTAL\s+(\S+)\s+(UNKNOWN|\d+(?:\.\d{1,2})?)$/i))) {
    c.command({
      kind: "set_total",
      orderId: m[1]!,
      totalCents: m[2]!.toUpperCase() === "UNKNOWN" ? null : parsePesos(m[2]!),
      messageId: o.messageId,
    });
    return;
  }
  if ((m = text.match(/^NUEVA\s+(\S+)$/i))) {
    const chat = m[1]!;
    if (
      !c.get(
        "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
        c.config.merchantId,
        chat,
      )
    )
      reply("Ese chat no está permitido.");
    else {
      c.suspendPendingForChat(chat);
      reply(
        `Nueva orden en ${c.clientLabel(chat)}; escribe el nuevo acuerdo en ese chat.`,
      );
    }
    return;
  }
  if (
    (m = text.match(
      /^COBRAR\s+([^|]+)\|\s*([^|]+)\|\s*(\d+(?:\.\d{1,2})?)\s*\|\s*(UNKNOWN|\d+(?:\.\d{1,2})?)$/i,
    ))
  ) {
    manualCharge(c, o, m[1]!.trim(), m[2]!.trim(), m[3]!, m[4]!);
    return;
  }
  if ((m = text.match(/^SALDO\s+(\S+)\s+(\d+(?:\.\d{1,2})?)$/i))) {
    balanceCharge(c, o, m[1]!, m[2]!);
    return;
  }

  if (
    (m = text.match(
      /^agrega(?:r)?\s+(?:a\s+)?(.+?)\s+(\+?[\d][\d\s-]{8,17})$/i,
    ))
  ) {
    const jid = toJid(m[2]!);
    const name = m[1]!.trim();
    if (!jid)
      reply(
        "Ese número no parece válido. Incluye la lada, por ejemplo 5215550000002.",
      );
    else if (c.config.selfJids.includes(jid))
      reply("Ese es tu propio número; elige solo chats de clientes.");
    else {
      c.addClient(jid, name);
      reply(
        `Listo: leeré el chat con ${name}. Solo propondré cobros cuando ese cliente acuerde un precio contigo.`,
      );
    }
    return;
  }
  if ((m = text.match(/^(?:quita|quitar|elimina)\s+(?:a\s+)?(.+)$/i))) {
    const hit = resolveClient(c, m[1]!);
    if (typeof hit === "object") {
      const label = c.clientLabel(hit.jid);
      c.removeClient(hit.jid);
      reply(
        `Dejé de leer el chat con ${label}; sus cobros pendientes quedaron cancelados.`,
      );
    } else
      reply(
        hit === "none"
          ? "No encontré a ese cliente en tu lista."
          : "Hay varios clientes con ese nombre; sé más específico.",
      );
    return;
  }
  if (/^(?:mis\s+)?clientes$/i.test(text)) {
    const list = c.listClients();
    reply(
      list.length
        ? `Leo estos chats: ${list.map((x) => x.name).join(", ")}.`
        : "Todavía no has elegido clientes. Escribe «agrega a Ana 5215550000002».",
    );
    return;
  }
  if (
    /^¿?(?:resumen(?:\s+(?:de\s+)?hoy)?|c[oó]mo\s+voy(?:\s+hoy)?|cobros\s+de\s+hoy|qu[eé]\s+me\s+deben)[?!.\s]*$/i.test(
      text,
    )
  ) {
    reply(
      buildSummary(c, { now: c.currentTime() }) ??
        "Hoy todavía no hay cobros. Cuando un cliente acepte un precio, te propongo el cobro.",
    );
    return;
  }
  if (/^estado$/i.test(text)) {
    const accounts = c.listAccounts();
    reply(
      accounts.length
        ? `Tu cuenta ${accounts[0]!.input.alias} está ${accounts[0]!.status}.`
        : "Aún no has registrado una cuenta. Escríbeme «hola» para empezar.",
    );
    return;
  }
  if (
    (m = text.match(
      /^cobr(?:a|ar)(?:le)?\s+\$?(\d+(?:\.\d{1,2})?)\s+a\s+(.+?)(?:\s+por\s+(.+?))?(?:[,;.]?\s*total\s+\$?(\d+(?:\.\d{1,2})?))?[.\s]*$/i,
    ))
  ) {
    const hit = resolveClient(c, m[2]!);
    if (typeof hit !== "object")
      reply(
        hit === "none"
          ? "No encontré a ese cliente. Agrégalo primero con «agrega a Nombre número»."
          : "Hay varios clientes con ese nombre; sé más específico.",
      );
    else manualCharge(c, o, hit.jid, m[3] ?? "servicio", m[1]!, m[4] ?? m[1]!);
    return;
  }
  if (
    /^(?:hola|buenas|inicio|empezar|registrar|alta)\b/i.test(text) &&
    startOnboarding(c, o)
  )
    return;
  if (startOnboarding(c, o)) return;
  reply(HELP);
}

function manualCharge(
  c: Coordinator,
  o: Observation,
  chat: string,
  concept: string,
  amountText: string,
  totalText: string,
) {
  const accounts = c
    .listAccounts()
    .filter((a) => a.status === "ACTIVE" && a.providerId);
  if (
    accounts.length !== 1 ||
    !c.get(
      "SELECT jid FROM chats WHERE merchant_id=? AND jid=?",
      c.config.merchantId,
      chat,
    )
  ) {
    c.notifyControl(
      accounts.length !== 1
        ? "Tu cuenta aún no está activa; no puedo preparar cobros."
        : "Ese cliente no está en tu lista.",
      `manual-rejected:${o.messageId}`,
    );
    return;
  }
  try {
    const amount = parsePesos(amountText);
    const total =
      totalText.toUpperCase() === "UNKNOWN" ? null : parsePesos(totalText);
    c.propose({
      chatJid: chat,
      lines: [{ description: concept, amountCents: total ?? amount }],
      totalCents: total,
      amountCents: amount,
      kind: total === amount ? "FULL" : "EXTRA",
      evidence: [o.messageId],
      expiresAt: c.currentTime() + 86400000,
      accountId: accounts[0]!.id,
    });
  } catch {
    c.notifyControl(
      "No pude crear el cobro. Revisa el importe y el total.",
      `manual-invalid:${o.messageId}`,
    );
  }
}

function balanceCharge(
  c: Coordinator,
  o: Observation,
  orderId: string,
  amountText: string,
) {
  const order = c.getOrder(orderId);
  if (!order) {
    c.notifyControl("No encontré esa orden.", `balance-invalid:${o.messageId}`);
    return;
  }
  try {
    c.propose({
      orderId: order.id,
      chatJid: order.chat_jid,
      accountId: order.account_id,
      lines: order.lines,
      totalCents: order.totalCents,
      amountCents: parsePesos(amountText),
      kind: "BALANCE",
      evidence: [o.messageId],
      expiresAt: c.currentTime() + 86400000,
    });
  } catch {
    c.notifyControl(
      "No pude crear el cobro de saldo.",
      `balance-invalid:${o.messageId}`,
    );
  }
}

export { formatPesos };
