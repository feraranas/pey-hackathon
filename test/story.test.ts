import { describe, expect, it } from "vitest";
import { harness, ana, luis, now } from "./harness.js";
import { FakeTranscriber, transcribeVoice } from "../src/transcription.js";

const VOICE =
  "Aceite sintético $900, filtro $250, mano de obra $350. Total $1,500.";

describe("the Rafa, Ana and Luis story", () => {
  it("runs from voice quote and price correction to paid, with a reported receipt in between", async () => {
    const clock = { t: now };
    const h = harness(clock);
    await h.activate();
    const state = (jid: string) =>
      h.store.db
        .prepare(
          "SELECT approval_state a FROM intents WHERE recipient=? ORDER BY rowid",
        )
        .all(jid)
        .map((r) => (r as { a: string }).a);

    // Ana: typed breakdown with a thousands separator.
    await h.chat(
      ana,
      true,
      "Te queda así:\nBalatas delanteras $800\nMano de obra $400\nTotal $1,200",
    );
    await h.chat(ana, false, "Va, dale 👍 ¿Cómo te pago?");
    expect(h.sent(/\$1,200\.00 MXN/)).toHaveLength(1);
    clock.t += 1000;
    await h.product("Sí");
    expect(state(ana)).toEqual(["APPROVED"]);
    expect(
      h.sent(
        /Listo ✅ Le envié a Ana el cobro de \$1,200\.00\. Aún no está pagado/,
      ),
    ).toHaveLength(1);
    const [anaQr] = [...h.pey.charges.keys()];
    h.pey.pay(anaQr!);
    // The pey webhook is what pays, not anything Ana says.
    expect(h.sent(/Recibiste/)).toHaveLength(0);

    // Luis: Rafa's quote is a voice note.
    clock.t += 1000;
    await h.chat(luis, false, "Rafa, ¿cuánto sale el servicio del Versa?");
    const voice = await transcribeVoice(
      {
        session: "MERCHANT",
        chatJid: luis,
        messageId: "voice-1",
        fromMe: true,
        at: clock.t,
      },
      Buffer.from("fake-opus"),
      "audio/ogg; codecs=opus",
      new FakeTranscriber(VOICE),
    );
    expect(voice).toMatchObject({ voice: "transcribed", text: VOICE });
    await h.chat(luis, true, voice.text, { voice: "transcribed" });
    await h.chat(luis, false, "Va, hazle 👍");
    clock.t += 1000;
    expect(h.sent(/\$1,500\.00 MXN/)).toHaveLength(1);

    // Rafa corrects the price before answering the agent.
    clock.t += 1000;
    await h.chat(
      luis,
      true,
      "Perdón Luis, me equivoqué: el aceite sintético sale en $1,000. Total $1,600",
    );
    await h.chat(luis, false, "Ah ok, no hay bronca. Va");
    expect(state(luis)).toEqual(["SUPERSEDED", "PROPOSED"]);
    const update = h.sent(/Actualicé el cobro de Luis/);
    expect(update).toHaveLength(1);
    expect(update[0]!.text).toMatch(
      /\$1,600\.00.*Aceite sintético \$1,000\.00 \+ filtro \$250\.00 \+ mano de obra \$350\.00.*Descarté la cotización anterior de \$1,500\.00; no se envió nada/i,
    );
    // A «Sí» typed before the update was shown cannot approve the new price.
    await h.product("Sí", { at: clock.t - 5000 });
    expect(state(luis)).toEqual(["SUPERSEDED", "PROPOSED"]);
    clock.t += 1000;
    await h.product("Sí");
    expect(state(luis)).toEqual(["SUPERSEDED", "APPROVED"]);
    expect([...h.pey.charges.values()].map((c) => c.amountCents)).toEqual([
      120000, 160000,
    ]);

    // Luis sends a receipt photo: reported, never paid.
    await h.chat(luis, false, "Listo, ya te pagué. Ahí va el comprobante", {
      imageRef: "receipt",
    });
    expect(h.sent(/reportado/)).toHaveLength(1);
    expect(h.sent(/Recibiste \$1600/)).toHaveLength(0);
    const luisQr = [...h.pey.charges.keys()][1]!;
    h.pey.pay(luisQr);
    for (const qr of [anaQr!, luisQr]) {
      const tx = [...h.pey.transactions.values()].find(
        (t) => t.payableId === qr,
      )!;
      h.c.saveWebhook("wh-" + tx.id, {
        type: "codi.qr.payment_received",
        transactionId: tx.id,
        codiQrId: qr,
        bankAccountId: [...h.pey.accounts.keys()][0],
        apiKeyId: "key",
      });
    }
    await h.runtime.step();
    expect(h.sent(/Recibiste \$1,200\.00 de Ana/)).toHaveLength(1);
    expect(h.sent(/Recibiste \$1,600\.00 de Luis/)).toHaveLength(1);
    await h.product("¿Cómo voy hoy?");
    const summary = h.sent(/Cobros de hoy/).at(-1)!.text;
    expect(summary.split("\n").slice(1)).toEqual([
      "*Cobros de hoy*",
      "✅ Ana · $1,200.00",
      "✅ Luis · $1,600.00",
      "Cotización anterior de Luis ($1,500.00): descartada, no se envió",
      "*Confirmado por pey: $2,800.00*",
      "Pendiente por cobrar: $0.00",
    ]);
  });
});
