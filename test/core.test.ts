import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import type { Job } from "../src/coordinator.js";

const now = 1_800_000_000_000;
function setup() {
  const s = new Store(":memory:", "test key");
  const c = new Coordinator(s, {
    merchantId: "merchant",
    selfJids: ["me"],
    controlChatJid: "me",
    pairedAt: now - 100,
    now: () => now,
  });
  c.allowChat("ana");
  expect(
    c.command({
      kind: "onboarding_data",
      input: {
        alias: "Taller",
        name: "Juan",
        clabe: "646180157034432952",
        entity: "PERSON",
      },
      messageId: "onboard",
    }),
  ).toBe("accepted");
  const consent = s.db.prepare("SELECT code FROM consents").get() as {
    code: string;
  };
  expect(
    c.command({ kind: "consent", code: consent.code, messageId: "consent" }),
  ).toBe("accepted");
  let job: Job | null;
  while ((job = c.claimJob())) {
    if (job.kind === "register_account") {
      c.completeJob(job.id, { id: "bank", status: "ACTIVE" });
      break;
    }
    c.completeJob(job.id);
  }
  const accountId = c.listAccounts()[0]!.id;
  const proposal = () =>
    c.propose({
      chatJid: "ana",
      lines: [{ description: "balatas", amountCents: 120000 }],
      totalCents: 120000,
      amountCents: 60000,
      kind: "DEPOSIT",
      evidence: ["msg"],
      expiresAt: now + 86_400_000,
      accountId,
    });
  return { s, c, accountId, proposal };
}
function qr(c: Coordinator, intentId: string) {
  let job: Job | null;
  while ((job = c.claimJob())) {
    if (job.kind === "create_qr" && job.request.intentId === intentId) {
      expect(job.request.expiration).toBe(86400);
      expect(job.request.numRef).toMatch(/^\d{1,7}$/);
      c.completeJob(job.id, { id: "qr-" + intentId, qrString: "qr-secret" });
      return;
    }
    c.completeJob(job.id);
  }
  throw new Error("missing QR job");
}
function payment(c: Coordinator, intentId: string, id = "tx") {
  return c.payment({
    webhookId: "wh-" + id,
    event: {
      type: "codi.qr.payment_received",
      transactionId: id,
      codiQrId: "qr-" + intentId,
      bankAccountId: "bank",
      apiKeyId: "key",
    },
    transaction: {
      id,
      status: "PAID",
      currency: "MXN",
      amountCents: 60000,
      baseCents: 60000,
      paymentMethod: "CODI",
      payableType: "API_CODI_QR",
      payableId: "qr-" + intentId,
    },
  });
}
describe("coordinator", () => {
  it("requires an exact authorized control command and applies each transaction once", () => {
    const { c, proposal } = setup();
    const p = proposal();
    for (let job; (job = c.claimJob());) c.completeJob(job.id);
    expect(
      c.observe({
        session: "MERCHANT",
        chatJid: "ana",
        messageId: "client",
        fromMe: false,
        at: now,
        text: `SI ${p.code}`,
      }),
    ).toBe("accepted");
    expect(
      c.command({ kind: "approve", clientName: "Luis", messageId: "bare" }),
    ).toBe("clarification");
    expect(
      c.observe({
        session: "PRODUCT",
        chatJid: "me",
        messageId: "approve",
        fromMe: false,
        at: now,
        text: `SI ${p.code}`,
      }),
    ).toBe("accepted");
    expect(
      c.observe({
        session: "PRODUCT",
        chatJid: "me",
        messageId: "approve",
        fromMe: false,
        at: now,
        text: `SI ${p.code}`,
      }),
    ).toBe("duplicate");
    expect(
      c.command({ kind: "approve", code: p.code, messageId: "second" }),
    ).toBe("rejected");
    qr(c, p.intentId);
    expect(payment(c, p.intentId)).toBe("applied");
    expect(payment(c, p.intentId)).toBe("duplicate");
    expect(c.balance(p.orderId)).toMatchObject({
      verifiedCents: 60000,
      pendingCents: 60000,
      status: "PARTIAL",
    });
    expect(payment(c, p.intentId, "second")).toBe("applied");
    expect(c.balance(p.orderId)).toMatchObject({
      verifiedCents: 120000,
      status: "PAID",
    });
  });
  it("invalidates stale revisions, separates cash and reports, and preserves unknown totals", () => {
    const { c, proposal } = setup();
    const p = proposal();
    c.revise(p.orderId, {
      lines: [{ description: "nuevo", amountCents: 150000 }],
      totalCents: null,
    });
    expect(c.command({ kind: "approve", code: p.code, messageId: "old" })).toBe(
      "rejected",
    );
    c.reportReceipt(p.orderId, "photo", "photo-message");
    expect(
      c.command({
        kind: "cash",
        orderId: p.orderId,
        amountCents: 5000,
        messageId: "cash",
      }),
    ).toBe("accepted");
    expect(c.balance(p.orderId)).toMatchObject({
      verifiedCents: 0,
      cashCents: 5000,
      pendingCents: null,
      status: "UNKNOWN",
    });
  });
  it("quarantines mismatched recipients and stores sensitive data encrypted", () => {
    const { s, c, proposal } = setup();
    const p = proposal();
    c.command({ kind: "approve", code: p.code, messageId: "yes" });
    qr(c, p.intentId);
    const outcome = c.payment({
      webhookId: "w",
      event: {
        type: "codi.qr.payment_received",
        transactionId: "bad",
        codiQrId: "qr-" + p.intentId,
        bankAccountId: "other",
        apiKeyId: "key",
      },
      transaction: {
        id: "bad",
        status: "PAID",
        currency: "MXN",
        amountCents: 60000,
        baseCents: 60000,
        paymentMethod: "CODI",
        payableType: "API_CODI_QR",
        payableId: "qr-" + p.intentId,
      },
    });
    expect(outcome).toBe("quarantined");
    expect(c.balance(p.orderId).verifiedCents).toBe(0);
    expect(
      JSON.stringify(s.db.prepare("SELECT * FROM accounts").all()),
    ).not.toContain("646180157034432952");
  });
});
describe("recovery and identity", () => {
  it("does not approve bot echoes or pending accounts", () => {
    const { s, c, proposal } = setup();
    const p = proposal();
    expect(
      c.observe({
        session: "PRODUCT",
        chatJid: "me",
        messageId: p.promptId,
        fromMe: false,
        at: now,
        text: `SI ${p.code}`,
      }),
    ).toBe("ignored");
    c.updateAccount(c.listAccounts()[0]!.id, "PENDING");
    expect(
      c.command({ kind: "approve", code: p.code, messageId: "pending" }),
    ).toBe("rejected");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
      n: 0,
    });
  });
  it("marks in-flight creation uncertain on restart and never retries it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pey-core-"));
    const path = join(dir, "db");
    try {
      let s = new Store(path, "key");
      let c = new Coordinator(s, {
        merchantId: "m",
        selfJids: ["me"],
        controlChatJid: "me",
        pairedAt: 0,
        now: () => now,
      });
      c.allowChat("ana");
      c.command({
        kind: "onboarding_data",
        input: {
          alias: "a",
          name: "n",
          clabe: "646180157034432952",
          entity: "PERSON",
        },
        messageId: "data",
      });
      const consent = s.db.prepare("SELECT code FROM consents").get() as {
        code: string;
      };
      c.command({ kind: "consent", code: consent.code, messageId: "consent" });
      let job: Job | null;
      while ((job = c.claimJob())) {
        if (job.kind === "register_account") {
          c.completeJob(job.id, { id: "bank", status: "ACTIVE" });
          break;
        }
        c.completeJob(job.id);
      }
      const p = c.propose({
        chatJid: "ana",
        lines: [{ description: "x", amountCents: 100 }],
        totalCents: 100,
        amountCents: 100,
        kind: "FULL",
        evidence: [],
        expiresAt: now + 86400000,
        accountId: c.listAccounts()[0]!.id,
      });
      c.command({ kind: "approve", code: p.code, messageId: "yes" });
      while ((job = c.claimJob()) && job.kind !== "create_qr")
        c.completeJob(job.id);
      expect(job?.kind).toBe("create_qr");
      s.close();
      s = new Store(path, "key");
      c = new Coordinator(s, {
        merchantId: "m",
        selfJids: ["me"],
        controlChatJid: "me",
        pairedAt: 0,
        now: () => now,
      });
      expect(c.getIntent(p.intentId)?.creation_state).toBe("UNCERTAIN");
      expect(
        s.db.prepare("SELECT state FROM jobs WHERE kind='create_qr'").get(),
      ).toEqual({ state: "UNCERTAIN" });
      expect(
        s.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reviews WHERE kind='EFFECT_UNCERTAIN'",
          )
          .get(),
      ).toEqual({ n: 1 });
      new Coordinator(s, {
        merchantId: "m",
        selfJids: ["me"],
        controlChatJid: "me",
        pairedAt: 0,
        now: () => now,
      });
      expect(
        s.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reviews WHERE kind='EFFECT_UNCERTAIN'",
          )
          .get(),
      ).toEqual({ n: 1 });
      expect(
        s.db
          .prepare(
            "SELECT COUNT(*) AS n FROM jobs WHERE semantic_key LIKE '%:recovery'",
          )
          .get(),
      ).toEqual({ n: 1 });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
