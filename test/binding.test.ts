import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import type { Job } from "../src/coordinator.js";

// A plain «Sí» binds only to a proposal the merchant had actually seen.
// "Seen" means the prompt delivery was acknowledged at or before the moment
// the merchant sent the reply.
function world() {
  let t = 1_800_000_000_000;
  const store = new Store(":memory:", "test key");
  const c = new Coordinator(store, {
    merchantId: "merchant",
    selfJids: ["me"],
    controlChatJid: "me",
    pairedAt: t - 100,
    now: () => t,
  });
  c.addClient("ana", "Ana");
  c.addClient("luis", "Luis");
  c.command({
    kind: "onboarding_data",
    input: {
      alias: "Taller",
      name: "Juan",
      clabe: "646180157034432952",
      entity: "PERSON",
    },
    messageId: "onboard",
  });
  const consent = store.db.prepare("SELECT code FROM consents").get() as {
    code: string;
  };
  c.command({ kind: "consent", code: consent.code, messageId: "consent" });
  drain(c, true);
  const accountId = c.listAccounts()[0]!.id;
  let n = 0;
  const reply = (text: string, at = t, quotedMessageId?: string) =>
    c.observe({
      session: "PRODUCT",
      chatJid: "me",
      messageId: `m${++n}`,
      fromMe: false,
      at,
      text,
      ...(quotedMessageId ? { quotedMessageId } : {}),
    });
  const propose = (chat: string, amount = 60000) =>
    c.propose({
      chatJid: chat,
      lines: [{ description: "balatas", amountCents: amount }],
      totalCents: amount,
      amountCents: amount,
      kind: "FULL",
      evidence: ["msg"],
      expiresAt: t + 86_400_000,
      accountId,
    });
  const outbox = () =>
    (
      store.db
        .prepare("SELECT payload_enc FROM jobs WHERE kind='deliver'")
        .all() as { payload_enc: string }[]
    ).map((r) => store.decrypt<{ text: string }>(r.payload_enc).text);
  const approvals = () =>
    (
      store.db.prepare("SELECT intent_id FROM approvals").all() as {
        intent_id: string;
      }[]
    ).map((r) => r.intent_id);
  return {
    c,
    store,
    reply,
    propose,
    outbox,
    approvals,
    accountId,
    at: () => t,
    advance: (ms: number) => (t += ms),
    show: () => drain(c),
  };
}
function drain(c: Coordinator, registerAccount = false) {
  for (let job: Job | null; (job = c.claimJob());) {
    if (job.kind === "register_account" && registerAccount)
      c.completeJob(job.id, { id: "bank", status: "ACTIVE" });
    else if (job.kind === "create_qr")
      c.completeJob(job.id, { id: "qr", qrString: "qr-secret" });
    else c.completeJob(job.id);
  }
}

