# Demo para jueces: la historia de Rafa, Ana y Luis en un comando

Esta demo corre el producto real contra un sandbox local de pey. No toca WhatsApp ni mueve dinero. Cada paso se comprueba automáticamente; si una comprobación falla, el comando termina con error.

## Ejecutarla

Requiere Node 24.

```bash
npm ci
npm run demo:story        # la historia completa, con transcripción y comprobaciones
npm run local             # lo mismo, pero tú escribes como Rafa y como sus clientes
npm run verify            # formato, tipos, pruebas, demos y enlaces
```

`npm run demo:story` tarda un par de segundos y termina con `Historia completa: 17 comprobaciones correctas.`

## Qué es real y qué es simulado

| Pieza | En la demo |
|---|---|
| Coordinador, máquinas de estado, base SQLite cifrada, runtime, servidor de webhooks, cliente de pey | Código real del repositorio |
| API de pey | Sandbox local (`src/pey-sandbox.ts`) que firma webhooks con Standard Webhooks y se consulta por HTTP real |
| Sesiones de WhatsApp (producto y comerciante) | Simuladas. El sidecar de Whatsmeow y el adaptador existen y están probados, pero vincular un número real necesita escanear un QR |
| Nota de voz | Transcriptor falso con el texto del audio de la historia. El proveedor real está detrás de `TRANSCRIPTION_PROVIDER=openai` |
| Dinero | Ninguno. El «pago» lo dispara el sandbox |

## Lo que se ve

1. **Alta.** Rafa escribe al número del producto, da alias, nombre legal, CLABE y tipo de persona, y responde «Sí, autorizo». pey no se contacta antes de esa autorización y el agente avisa que la activación puede tardar hasta cinco días hábiles.
2. **Ana.** Rafa le da el desglose en su chat y Ana acepta. El agente propone el cobro a Rafa en el chat del producto. El «Sí» de Rafa envía un solo QR a Ana desde el WhatsApp de Rafa. El webhook firmado de pey paga una vez; repetirlo no duplica nada.
3. **Luis.** Rafa cotiza por nota de voz ($1,500). El agente la transcribe y propone el cobro. Rafa se equivoca y corrige a $1,600: la propuesta anterior se descarta sin enviarse. Un «Sí» de Luis no autoriza nada. El «Sí» de Rafa se liga a la propuesta vigente de $1,600.
4. **Comprobante y resumen.** La foto de Luis queda como *reportado* y el resumen no la cuenta como dinero. Solo el webhook verificado de pey marca el pago. El resumen final cuadra: $1,200 + $1,600 = $2,800 confirmado, $0 pendiente.

## Salida real

