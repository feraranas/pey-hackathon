import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import { Runtime } from "../src/runtime.js";
import {
  SimulatedPey,
  SimulatedWhatsApp,
  demoExtractor,
} from "../src/simulation.js";
import { runDemo } from "../src/demo.js";
import type { CandidateFacts } from "../src/contracts.js";

const self = "521100@s.whatsapp.net",
  client = "521200@s.whatsapp.net";
const now = 1_800_000_000_000;
function setup(path = ":memory:") {
  const store = new Store(path, "test-encryption-key");
  const c = new Coordinator(store, {
    merchantId: "m",
    selfJids: [self],
    controlChatJid: self,
    pairedAt: now - 1000,
    now: () => now,
  });
  c.allowChat(client);
  return { store, c };
}
async function account(
  c: Coordinator,
  runtime: Runtime,
  pey: SimulatedPey,
  wa: SimulatedWhatsApp,
) {
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "alta",
    fromMe: false,
    at: now,
    text: "ALTA Taller | Titular | 646180157034432952 | PERSON",
  });
  await runtime.drainJobs();
  expect(wa.deliveries[0]!.text).toContain("Sí, autorizo");
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "consent",
    fromMe: false,
    at: now,
    text: "Sí, autorizo",
  });
  await runtime.drainJobs();
  const a = c.listAccounts()[0]!;
  pey.accounts.get(a.providerId!)!.status = "ACTIVE";
  c.updateAccount(a.id, "ACTIVE");
  return a;
}
describe("integrated runtime", () => {
  it("runs complete labeled demo through signed HTTP webhook and refuses stale approval", async () => {
    const output: string[] = [];
    const result = await runDemo((text) => output.push(text));
    expect(result.balance).toMatchObject({
      verifiedCents: 160000,
      pendingCents: 0,
    });
    expect(result.deliveries.filter((d) => d.qrString)).toHaveLength(2);
    expect(output[0]).toContain("SIMULACIÓN");
  });
  it("persists pending extraction across restart without duplicating observations", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "pey-runtime-")),
      "test.sqlite",
    );
    let { store, c } = setup(path);
    let calls = 0;
    const extractor = {
      async extract() {
        calls++;
        return {
          agreed: false,
          lines: [],
          totalText: null,
          requestedNowText: null,
          kind: "FULL",
          ambiguities: [],
          evidence: ["m1"],
        } as CandidateFacts;
      },
    };
    const ports = {
      pey: new SimulatedPey(),
      whatsapp: new SimulatedWhatsApp(),
      extractor,
    };
    let runtime = new Runtime(c, ports, { debounceMs: 0, now: () => now });
    const observation = {
      session: "MERCHANT" as const,
      chatJid: client,
      messageId: "m1",
      fromMe: false,
      at: now,
      text: "hola",
    };
    expect(runtime.accept(observation)).toBe("accepted");
    store.close();
    ({ store, c } = setup(path));
    runtime = new Runtime(c, ports, { debounceMs: 0, now: () => now });
    expect(runtime.accept(observation)).toBe("duplicate");
    await runtime.step();
    await runtime.step();
    expect(calls).toBe(1);
    store.close();
  });
  it("does not consume outbox while transport is disconnected", async () => {
    const { store, c } = setup();
    const wa = new SimulatedWhatsApp();
    c.notifyControl("probe", "probe");
    const runtime = new Runtime(
      c,
      { pey: new SimulatedPey(), whatsapp: wa, extractor: demoExtractor },
      { canDeliver: () => false, now: () => now },
    );
    await runtime.drainJobs();
    expect(wa.deliveries).toHaveLength(0);
    expect(
      c.db.prepare("SELECT state FROM jobs WHERE semantic_key='probe'").get(),
    ).toEqual({ state: "QUEUED" });
    store.close();
  });
  it("does not propose stale extraction after new messages arrive during model call", async () => {
    const { store, c } = setup();
    const pey = new SimulatedPey(),
      wa = new SimulatedWhatsApp();
    let resolve!: (facts: CandidateFacts) => void;
    const extractor = {
      extract: () =>
        new Promise<CandidateFacts>((r) => {
          resolve = r;
        }),
    };
    const runtime = new Runtime(
      c,
      { pey, whatsapp: wa, extractor },
      { debounceMs: 0, now: () => now },
    );
    await account(c, runtime, pey, wa);
    runtime.accept({
      session: "MERCHANT",
      chatJid: client,
      messageId: "quote",
      fromMe: true,
      at: now,
      text: "600",
    });
    const pending = runtime.step();
    await new Promise((r) => setTimeout(r, 0));
    runtime.accept({
      session: "MERCHANT",
      chatJid: client,
      messageId: "changed",
      fromMe: true,
      at: now,
      text: "mejor 700",
    });
    resolve({
      agreed: true,
      lines: [{ description: "trabajo", amountText: "600" }],
      totalText: "600",
      requestedNowText: "600",
      kind: "FULL",
      ambiguities: [],
      evidence: ["quote"],
    });
    await pending;
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM intents").get()).toEqual({
      n: 0,
    });
    store.close();
  });
});

