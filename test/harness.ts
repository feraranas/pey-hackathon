import { Store } from "../src/store.js";
import { Coordinator } from "../src/coordinator.js";
import { Runtime } from "../src/runtime.js";
import { RuleExtractor } from "../src/extraction.js";
import { SimulatedPey, SimulatedWhatsApp } from "../src/simulation.js";
import type { Observation } from "../src/contracts.js";

export const merchant = "5215550000001@s.whatsapp.net",
  ana = "5215550000002@s.whatsapp.net",
  luis = "5215550000003@s.whatsapp.net";
export const now = 1_800_000_000_000;

export function harness(clock: { t: number } = { t: now }) {
  const store = new Store(":memory:", "k");
  const c = new Coordinator(store, {
    merchantId: "m",
    selfJids: [merchant],
    controlChatJid: merchant,
    pairedAt: now - 1000,
    now: () => clock.t,
  });
  const pey = new SimulatedPey(),
    wa = new SimulatedWhatsApp();
  const runtime = new Runtime(
    c,
    { pey, whatsapp: wa, extractor: new RuleExtractor() },
    { debounceMs: 0, now: () => clock.t },
  );
  let n = 0;
  const product = async (text: string, extra: Partial<Observation> = {}) => {
    const r = runtime.accept({
      session: "PRODUCT",
      chatJid: merchant,
      messageId: `p${++n}`,
      fromMe: false,
      at: clock.t,
      text,
      ...extra,
    });
    await runtime.step();
    return r;
  };
  const chat = async (
    jid: string,
    fromMe: boolean,
    text: string,
    extra: Partial<Observation> = {},
  ) => {
    runtime.accept({
      session: "MERCHANT",
      chatJid: jid,
      messageId: `c${++n}`,
      fromMe,
      at: clock.t,
      text,
      ...extra,
    });
    await runtime.step();
  };
  const sent = (re: RegExp) => wa.deliveries.filter((d) => re.test(d.text));
  const activate = async () => {
    await product("hola");
    for (const a of [
      "Taller Rafa",
      "Rafael Ortiz",
      "646180157034432952",
      "física",
    ])
      await product(a);
    await product("Sí, autorizo");
    const account = c.listAccounts()[0]!;
    pey.accounts.get(account.providerId!)!.status = "ACTIVE";
    c.updateAccount(account.id, "ACTIVE");
    await product("agrega a Ana 5215550000002");
    await product("agrega a Luis 5215550000003");
  };
  const quote = async (jid: string, total: number) => {
    await chat(jid, true, `balatas ${total}, total ${total}.`);
    await chat(jid, false, "Va");
  };
  return { c, pey, wa, runtime, product, chat, sent, activate, quote, store };
}