```text
SIMULACIÓN LOCAL. Sin WhatsApp ni dinero reales. Cada ✔ es una comprobación automática.

── 1 · Alta ──
Rafa → Agente: hola
   Agente → Rafa: ¡Hola! Soy el Agente de cobros. Voy a leer solo los chats de clientes que tú elijas y enviaré cobros únicamente cuando tú los autorices aquí. Para registrar tu cuenta de cobro en pey necesito cuatro datos. ¿Con qué alias quieres identificar tu cuenta? Por ejemplo, «Taller Rafa».
Rafa → Agente: Taller de Rafa
   Agente → Rafa: ¿Cuál es tu nombre legal completo, tal como aparece en tu cuenta bancaria?
Rafa → Agente: Rafael Ortiz
   Agente → Rafa: Escribe tu CLABE de 18 dígitos. Solo se registra tras tu autorización.
Rafa → Agente: 646180157034432952
   Agente → Rafa: ¿Eres persona física o persona moral? Responde «física» o «moral».
Rafa → Agente: física
   Agente → Rafa: Confirma tus datos: Taller de Rafa · Rafael Ortiz · CLABE ****2952 · persona física. Declaro ser titular de esta cuenta y autorizo su registro en pey para recibir cobros CoDi. Acepto los términos de pey (v2026-10-13). La activación puede tardar hasta cinco días hábiles. Responde «Sí, autorizo» para registrar la cuenta.
   ✔ pey no se contacta hasta que Rafa autoriza
Rafa → Agente: Sí, autorizo
   Agente → Rafa: Cuenta registrada en pey. La activación puede tardar hasta cinco días hábiles; te aviso cuando esté activa. Mientras tanto agrega los clientes cuyos chats quieres que lea, por ejemplo «agrega a Ana 5215550000002».
   ✔ la cuenta se registra en pey y avisa de los 5 días hábiles
   (pey activa la cuenta: simulado, en la realidad tarda hasta 5 días hábiles)
Rafa → Agente: agrega a Ana 5215550000002
   Agente → Rafa: Estado de cuenta ACTIVE. Ya puedes cobrar: cuando acuerdes un precio con un cliente de tu lista, te pregunto aquí si le envío el cobro.
   Agente → Rafa: Listo: leeré el chat con Ana. Solo propondré cobros cuando ese cliente acuerde un precio contigo.
Rafa → Agente: agrega a Luis 5215550000003
   Agente → Rafa: Listo: leeré el chat con Luis. Solo propondré cobros cuando ese cliente acuerde un precio contigo.
   ✔ solo Ana y Luis son chats leídos

── 2 · Ana: desglose, «Sí» y pago ──
Rafa → chat con Ana: Te queda así: / Balatas delanteras $800 / Mano de obra $400 / Total $1,200
Ana → chat con Ana: Va, dale 👍 ¿Cómo te pago?
   Agente → Rafa: ¿Le envío a Ana el cobro de $1,200.00 MXN (pago total)? Balatas delanteras $800.00 + Mano de obra $400.00. Total $1,200.00. Responde Sí o No.
   ✔ el agente propone $1,200.00 a Rafa
   ✔ todavía no se envió nada a Ana
Rafa → Agente: Sí
   WhatsApp de Rafa → Ana: [QR de pey] 🤖 Cobro automático
      FULL: Balatas delanteras $800.00 + Mano de obra $400.00. Total $1,200.00. QR $1,200.00 MXN. Paga desde tu app bancaria con CoDi.
   Agente → Rafa: Listo ✅ Le envié a Ana el cobro de $1,200.00. Aún no está pagado: te aviso cuando pey confirme el pago.
   ✔ el «Sí» de Rafa crea y envía un solo QR a Ana
   ✔ Rafa recibe «aún no está pagado»
   Agente → Rafa: Recibiste $1,200.00 de Ana (verificado por pey). Verificado $1,200.00 · efectivo registrado $0.00 · falta $0.00.
   ✔ el webhook de pey firmado paga a Ana una sola vez
   ✔ repetir el webhook no duplica el aviso ni el pago

── 3 · Luis: nota de voz, corrección y «Sí» ──
Luis → chat con Luis: Rafa, ¿cuánto sale el servicio del Versa?
   🎙️ Rafa manda una nota de voz (0:19); el servidor la transcribe
Rafa → chat con Luis: Aceite sintético $900, filtro $250, mano de obra $350. Total $1,500.
Luis → chat con Luis: Va, hazle 👍
   Agente → Rafa: ¿Le envío a Luis el cobro de $1,500.00 MXN (pago total)? Aceite sintético $900.00 + filtro $250.00 + mano de obra $350.00. Total $1,500.00. Responde Sí o No.
   ✔ el agente entiende la nota de voz y propone $1,500.00
Rafa → chat con Luis: Perdón Luis, me equivoqué: el aceite sintético sale en $1,000. Total $1,600
Luis → chat con Luis: Ah ok, no hay bronca. Va
   Agente → Rafa: Actualicé el cobro de Luis a $1,600.00 MXN (pago total): Aceite sintético $1,000.00 + filtro $250.00 + mano de obra $350.00. Total $1,600.00. Descarté la cotización anterior de $1,500.00; no se envió nada. ¿Se lo envío? Responde Sí o No.
   ✔ la corrección descarta la propuesta de $1,500 sin enviar nada
Luis → chat con Luis: Sí, mándame el cobro
   Agente → Rafa: ¿Le envío a Luis el cobro de $1,600.00 MXN (pago total)? Aceite sintético $1,000.00 + filtro $250.00 + mano de obra $350.00. Total $1,600.00. Responde Sí o No.
   ✔ el «Sí» de un cliente no autoriza nada
Rafa → Agente: Sí
   WhatsApp de Rafa → Luis: [QR de pey] 🤖 Cobro automático
      FULL: Aceite sintético $1,000.00 + filtro $250.00 + mano de obra $350.00. Total $1,600.00. QR $1,600.00 MXN. Paga desde tu app bancaria con CoDi.
   Agente → Rafa: Listo ✅ Le envié a Luis el cobro de $1,600.00. Aún no está pagado: te aviso cuando pey confirme el pago.
   ✔ el «Sí» de Rafa se liga a $1,600.00 y envía un solo QR

── 4 · Comprobante, pago y resumen ──
Luis → chat con Luis: Listo, ya te pagué. Ahí va el comprobante
   Agente → Rafa: Comprobante de Luis reportado, pendiente de verificar. No cuenta como pagado hasta que pey lo confirme.
   ✔ la foto queda «reportada», no pagada
Rafa → Agente: resumen
   Agente → Rafa: *Cobros de hoy*
      ✅ Ana · $1,200.00
      📎 Luis · $1,600.00 · comprobante reportado, esperando a pey
      Cotización anterior de Luis ($1,500.00): descartada, no se envió
      *Confirmado por pey: $1,200.00*
      Pendiente por cobrar: $1,600.00
   ✔ el resumen no cuenta el comprobante como dinero
   Agente → Rafa: Recibiste $1,600.00 de Luis (verificado por pey). Verificado $1,600.00 · efectivo registrado $0.00 · falta $0.00.
   ✔ solo el webhook verificado de pey marca a Luis como pagado
Rafa → Agente: ¿Cómo voy hoy?
   Agente → Rafa: *Cobros de hoy*
      ✅ Ana · $1,200.00
      ✅ Luis · $1,600.00
      Cotización anterior de Luis ($1,500.00): descartada, no se envió
      *Confirmado por pey: $2,800.00*
      Pendiente por cobrar: $0.00
   ✔ el resumen cuadra: $1,200 + $1,600 = $2,800 confirmado, $0 pendiente

Historia completa: 17 comprobaciones correctas.
```

## Qué demuestra cada regla

| Regla | Dónde se prueba |
|---|---|
| Solo el número del producto controla; nunca el chat propio | `test/conversation.test.ts` |
| Un «Sí» se liga a la propuesta que Rafa ya vio, no a una que llegó mientras respondía | `test/binding.test.ts` |
| Un cambio de precio invalida la propuesta y exige un nuevo «Sí» | `test/story.test.ts`, `test/binding.test.ts` |
| El «Sí» de un cliente o una nota de voz nunca autorizan | `test/story.test.ts`, `test/voice.test.ts` |
| Una foto de comprobante es *reportado*, nunca pagado | `test/core.test.ts`, `test/story.test.ts`, `test/summary.test.ts` |
| Solo un webhook firmado y verificado paga; repeticiones y orden inverso son seguros | `test/core.test.ts`, `test/webhook-order.test.ts`, `test/server.test.ts`, `test/e2e.test.ts` |
| Los reintentos inciertos van a revisión, no se repiten a ciegas | `test/core.test.ts`, `test/sidecar.test.ts` |

## Lo que falta para cobrar de verdad

Ver [Entrega](entrega.md): credenciales de pey, cuenta bancaria activa, QR de cada número de WhatsApp y acceso a la VPS.
