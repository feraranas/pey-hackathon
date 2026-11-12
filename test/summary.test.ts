import { describe, expect, it } from "vitest";
import { harness, ana, luis, now } from "./harness.js";
import { buildSummary } from "../src/summary.js";

describe("merchant summary", () => {
  it("says so when there is nothing today", async () => {
    const h = harness();
    await h.activate();
    await h.product("resumen");
    expect(h.sent(/Hoy todavía no hay cobros/)).toHaveLength(1);
  });

  it("keeps sent, reported and awaiting charges out of the confirmed total", async () => {
    const clock = { t: now };
    const h = harness(clock);
    await h.activate();
    await h.quote(ana, 1200);
    await h.quote(luis, 1600);
    clock.t += 1000;
    await h.product("Sí, el de Ana");
    await h.chat(ana, false, "ya pagué", { imageRef: "receipt" });
    await h.product("resumen de hoy");
    const text = h.sent(/Cobros de hoy/).at(-1)!.text;
    expect(text).toContain("📎 Ana · $1,200.00 · comprobante reportado");
    expect(text).toContain("❔ Luis · $1,600.00 · esperando tu Sí");
    expect(text).toContain("*Confirmado por pey: $0.00*");
    expect(text).toContain("Pendiente por cobrar: $1,200.00");
  });

  it("a rejected charge is listed as not sent", async () => {
    const h = harness();
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("No");
    await h.product("cómo voy");
    expect(h.sent(/Cobros de hoy/).at(-1)!.text).toContain(
      "Cobro de Ana ($1,200.00): lo rechazaste, no se envió",
    );
  });

  it("the daily summary goes out once, after the configured hour, and only if there is something to say", async () => {
    // 2026-11-11 18:00 in Mexico City is 00:00 UTC on the 12th.
    const clock = { t: Date.UTC(2026, 10, 12, 0, 0, 0) };
    const h = harness(clock, { dailySummary: { hour: 20 } });
    await h.activate();
    await h.quote(ana, 1200);
    await h.runtime.step();
    expect(h.sent(/Cobros de hoy/)).toHaveLength(0);
    clock.t = Date.UTC(2026, 10, 12, 2, 5, 0); // 20:05 local
    await h.runtime.step();
    await h.runtime.step();
    expect(h.sent(/Cobros de hoy/)).toHaveLength(1);
    expect(buildSummary(h.c, { now: clock.t })).toContain("Ana");
  });

  it("a client message re-asks the same charge without calling it a price change or a discarded quote", async () => {
    const clock = { t: now };
    const h = harness(clock);
    await h.activate();
    await h.quote(ana, 1200);
    await h.chat(ana, false, "Sí, mándamelo");
    expect(h.sent(/¿Le envío a Ana el cobro de \$1,200\.00/)).toHaveLength(2);
    expect(h.sent(/Descarté la cotización anterior/)).toHaveLength(0);
    clock.t += 1000;
    await h.product("Sí");
    await h.product("resumen");
    const text = h.sent(/Cobros de hoy/).at(-1)!.text;
    expect(text).not.toContain("descartada");
  });
});
