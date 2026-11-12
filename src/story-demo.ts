import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startLocal } from "./local.js";
import { FakeTranscriber, transcribeVoice } from "./transcription.js";

const VOICE_NOTE =
  "Aceite sintético $900, filtro $250, mano de obra $350. Total $1,500.";

/**
 * Replays the Rafa, Ana and Luis story (docs/ux) against the local product:
 * real coordinator, runtime, webhook server and pey client, talking over HTTP
 * to a pey sandbox, with simulated WhatsApp. Every step is checked, so a green
 * run is proof, not a recording. Nothing reaches WhatsApp or moves money.
 */
export async function runStory(print: (line: string) => void = console.log) {
  const app = await startLocal({ debounceMs: 0 });
  try {
    return await playStory(app, print);
  } finally {
    await app.stop();
  }
}

async function playStory(
  app: Awaited<ReturnType<typeof startLocal>>,
  print: (line: string) => void,
) {
  let checks = 0;
  const check = (label: string, condition: unknown) => {
    assert.ok(condition, label);
    checks++;
    print(`   ✔ ${label}`);
  };
  const nameOf = (jid: string) =>
    app.coordinator.clientLabel(jid) === jid.split("@")[0]
      ? "Rafa"
      : app.coordinator.clientLabel(jid);
  let printed = 0;
  const flush = () => {
    for (const d of app.whatsapp.deliveries.slice(printed)) {
      const to = nameOf(d.recipientJid);
      const body = d.text.replace(/^🤖 Agente de cobros\n/, "");
      print(
        d.channel === "PRODUCT"
          ? `   Agente → Rafa: ${body.replace(/\n/g, "\n      ")}`
          : `   WhatsApp de Rafa → ${to}: ${d.qrString ? "[QR de pey] " : ""}${body.replace(/\n/g, "\n      ")}`,
      );
    }
    printed = app.whatsapp.deliveries.length;
  };
  const sent = (re: RegExp) =>
    app.whatsapp.deliveries.filter((d) => re.test(d.text));
  const rafa = async (text: string) => {
    print(`Rafa → Agente: ${text}`);
    await app.merchantSays(text);
    flush();
    await sleep(5);
  };
  const chat = async (
    name: string,
    who: "merchant" | "client",
    text: string,
    photo?: string,
    extra: Parameters<typeof app.inClientChat>[4] = {},
  ) => {
    print(
      `${who === "merchant" ? "Rafa" : name} → chat con ${name}: ${text.replace(/\n/g, " / ") || "(foto del comprobante)"}`,
    );
    await app.inClientChat(name, who, text, photo, extra);
    flush();
    await sleep(5);
  };
  const unpaidQr = () =>
    [...app.sandbox.qrs.keys()].filter(
      (id) =>
        ![...app.sandbox.transactions.values()].some((t) => t.payableId === id),
    );
  const charges = () => [...app.sandbox.qrs.keys()].length;

  print(
    "SIMULACIÓN LOCAL. Sin WhatsApp ni dinero reales. Cada ✔ es una comprobación automática.\n",
  );
  print("── 1 · Alta ──");
  await rafa("hola");
  await rafa("Taller de Rafa");
  await rafa("Rafael Ortiz");
  await rafa("646180157034432952");
  await rafa("física");
  check("pey no se contacta hasta que Rafa autoriza", charges() === 0);
  await rafa("Sí, autorizo");
  check(
    "la cuenta se registra en pey y avisa de los 5 días hábiles",
    sent(/cinco días hábiles/).length > 0 &&
      sent(/Cuenta registrada en pey/).length === 1,
  );
  await app.activateAccounts();
  print(
    "   (pey activa la cuenta: simulado, en la realidad tarda hasta 5 días hábiles)",
  );
  await rafa("agrega a Ana 5215550000002");
  await rafa("agrega a Luis 5215550000003");
  check(
    "solo Ana y Luis son chats leídos",
    app.coordinator.listClients().length === 2,
  );

  print("\n── 2 · Ana: desglose, «Sí» y pago ──");
  await chat(
    "Ana",
    "merchant",
    "Te queda así:\nBalatas delanteras $800\nMano de obra $400\nTotal $1,200",
  );
  await chat("Ana", "client", "Va, dale 👍 ¿Cómo te pago?");
  check(
    "el agente propone $1,200.00 a Rafa",
    sent(/¿Le envío a Ana el cobro de \$1,200\.00/).length === 1,
  );
  check("todavía no se envió nada a Ana", charges() === 0);
  await rafa("Sí");
  check(
    "el «Sí» de Rafa crea y envía un solo QR a Ana",
    charges() === 1 && sent(/Cobro automático/).length === 1,
  );
  check(
    "Rafa recibe «aún no está pagado»",
    sent(/Aún no está pagado/).length === 1,
  );
  const anaQr = unpaidQr()[0]!;
  const anaPaid = await app.payQr(anaQr);
  flush();
  check(
    "el webhook de pey firmado paga a Ana una sola vez",
    sent(/Recibiste \$1,200\.00 de Ana/).length === 1,
  );
  await app.resendWebhook(anaPaid.webhookId as string);
  flush();
  check(
    "repetir el webhook no duplica el aviso ni el pago",
    sent(/Recibiste \$1,200\.00 de Ana/).length === 1,
  );

  print("\n── 3 · Luis: nota de voz, corrección y «Sí» ──");
  await chat("Luis", "client", "Rafa, ¿cuánto sale el servicio del Versa?");
  const voice = await transcribeVoice(
    {
      session: "MERCHANT",
      chatJid: app.coordinator.listClients().find((c) => c.name === "Luis")!
        .jid,
      messageId: "nota-de-voz",
      fromMe: true,
      at: Date.now(),
    },
    Buffer.from("audio-ficticio"),
    "audio/ogg; codecs=opus",
    new FakeTranscriber(VOICE_NOTE),
  );
  print("   🎙️ Rafa manda una nota de voz (0:19); el servidor la transcribe");
  await chat("Luis", "merchant", voice.text, undefined, {
    voice: "transcribed",
  });
  await chat("Luis", "client", "Va, hazle 👍");
  check(
    "el agente entiende la nota de voz y propone $1,500.00",
    sent(/¿Le envío a Luis el cobro de \$1,500\.00/).length === 1,
  );
  await chat(
    "Luis",
    "merchant",
    "Perdón Luis, me equivoqué: el aceite sintético sale en $1,000. Total $1,600",
  );
  await chat("Luis", "client", "Ah ok, no hay bronca. Va");
  check(
    "la corrección descarta la propuesta de $1,500 sin enviar nada",
    sent(/Descarté la cotización anterior de \$1,500\.00; no se envió nada/)
      .length === 1 && charges() === 1,
  );
  await chat("Luis", "client", "Sí, mándame el cobro");
  check("el «Sí» de un cliente no autoriza nada", charges() === 1);
  await rafa("Sí");
  check(
    "el «Sí» de Rafa se liga a $1,600.00 y envía un solo QR",
    charges() === 2 && sent(/QR \$1,600\.00 MXN/).length === 1,
  );

  print("\n── 4 · Comprobante, pago y resumen ──");
  await chat(
    "Luis",
    "client",
    "Listo, ya te pagué. Ahí va el comprobante",
    "comprobante-luis",
  );
  check(
    "la foto queda «reportada», no pagada",
    sent(/reportado/).length === 1 && sent(/Recibiste \$1,600/).length === 0,
  );
  await rafa("resumen");
  check(
    "el resumen no cuenta el comprobante como dinero",
    /📎 Luis · \$1,600\.00 · comprobante reportado/.test(
      sent(/Cobros de hoy/).at(-1)!.text,
    ) &&
      /Confirmado por pey: \$1,200\.00/.test(
        sent(/Cobros de hoy/).at(-1)!.text,
      ),
  );
  await app.payQr(unpaidQr()[0]!);
  flush();
  check(
    "solo el webhook verificado de pey marca a Luis como pagado",
    sent(/Recibiste \$1,600\.00 de Luis/).length === 1,
  );
  await rafa("¿Cómo voy hoy?");
  const summary = sent(/Cobros de hoy/)
    .at(-1)!
    .text.split("\n")
    .slice(1);
  assert.deepEqual(summary, [
    "*Cobros de hoy*",
    "✅ Ana · $1,200.00",
    "✅ Luis · $1,600.00",
    "Cotización anterior de Luis ($1,500.00): descartada, no se envió",
    "*Confirmado por pey: $2,800.00*",
    "Pendiente por cobrar: $0.00",
  ]);
  check(
    "el resumen cuadra: $1,200 + $1,600 = $2,800 confirmado, $0 pendiente",
    true,
  );

  print(`\nHistoria completa: ${checks} comprobaciones correctas.`);
  return checks;
}

if (
  process.argv[1]?.endsWith("/story-demo.ts") ||
  process.argv[1]?.endsWith("/story-demo.js")
)
  runStory().catch((error) => {
    console.error(
      "\nLa historia falló:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
