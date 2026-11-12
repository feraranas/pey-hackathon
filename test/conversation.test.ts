import { describe, expect, it } from "vitest";
import { harness, merchant, ana, luis, now } from "./harness.js";
import { RuleExtractor } from "../src/extraction.js";
import { RoutedWhatsApp } from "../src/router.js";
import { SimulatedWhatsApp } from "../src/simulation.js";
import type { Observation } from "../src/contracts.js";

describe("product number is the only control channel", () => {
  it("never reads the merchant's own chat, other senders or the product's echoes as commands", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    const base = h.pey.charges.size;
    const attempts: Observation[] = [
      {
        session: "MERCHANT",
        chatJid: merchant,
        messageId: "x1",
        fromMe: true,
        at: now,
        text: "Sí",
      },
      {
        session: "PRODUCT",
        chatJid: merchant,
        messageId: "x2",
        fromMe: true,
        at: now,
        text: "Sí",
      },
      {
        session: "PRODUCT",
        chatJid: ana,
        messageId: "x3",
        fromMe: false,
        at: now,
        text: "Sí",
      },
    ];
    for (const a of attempts) expect(h.runtime.accept(a)).toBe("ignored");
    await h.chat(ana, false, "Sí");
    await h.runtime.step();
    expect(h.pey.charges.size).toBe(base);
  });
  it("ignores unpicked client chats", async () => {
    const h = harness();
    await h.activate();
    expect(
      h.runtime.accept({
        session: "MERCHANT",
        chatJid: "529999@s.whatsapp.net",
        messageId: "z",
        fromMe: false,
        at: now,
        text: "Va",
      }),
    ).toBe("ignored");
  });
});

describe("plain «Sí» binds to the current immutable proposal", () => {
  it("approves the single open proposal and sends the QR from the merchant session", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    expect(h.sent(/¿Le envío a Ana el cobro de \$1200\.00/)).toHaveLength(1);
    await h.chat(ana, false, "Sí, mándalo");
    expect(h.pey.charges.size).toBe(0);
    await h.product("Sí");
    expect(h.pey.charges.size).toBe(1);
    const qr = h.wa.deliveries.find((d) => d.qrString)!;
    expect(qr).toMatchObject({ channel: "MERCHANT", recipientJid: ana });
  });
  it("asks which charge when two are open and honors «Sí, el de Luis»", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    await h.quote(luis, 1600);
    await h.product("Sí");
    expect(h.pey.charges.size).toBe(0);
    expect(h.sent(/¿Cuál cobro\?/)).toHaveLength(1);
    await h.product("Sí, el de Luis");
    expect([...h.pey.charges.values()].map((r) => r.amountCents)).toEqual([
      160000,
    ]);
    expect(h.wa.deliveries.find((d) => d.qrString)!.recipientJid).toBe(luis);
  });
  it("invalidates the old proposal on a price change and requires a new «Sí»", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    const old = h.wa.deliveries.findLast((d) => /¿Le envío/.test(d.text))!;
    await h.chat(ana, true, "Perdón, son balatas 1500, total 1500.");
    await h.product("Sí", { quotedMessageId: old.messageId });
    expect(h.pey.charges.size).toBe(0);
    await h.product("Sí");
    expect(h.sent(/ningún cobro pendiente/)).toHaveLength(1);
    await h.chat(ana, false, "Va, así quedamos");
    await h.product("Sí");
    expect([...h.pey.charges.values()].map((r) => r.amountCents)).toEqual([
      150000,
    ]);
  });
  it("«No» rejects the open proposal without creating a QR", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("No");
    await h.product("Sí");
    expect(h.pey.charges.size).toBe(0);
  });
});

describe("payment truth", () => {
  it("a receipt photo is reported, not paid; only a verified transaction pays", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("Sí");
    const orderId = h.store.db.prepare("SELECT id FROM orders").get() as {
      id: string;
    };
    await h.chat(ana, false, "", { imageRef: "photo" });
    expect(h.sent(/No cuenta como pagado/)).toHaveLength(1);
    expect(h.c.balance(orderId.id).verifiedCents).toBe(0);
    expect(h.sent(/Recibiste/)).toHaveLength(0);
  });
});