it("suppresses delivery when an order changes during QR creation", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  let job: Job | null;
  while ((job = c.claimJob()) && job.kind !== "create_qr")
    c.completeJob(job.id);
  expect(job?.kind).toBe("create_qr");
  c.revise(p.orderId, {
    lines: [{ description: "new", amountCents: 130000 }],
    totalCents: 130000,
  });
  c.completeJob(job!.id, { id: "late-qr", qrString: "qr" });
  expect(c.getIntent(p.intentId)?.delivery_state).toBe("REVIEW");
  expect(
    s.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE semantic_key=?")
      .get(`intent:${p.intentId}:qr`),
  ).toEqual({ n: 0 });
});
it("does not recursively notify about a failed control message", () => {
  const { s, c } = setup();
  let job: Job | null;
  while ((job = c.claimJob())) c.completeJob(job.id);
  c.notifyControl("test", "test-failure");
  job = c.claimJob();
  expect(job?.kind).toBe("deliver");
  c.failJob(job!.id, true);
  expect(
    s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='QUEUED'").get(),
  ).toEqual({ n: 0 });
});
it("keeps delivery uncertain until an echo arrives from the exact recipient", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  qr(c, p.intentId);
  let job: Job | null;
  while (
    (job = c.claimJob()) &&
    !(job.kind === "deliver" && job.delivery.recipientJid === "ana")
  )
    c.completeJob(job.id);
  if (!job || job.kind !== "deliver") throw new Error("delivery missing");
  c.failJob(job.id, true);
  c.markDeliveryEcho(job.delivery.messageId, "other");
  expect(c.getIntent(p.intentId)?.delivery_state).toBe("UNCERTAIN");
  c.markDeliveryEcho(job.delivery.messageId, "ana");
  expect(c.getIntent(p.intentId)?.delivery_state).toBe("DELIVERED");
  expect(() =>
    s.db.prepare("UPDATE jobs SET recipient='other' WHERE id=?").run(job!.id),
  ).toThrow();
});
it("requires fresh approval after uncertain QR creation", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  let job: Job | null;
  while ((job = c.claimJob()) && job.kind !== "create_qr")
    c.completeJob(job.id);
  c.failJob(job!.id, true);
  expect(
    c.command({ kind: "repropose", code: p.code, messageId: "retry" }),
  ).toBe("accepted");
  expect(
    c.command({ kind: "repropose", code: p.code, messageId: "retry-again" }),
  ).toBe("rejected");
  const intents = s.db
    .prepare("SELECT * FROM intents ORDER BY rowid")
    .all() as Array<{ code: string; approval_state: string }>;
  expect(intents).toHaveLength(2);
  expect(intents[1]!.code).not.toBe(p.code);
  expect(intents[1]!.approval_state).toBe("PROPOSED");
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
    n: 1,
  });
});
it("creates a manual proposal without implicitly authorizing it", () => {
  const { s, c } = setup();
  expect(
    c.observe({
      session: "PRODUCT",
      chatJid: "me",
      messageId: "manual",
      fromMe: false,
      at: now,
      text: "COBRAR ana | balatas | 600 | 1200",
    }),
  ).toBe("accepted");
  expect(s.db.prepare("SELECT approval_state FROM intents").get()).toEqual({
    approval_state: "PROPOSED",
  });
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
    n: 0,
  });
});
it("approves deposit and balance independently for one order", () => {
  const { s, c, proposal, accountId } = setup();
  const p = proposal();
  const q = c.propose({
    orderId: p.orderId,
    chatJid: "ana",
    lines: [{ description: "balatas", amountCents: 120000 }],
    totalCents: 120000,
    amountCents: 60000,
    kind: "BALANCE",
    evidence: [],
    expiresAt: now + 86400000,
    accountId,
  });
  expect(
    c.command({
      kind: "approve",
      code: p.code,
      quotedPromptId: q.promptId,
      messageId: "mismatch",
    }),
  ).toBe("clarification");
  expect(c.command({ kind: "approve", code: p.code, messageId: "yes1" })).toBe(
    "accepted",
  );
  expect(
    c.command({
      kind: "approve",
      quotedPromptId: q.promptId,
      messageId: "yes2",
    }),
  ).toBe("accepted");
  qr(c, p.intentId);
  qr(c, q.intentId);
  expect(payment(c, p.intentId, "first")).toBe("applied");
  expect(payment(c, q.intentId, "second")).toBe("applied");
  expect(c.balance(p.orderId)).toMatchObject({
    verifiedCents: 120000,
    status: "PAID",
  });
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
    n: 2,
  });
});
it("applies a verified old-version payment and flags review", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  qr(c, p.intentId);
  c.revise(p.orderId, {
    lines: [{ description: "changed", amountCents: 150000 }],
    totalCents: 150000,
  });
  expect(payment(c, p.intentId)).toBe("applied");
  expect(c.balance(p.orderId).verifiedCents).toBe(60000);
  expect(s.db.prepare("SELECT flags FROM receipts").get()).toEqual({
    flags: '["OLD_VERSION"]',
  });
  expect(c.getIntent(p.intentId)?.payment_state).toBe("REVIEW");
});
it("applies payment while delivery remains uncertain", () => {
  const { c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  qr(c, p.intentId);
  let job: Job | null;
  while (
    (job = c.claimJob()) &&
    !(job.kind === "deliver" && job.delivery.recipientJid === "ana")
  )
    c.completeJob(job.id);
  c.failJob(job!.id, true);
  expect(payment(c, p.intentId)).toBe("applied");
  expect(c.getIntent(p.intentId)).toMatchObject({
    delivery_state: "UNCERTAIN",
    payment_state: "PAID",
  });
});
it.each(["currency", "base", "idc", "clabe"] as const)(
  "quarantines a mismatched %s",
  (field) => {
    const { c, proposal } = setup();
    const p = proposal();
    c.command({ kind: "approve", code: p.code, messageId: "yes" });
    qr(c, p.intentId);
    const event = {
      type: "codi.qr.payment_received" as const,
      transactionId: "mismatch",
      codiQrId: "qr-" + p.intentId,
      bankAccountId: "bank",
      apiKeyId: "key",
    };
    const transaction = {
      id: "mismatch",
      status: "PAID" as const,
      currency: "MXN",
      amountCents: 60000,
      baseCents: 60000,
      paymentMethod: "CODI",
      payableType: "API_CODI_QR",
      payableId: event.codiQrId,
      receiverClabe: "646180157034432952",
    };
    if (field === "currency") transaction.currency = "USD";
    if (field === "base") transaction.baseCents = 1;
    if (field === "idc") transaction.payableId = "other";
    if (field === "clabe") transaction.receiverClabe = "646180157034432953";
    expect(c.payment({ webhookId: "w", event, transaction })).toBe(
      "quarantined",
    );
    expect(c.balance(p.orderId).verifiedCents).toBe(0);
  },
);
it("rejects other merchants accounts, invalid CLABEs and unallowed chat content", () => {
  const { s, c, accountId } = setup();
  const other = new Coordinator(s, {
    merchantId: "other",
    selfJids: ["other"],
    controlChatJid: "other",
    pairedAt: 0,
    now: () => now,
  });
  other.allowChat("bob");
  expect(() =>
    other.propose({
      chatJid: "bob",
      lines: [{ description: "x", amountCents: 1 }],
      totalCents: 1,
      amountCents: 1,
      kind: "FULL",
      evidence: [],
      expiresAt: now + 86400000,
      accountId,
    }),
  ).toThrow();
  expect(
    c.command({
      kind: "onboarding_data",
      input: {
        alias: "x",
        name: "x",
        clabe: "646180157034432951",
        entity: "PERSON",
      },
      messageId: "invalid",
    }),
  ).toBe("rejected");
  c.setAllowedChats(["bob"]);
  expect(
    c.observe({
      session: "MERCHANT",
      chatJid: "ana",
      messageId: "private",
      fromMe: false,
      at: now,
      text: "private content",
    }),
  ).toBe("ignored");
  expect(
    s.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE message_id='private'")
      .get(),
  ).toEqual({ n: 0 });
});

it("rejects a command after expiry on restart", () => {
  const { s, proposal } = setup();
  const p = proposal();
  const restarted = new Coordinator(s, {
    merchantId: "merchant",
    selfJids: ["me"],
    controlChatJid: "me",
    pairedAt: 0,
    now: () => now + 86400001,
  });
  expect(
    restarted.command({ kind: "approve", code: p.code, messageId: "late" }),
  ).toBe("rejected");
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
    n: 0,
  });
});
it.each(["REJECTED", "EXPIRED"] as const)(
  "permits explicit fresh approval after %s",
  (state) => {
    const { s, c, proposal } = setup();
    const p = proposal();
    if (state === "REJECTED")
      c.command({ kind: "reject", code: p.code, messageId: "no" });
    else c.tick(now + 86400001);
    expect(
      c.command({ kind: "repropose", code: p.code, messageId: "again" }),
    ).toBe("accepted");
    expect(
      s.db
        .prepare(
          "SELECT COUNT(*) AS n FROM intents WHERE approval_state='PROPOSED'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
      n: 0,
    });
  },
);
it("does not deliver a queued QR after the chat is removed", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.command({ kind: "approve", code: p.code, messageId: "yes" });
  qr(c, p.intentId);
  c.setAllowedChats([]);
  let job: Job | null;
  while ((job = c.claimJob())) c.completeJob(job.id);
  expect(
    s.db
      .prepare("SELECT state FROM jobs WHERE semantic_key=?")
      .get(`intent:${p.intentId}:qr`),
  ).toEqual({ state: "CANCELLED" });
});
it("persists trusted self aliases and rejects binding a different primary", () => {
  const { s, c } = setup();
  expect(() => c.bindSelfJids(["other", "lid"])).toThrow();
  c.bindSelfJids(["me", "lid"]);
  const restarted = new Coordinator(s, {
    merchantId: "merchant",
    selfJids: ["me"],
    controlChatJid: "me",
    pairedAt: 0,
    now: () => now,
  });
  expect(
    restarted.observe({
      session: "PRODUCT",
      chatJid: "lid",
      messageId: "alias",
      fromMe: false,
      at: now,
      text: "AYUDA",
    }),
  ).toBe("accepted");
  expect(
    restarted.observe({
      session: "PRODUCT",
      chatJid: "other",
      messageId: "wrong",
      fromMe: false,
      at: now,
      text: "AYUDA",
    }),
  ).toBe("ignored");
});
it("immediately supersedes pending proposals when merchant updates a quote", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  c.suspendPendingForChat("ana");
  expect(
    c.command({ kind: "approve", code: p.code, messageId: "late-yes" }),
  ).toBe("rejected");
  expect(s.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({
    n: 0,
  });
  expect(
    s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='create_qr'").get(),
  ).toEqual({ n: 0 });
});
it("preserves delivered QR and cancels a queued QR on quote changes", () => {
  const { s, c, proposal, accountId } = setup();
  const p = proposal();
  const q = c.propose({
    orderId: p.orderId,
    chatJid: "ana",
    lines: [{ description: "balatas", amountCents: 120000 }],
    totalCents: 120000,
    amountCents: 60000,
    kind: "BALANCE",
    evidence: [],
    expiresAt: now + 86400000,
    accountId,
  });
  c.command({ kind: "approve", code: p.code, messageId: "first" });
  qr(c, p.intentId);
  let job: Job | null;
  while (
    (job = c.claimJob()) &&
    !(job.kind === "deliver" && job.delivery.recipientJid === "ana")
  )
    c.completeJob(job.id);
  c.completeJob(job!.id);
  c.command({ kind: "approve", code: q.code, messageId: "second" });
  c.suspendPendingForChat("ana");
  expect(c.getIntent(p.intentId)?.approval_state).toBe("APPROVED");
  expect(c.getIntent(q.intentId)?.approval_state).toBe("SUPERSEDED");
  expect(
    s.db
      .prepare("SELECT state FROM jobs WHERE semantic_key=?")
      .get(`intent:${q.intentId}:create`),
  ).toEqual({ state: "CANCELLED" });
  expect(payment(c, p.intentId)).toBe("applied");
});
it("rejects totals that disagree with line items", () => {
  const { c, proposal, accountId } = setup();
  const p = proposal();
  expect(() =>
    c.propose({
      chatJid: "ana",
      accountId,
      lines: [{ description: "x", amountCents: 100 }],
      totalCents: 200,
      amountCents: 100,
      kind: "FULL",
      evidence: [],
      expiresAt: now + 86400000,
    }),
  ).toThrow();
  expect(() =>
    c.revise(p.orderId, {
      lines: [{ description: "x", amountCents: 100 }],
      totalCents: 200,
    }),
  ).toThrow();
  expect(
    c.command({
      kind: "set_total",
      orderId: p.orderId,
      totalCents: 130000,
      messageId: "wrong-total",
    }),
  ).toBe("rejected");
});
it("starts a new order context only for an allowed chat", () => {
  const { s, c, proposal } = setup();
  const p = proposal();
  expect(
    c.observe({
      session: "MERCHANT",
      chatJid: "ana",
      messageId: "client-new",
      fromMe: false,
      at: now,
      text: "NUEVA ana",
    }),
  ).toBe("accepted");
  expect(c.getIntent(p.intentId)?.approval_state).toBe("PROPOSED");
  c.observe({
    session: "PRODUCT",
    chatJid: "me",
    messageId: "bad-new",
    fromMe: false,
    at: now,
    text: "NUEVA unknown",
  });
  expect(c.getIntent(p.intentId)?.approval_state).toBe("PROPOSED");
  c.observe({
    session: "PRODUCT",
    chatJid: "me",
    messageId: "good-new",
    fromMe: false,
    at: now,
    text: "NUEVA ana",
  });
  expect(c.getIntent(p.intentId)?.approval_state).toBe("SUPERSEDED");
  expect(
    s.db
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE semantic_key='reply:good-new'",
      )
      .get(),
  ).toEqual({ n: 1 });
});
