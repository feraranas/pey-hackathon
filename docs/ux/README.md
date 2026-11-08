# Flujo en pantallas de WhatsApp

> **Maqueta ilustrativa.** Ninguna pantalla es una captura real. Personas, negocio, CLABE y montos son ficticios. Los enlaces usan dominios reservados (`cobro.example`, `example.invalid`) y todos los pagos son simulados. No es la interfaz oficial de WhatsApp ni de pey, y no se conectó ninguna cuenta ni se envió ningún mensaje.

![Resumen de las 16 pantallas](mockups/overview.png)

## Cómo leerlo

- **Perspectiva:** todo se ve desde el teléfono de **Rafa** (Taller de Rafa). La pantalla 08 es la única excepción: muestra lo que ve Ana al abrir el enlace.
- **«Mi agente (tú)»** es el chat de Rafa consigo mismo, guardado con ese nombre. No es una función nueva de WhatsApp. Como el MVP usa una sola sesión, los mensajes de Rafa y los del agente salen de la misma cuenta y **ambos aparecen en verde**. Por eso cada mensaje del agente empieza con «🤖 Agente de cobros». Un número propio para el agente no está implementado; queda como evolución.
- **En los chats con clientes**, todo lo que sale de la cuenta de Rafa es verde, lo escriba él o el agente. Los mensajes que envía el agente empiezan con «🤖 Cobro de Taller de Rafa». Ana y Luis aparecen en blanco.
- **Permiso:** el agente propone en privado y solo envía con «Sí <código>» o citando la propuesta. Cada código (A17, B18, B19) fija cliente, partidas y monto. Lo que escriba un cliente nunca autoriza un envío.
- **Enviado no es pagado** y **comprobante no es pago**. Solo un aviso de pey verificado se cuenta como pago confirmado.

## Capítulos

| Capítulo | Pantallas | Qué muestra |
|---|---|---|
| [1 · Alta (precondición)](mockups/storyboard-1.png) | 01–03 | Chats elegidos, registro de la CLABE y activación días después |
| [2 · Ana](mockups/storyboard-2.png) | 04–08 | Desglose en el chat, propuesta privada A17, «Sí A17», enlace y página con el QR |
| [3 · Luis](mockups/storyboard-3.png) | 09–13 | Nota de voz, propuesta B18, corrección de precio, B19 con nuevo permiso y comprobante del cliente |
| [4 · Confirmaciones](mockups/storyboard-4.png) | 14–16 | Comprobante reportado, confirmación de pey, resumen del día y cierre de Rafa |

Montos que cuadran en todo el flujo: Ana A17 $1,200 (800 + 400). Luis B19 $1,600 (1,000 + 250 + 350), que sustituye a B18 de $1,500 sin que B18 se haya enviado. Confirmado por pey: $2,800; pendiente: $0.

## Pantallas

| # | Archivo | Qué pasa |
|---|---|---|
| 01 | [lista de chats](mockups/01-lista-de-chats-de-rafa.png) | El agente solo lee «Mi agente (tú)», Ana y Luis |
| 02 | [alta: datos](mockups/02-alta-rafa-comparte-sus-datos.png) | Cuatro datos y aceptación explícita (CLABE enmascarada) |
| 03 | [alta: activación](mockups/03-alta-enviada-dias-despues-cuenta-activa.png) | «Puede tardar hasta 5 días hábiles»; la demo parte de una cuenta ya activa |
| 04 | [Ana: desglose](mockups/04-rafa-le-da-el-desglose-a-ana.png) | Rafa cotiza como siempre y Ana acepta |
| 05 | [propuesta A17](mockups/05-el-agente-propone-el-cobro-en-privado.png) | Propuesta proactiva, pero solo con desglose, total y aceptación |
| 06 | [«Sí A17»](mockups/06-rafa-autoriza-a17-citando-la-propuesta.png) | Respuesta citada; «aún no está pagado» |
| 07 | [Ana recibe el enlace](mockups/07-ana-recibe-el-enlace-con-el-desglose.png) | Mensaje automático con el desglose y el enlace |
| 08 | [página del QR](mockups/08-ana-abre-el-enlace-pagina-con-el-qr-demo.png) | Página propia planeada; QR de demo no pagable |
| 09 | [Luis: nota de voz](mockups/09-rafa-le-cotiza-a-luis-con-nota-de-voz.png) | La cotización llega por audio |
| 10 | [pago de Ana + B18](mockups/10-pago-de-ana-confirmado-propuesta-b18-para-luis.png) | Los pagos llegan de forma independiente; el agente muestra lo que entendió del audio |
| 11 | [corrección](mockups/11-rafa-corrige-el-precio-con-luis.png) | Rafa corrige el aceite a $1,000 |
| 12 | [B18 → B19](mockups/12-b18-se-cancela-rafa-autoriza-b19.png) | Se cancela lo anterior y el nuevo código pide su propio «sí» |
| 13 | [B19 y comprobante](mockups/13-luis-recibe-b19-y-manda-un-comprobante.png) | El cliente manda una captura (ficticia) |
| 14 | [comprobante reportado](mockups/14-comprobante-recibido-queda-como-reportado.png) | Queda como reportado, no como pagado |
| 15 | [confirmación y resumen](mockups/15-pey-confirma-a-luis-resumen-del-dia.png) | pey confirma; el resumen separa lo confirmado de lo cancelado |
| 16 | [cierre](mockups/16-rafa-le-agradece-a-luis.png) | Rafa escribe él mismo; el agente no inicia conversaciones con clientes |

## El enlace `cobro.example`: página propia, no link de pey

Rafa pidió mandar un **enlace** de pago. El link hospedado de pey (`POST /payment-link/create`) no acepta `bankAccountId`, así que no puede dirigir el dinero a la CLABE de cada comerciante ([integraciones](../integraciones.md#link-de-pago-hospedado-sin-paridad-fuera-del-mvp)). La maqueta propone una **página propia, pequeña y de solo lectura**: `https://<dominio>/c/<código>` muestra el desglose y el **QR que pey creó con `bankAccountId` explícito**. El enlace no crea cobros ni guarda datos del cliente. Ver [diseño](../diseno.md#8b-página-de-cobro-opcional).

Falta probarlo: cómo paga el cliente un QR que abre **en su mismo teléfono** depende de su banco. La pantalla 08 lo dice tal cual y no promete que funcione en todos.

## Regenerar

```bash
python3 -m venv /tmp/mockvenv && /tmp/mockvenv/bin/pip install pillow qrcode
/tmp/mockvenv/bin/python docs/ux/render_mockups.py                 # PNG en docs/ux/mockups/
/tmp/mockvenv/bin/python docs/ux/render_mockups.py --zip /tmp/pey-whatsapp-mockups.zip
```

- [`screens.json`](screens.json) es la única fuente del texto de cada pantalla y de sus pies de foto.
- [`render_mockups.py`](render_mockups.py) dibuja con Pillow, a 2× (786 × 1704 px, proporción de 393 × 852 pt). Usa Inter y Noto Color Emoji; las rutas se cambian con `MOCKUP_FONT` y `MOCKUP_EMOJI_FONT`.
- El script ajusta el texto automáticamente y **falla** si el contenido de una pantalla no cabe, en vez de cortarlo.