describe("conversational pey onboarding", () => {
  it("collects alias, legal name, CLABE and person type; warns about 5 business days; registers only after explicit consent", async () => {
    const h = harness();
    await h.product("hola");
    await h.product("Taller Rafa");
    await h.product("Rafael Ortiz");
    await h.product("123");
    expect(h.sent(/CLABE no es válida/)).toHaveLength(1);
    await h.product("646180157034432952");
    await h.product("moral");
    expect(h.sent(/· persona moral\./)).toHaveLength(1);
    expect(h.sent(/cinco días hábiles/)).toHaveLength(1);
    await h.product("Sí");
    expect(h.pey.accounts.size).toBe(0);
    expect(h.sent(/Sí, autorizo/).length).toBeGreaterThan(1);
    await h.product("Sí, autorizo");
    expect(h.pey.accounts.size).toBe(1);
    const [account] = h.pey.accounts.values();
    expect(account).toMatchObject({
      alias: "Taller Rafa",
      name: "Rafael Ortiz",
      entity: "BUSINESS",
      status: "PENDING",
    });
    await h.product("agrega a Ana 5215550000002");
    await h.quote(ana, 1200);
    expect(h.sent(/¿Le envío/)).toHaveLength(0);
  });
});

describe("client selection", () => {
  it("removing a client cancels its pending proposal and stops reading the chat", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("quita a Ana");
    await h.product("Sí");
    expect(h.pey.charges.size).toBe(0);
    expect(
      h.runtime.accept({
        session: "MERCHANT",
        chatJid: ana,
        messageId: "late",
        fromMe: false,
        at: now,
        text: "Va",
      }),
    ).toBe("ignored");
  });
});

describe("router", () => {
  it("sends each delivery through the session named by its channel", async () => {
    const a = new SimulatedWhatsApp(),
      b = new SimulatedWhatsApp();
    const router = new RoutedWhatsApp({ PRODUCT: a, MERCHANT: b });
    const d = { id: "1", recipientJid: "x", messageId: "m", text: "t" };
    await router.deliver({ ...d, channel: "PRODUCT" });
    await router.deliver({ ...d, channel: "MERCHANT" });
    expect([a.deliveries.length, b.deliveries.length]).toEqual([1, 1]);
    const legacy = { ...d } as Parameters<typeof router.deliver>[0];
    await router.deliver(legacy);
    await router.deliver({ ...legacy, qrString: "qr" });
    expect([a.deliveries.length, b.deliveries.length]).toEqual([2, 2]);
  });
});

describe("rule extractor", () => {
  const msg = (
    messageId: string,
    fromMe: boolean,
    text: string,
  ): Observation => ({
    session: "MERCHANT",
    chatJid: ana,
    messageId,
    fromMe,
    at: now,
    text,
  });
  it("needs an agreement after the latest quote", async () => {
    const x = new RuleExtractor();
    expect(
      (
        await x.extract([
          msg("1", true, "balatas 800 y mano de obra 400, total 1200"),
        ])
      ).agreed,
    ).toBe(false);
    const facts = await x.extract([
      msg(
        "1",
        true,
        "Ana, balatas 800 y mano de obra 400, total 1200. Anticipo 600.",
      ),
      msg("2", false, "Va"),
    ]);
    expect(facts).toMatchObject({
      agreed: true,
      totalText: "1200",
      requestedNowText: "600",
      kind: "DEPOSIT",
      ambiguities: [],
    });
    expect(facts.lines).toEqual([
      { description: "balatas", amountText: "800" },
      { description: "mano de obra", amountText: "400" },
    ]);
  });
  it("flags a breakdown that does not add up", async () => {
    const facts = await new RuleExtractor().extract([
      msg("1", true, "balatas 800 y mano de obra 400, total 1500"),
      msg("2", false, "ok"),
    ]);
    expect(facts.ambiguities).toContain("El desglose no suma el total.");
  });
});