it("blocks the old approval immediately after a new merchant quote before extraction", async () => {
  const { store, c } = setup();
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp();
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: demoExtractor },
    { debounceMs: 0, now: () => now },
  );
  await account(c, runtime, pey, wa);
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "quote",
    fromMe: true,
    at: now,
    text: "balatas 800 mano de obra 400 total 1200 anticipo 600",
  });
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "agree",
    fromMe: false,
    at: now,
    text: "Va",
  });
  await runtime.step();
  const row = c.db.prepare("SELECT code FROM intents").get() as {
    code: string;
  };
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "changed",
    fromMe: true,
    at: now,
    text: "Cambio el precio a 700",
  });
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "old-approval",
    fromMe: false,
    at: now,
    text: `SI ${row.code}`,
  });
  await runtime.drainJobs();
  expect(pey.charges.size).toBe(0);
  store.close();
});
it("stops automatic extraction after quota exhaustion and offers manual billing", async () => {
  const { store, c } = setup();
  const wa = new SimulatedWhatsApp();
  let calls = 0;
  const extractor = {
    async extract(): Promise<CandidateFacts> {
      calls++;
      throw Object.assign(new Error("quota"), {
        code: "credit_balance_exhausted",
      });
    },
  };
  const runtime = new Runtime(
    c,
    { pey: new SimulatedPey(), whatsapp: wa, extractor },
    { debounceMs: 0, now: () => now },
  );
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "a",
    fromMe: true,
    at: now,
    text: "quote",
  });
  await runtime.step();
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "b",
    fromMe: false,
    at: now,
    text: "accepted",
  });
  await runtime.step();
  expect(calls).toBe(1);
  expect(wa.deliveries.some((d) => d.text.includes("COBRAR"))).toBe(true);
  store.close();
});
it("does not propose without an agreement even when amounts are complete", async () => {
  const { store, c } = setup();
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp();
  const extractor = {
    async extract() {
      return {
        agreed: false,
        lines: [{ description: "trabajo", amountText: "600" }],
        totalText: "600",
        requestedNowText: "600",
        kind: "FULL",
        ambiguities: [],
        evidence: ["quote"],
      } as CandidateFacts;
    },
  };
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor },
    { debounceMs: 0, now: () => now },
  );
  await account(c, runtime, pey, wa);
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "quote",
    fromMe: true,
    at: now,
    text: "600",
  });
  await runtime.step();
  expect(c.db.prepare("SELECT COUNT(*) AS n FROM intents").get()).toEqual({
    n: 0,
  });
  store.close();
});
it("detects a missed webhook through authenticated reconciliation without inventing signed evidence", async () => {
  const { store, c } = setup();
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp();
  let clock = now;
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: demoExtractor },
    { debounceMs: 0, now: () => clock },
  );
  const a = await account(c, runtime, pey, wa);
  const p = c.propose({
    chatJid: client,
    lines: [{ description: "x", amountCents: 100 }],
    totalCents: 100,
    amountCents: 100,
    kind: "FULL",
    evidence: [],
    expiresAt: now + 86400000,
    accountId: a.id,
  });
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "approve",
    fromMe: false,
    at: now,
    text: `SI ${p.code}`,
  });
  await runtime.drainJobs();
  pey.pay([...pey.charges.keys()][0]!);
  clock += 61_000;
  await runtime.step();
  expect(c.balance(p.orderId).verifiedCents).toBe(0);
  expect(
    c.db
      .prepare(
        "SELECT COUNT(*) AS n FROM reviews WHERE kind='AWAITING_SIGNED_WEBHOOK'",
      )
      .get(),
  ).toEqual({ n: 1 });
  expect(wa.deliveries.some((d) => d.text.includes("webhook firmado"))).toBe(
    true,
  );
  store.close();
});
it("starts a new extraction context only from the authenticated owner command", async () => {
  const { store, c } = setup();
  const runtime = new Runtime(
    c,
    {
      pey: new SimulatedPey(),
      whatsapp: new SimulatedWhatsApp(),
      extractor: demoExtractor,
    },
    { debounceMs: 0, now: () => now },
  );
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "a",
    fromMe: true,
    at: now,
    text: "old work",
  });
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "attack",
    fromMe: false,
    at: now,
    text: `NUEVA ${client}`,
  });
  expect(
    c.db.prepare("SELECT COUNT(*) AS n FROM runtime_messages").get(),
  ).toEqual({ n: 2 });
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "new",
    fromMe: false,
    at: now,
    text: `NUEVA ${client}`,
  });
  expect(
    c.db.prepare("SELECT COUNT(*) AS n FROM runtime_messages").get(),
  ).toEqual({ n: 0 });
  expect(c.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({
    n: 3,
  });
  store.close();
});
it("suspends the old approval immediately when the client corrects the quote", async () => {
  const { store, c } = setup();
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp();
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: demoExtractor },
    { debounceMs: 0, now: () => now },
  );
  await account(c, runtime, pey, wa);
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "quote",
    fromMe: true,
    at: now,
    text: "balatas 800 mano de obra 400 total 1200 anticipo 600",
  });
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "agree",
    fromMe: false,
    at: now,
    text: "Va",
  });
  await runtime.step();
  const row = c.db.prepare("SELECT code FROM intents").get() as {
    code: string;
  };
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "correction",
    fromMe: false,
    at: now,
    text: "No, acordamos 500",
  });
  runtime.accept({
    session: "PRODUCT",
    chatJid: self,
    messageId: "old-approval",
    fromMe: false,
    at: now,
    text: `SI ${row.code}`,
  });
  await runtime.drainJobs();
  expect(pey.charges.size).toBe(0);
  store.close();
});
it("does not send queued context to the extractor after allowlist removal", async () => {
  const { store, c } = setup();
  let calls = 0;
  const runtime = new Runtime(
    c,
    {
      pey: new SimulatedPey(),
      whatsapp: new SimulatedWhatsApp(),
      extractor: {
        async extract() {
          calls++;
          throw new Error("Must not reach extraction");
        },
      },
    },
    { debounceMs: 0, now: () => now },
  );
  runtime.accept({
    session: "MERCHANT",
    chatJid: client,
    messageId: "queued",
    fromMe: false,
    at: now,
    text: "private quote",
  });
  c.setAllowedChats([]);
  await runtime.step();
  expect(calls).toBe(0);
  store.close();
});