describe("binding a plain «Sí» to what the merchant saw", () => {
  it("rejects a «Sí» sent before the proposal prompt was delivered", () => {
    const w = world();
    const sentAt = w.at();
    w.advance(1000);
    const p = w.propose("ana");
    w.advance(500);
    w.show();
    expect(w.c.promptShownAt(p.intentId)).toBe(w.at());
    expect(w.reply("Sí", sentAt)).toBe("accepted");
    expect(w.approvals()).toEqual([]);
    expect(w.outbox().at(-1)).toMatch(/antes de que vieras/);
    w.advance(1000);
    w.reply("Sí");
    expect(w.approvals()).toEqual([p.intentId]);
  });

  it("does not bind to a proposal whose prompt is still queued", () => {
    const w = world();
    const p = w.propose("ana");
    w.reply("Sí");
    expect(w.approvals()).toEqual([]);
    w.show();
    w.advance(1000);
    w.reply("Sí");
    expect(w.approvals()).toEqual([p.intentId]);
  });

  it("a price change lands as the «Sí» is sent: the old and new proposals are both refused", () => {
    const w = world();
    const a = w.propose("ana");
    w.show();
    w.advance(5000);
    const sentAt = w.at();
    w.advance(500);
    w.c.revise(a.orderId, {
      lines: [{ description: "balatas", amountCents: 90000 }],
      totalCents: 90000,
    });
    const b = w.propose("ana", 90000);
    w.advance(500);
    w.show();
    // The merchant answered the 600 pesos prompt, which no longer exists.
    w.reply("Sí", sentAt);
    expect(w.approvals()).toEqual([]);
    expect(w.outbox().at(-1)).toMatch(/cambió mientras respondías/);
    // Only a «Sí» sent after the new prompt was shown binds, and to the new one.
    w.advance(1000);
    w.reply("Sí");
    expect(w.approvals()).toEqual([b.intentId]);
    const row = w.store.db
      .prepare("SELECT snapshot FROM intents WHERE id=?")
      .get(b.intentId) as { snapshot: string };
    expect(JSON.parse(row.snapshot).amountCents).toBe(90000);
  });

  it("a stale prompt cannot be approved by quoting it after a price change", () => {
    const w = world();
    const a = w.propose("ana");
    w.show();
    w.c.revise(a.orderId, {
      lines: [{ description: "balatas", amountCents: 90000 }],
      totalCents: 90000,
    });
    w.propose("ana", 90000);
    w.show();
    w.advance(1000);
    w.reply("Sí", w.at(), a.promptId);
    expect(w.approvals()).toEqual([]);
    expect(w.outbox().at(-1)).toMatch(/ya no está vigente/);
  });

  it("asks which one when two clients are pending and both were seen", () => {
    const w = world();
    w.propose("ana");
    w.propose("luis", 30000);
    w.show();
    w.advance(1000);
    expect(w.reply("Sí")).toBe("accepted");
    expect(w.approvals()).toEqual([]);
    expect(w.outbox().at(-1)).toMatch(/¿Cuál cobro\?.*Ana.*Luis/);
    w.reply("Sí, el de Luis");
    expect(w.approvals()).toHaveLength(1);
    const approved = w.store.db
      .prepare(
        "SELECT i.recipient FROM approvals a JOIN intents i ON i.id=a.intent_id",
      )
      .get() as { recipient: string };
    expect(approved.recipient).toBe("luis");
  });

  it("with two clients where only one prompt was seen, binds to that one", () => {
    const w = world();
    const ana = w.propose("ana");
    w.show();
    w.advance(1000);
    w.propose("luis", 30000); // queued, not yet seen
    w.reply("Sí");
    expect(w.approvals()).toEqual([ana.intentId]);
  });

  it("applies a duplicate «Sí» once, by message id and by a second message", () => {
    const w = world();
    const p = w.propose("ana");
    w.show();
    w.advance(1000);
    const first = {
      session: "PRODUCT" as const,
      chatJid: "me",
      messageId: "dup",
      fromMe: false,
      at: w.at(),
      text: "Sí",
    };
    expect(w.c.observe(first)).toBe("accepted");
    expect(w.c.observe(first)).toBe("duplicate");
    w.advance(1000);
    w.reply("Sí");
    expect(w.approvals()).toEqual([p.intentId]);
    expect(w.outbox().at(-1)).toMatch(/No tengo ningún cobro pendiente/);
    const jobs = w.store.db
      .prepare("SELECT COUNT(*) n FROM jobs WHERE kind='create_qr'")
      .get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it("does not approve an expired proposal", () => {
    const w = world();
    w.propose("ana");
    w.show();
    w.advance(86_400_001);
    w.reply("Sí");
    expect(w.approvals()).toEqual([]);
  });

  it("fails closed when the prompt delivery outcome is uncertain", () => {
    const w = world();
    w.propose("ana");
    const job = w.c.claimJob()!;
    w.c.failJob(job.id, true);
    w.advance(1000);
    w.reply("Sí");
    expect(w.approvals()).toEqual([]);
  });

  it("a «No» also binds only to a seen proposal", () => {
    const w = world();
    const p = w.propose("ana");
    w.reply("No");
    expect(
      w.store.db
        .prepare("SELECT approval_state s FROM intents WHERE id=?")
        .get(p.intentId),
    ).toEqual({ s: "PROPOSED" });
    w.show();
    w.advance(1000);
    w.reply("No");
    expect(
      w.store.db
        .prepare("SELECT approval_state s FROM intents WHERE id=?")
        .get(p.intentId),
    ).toEqual({ s: "REJECTED" });
  });
});
