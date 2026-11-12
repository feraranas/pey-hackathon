import { describe, expect, it } from "vitest";
import { harness, ana, now } from "./harness.js";

describe("webhook that outruns the QR record", () => {
  it("waits, applies once the QR is known, and never pays twice", async () => {
    const clock = { t: now };
    const h = harness(clock);
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("Sí");
    const qrId = [...h.pey.charges.keys()][0]!;
    const stored = h.store.db.prepare("SELECT qr_id FROM charges").get() as {
      qr_id: string;
    };
    expect(stored.qr_id).toBe(qrId);
    // Simulate the webhook arriving before the QR result was recorded.
    h.store.db.prepare("UPDATE charges SET qr_id=NULL").run();
    const tx = h.pey.pay(qrId);
    h.c.saveWebhook("wh-early", {
      type: "codi.qr.payment_received",
      transactionId: tx.id,
      codiQrId: qrId,
      bankAccountId: [...h.pey.accounts.keys()][0],
      apiKeyId: "key",
    });
    await h.runtime.step();
    const pending = () =>
      (
        h.store.db
          .prepare("SELECT state FROM webhooks WHERE id='wh-early'")
          .get() as { state: string }
      ).state;
    expect(pending()).toBe("PENDING");
    expect(h.sent(/Recibiste/)).toHaveLength(0);
    expect(
      h.store.db.prepare("SELECT COUNT(*) n FROM reviews").get(),
    ).toMatchObject({ n: 0 });
    // The QR becomes known; the next retry applies the payment.
    h.store.db.prepare("UPDATE charges SET qr_id=?").run(qrId);
    clock.t += 31_000;
    await h.runtime.step();
    expect(pending()).toBe("DONE");
    expect(h.sent(/Recibiste/)).toHaveLength(1);
    // A replay under the same id is ignored.
    expect(h.c.saveWebhook("wh-early", {})).toBe(false);
    clock.t += 31_000;
    await h.runtime.step();
    expect(h.sent(/Recibiste/)).toHaveLength(1);
  });

  it("sends an unknown QR to review after the retries are exhausted", async () => {
    const clock = { t: now };
    const h = harness(clock);
    await h.activate();
    await h.quote(ana, 1200);
    await h.product("Sí");
    const qrId = [...h.pey.charges.keys()][0]!;
    h.store.db.prepare("UPDATE charges SET qr_id=NULL").run();
    const tx = h.pey.pay(qrId);
    h.c.saveWebhook("wh-lost", {
      type: "codi.qr.payment_received",
      transactionId: tx.id,
      codiQrId: qrId,
      bankAccountId: [...h.pey.accounts.keys()][0],
      apiKeyId: "key",
    });
    for (let i = 0; i < 12; i++) {
      await h.runtime.step();
      clock.t += 31_000;
    }
    expect(
      h.store.db.prepare("SELECT state FROM webhooks WHERE id='wh-lost'").get(),
    ).toEqual({ state: "DONE" });
    expect(
      h.store.db
        .prepare(
          "SELECT COUNT(*) n FROM reviews WHERE kind='PAYMENT_QUARANTINED'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(h.sent(/Recibiste/)).toHaveLength(0);
  });
});
