# Ejecutar el servicio

## Preparar Node y la configuración

1. Usa Node 24.22.2 con `nvm use` y ejecuta `npm ci`.
2. Copia `.env.example` a un archivo privado fuera del repositorio. Completa los valores.
3. Genera `SESSION_ENCRYPTION_KEY` con `openssl rand -hex 32`. Conserva esa clave junto con los respaldos, en un lugar separado.
4. Define `MERCHANT_JID` con el WhatsApp del comerciante (`SELF_JID` sigue aceptándose como alias) y `PRODUCT_JID` con el número dedicado del producto; deben ser distintos. Los clientes se eligen por chat con el producto («agrega a Ana 5215550000002»); `ALLOWED_CHAT_JIDS` es solo una lista inicial opcional. `OPENAI_API_KEY` es opcional: sin ella se usa el extractor determinista en español.
5. Configura en el portal de pey el webhook `https://tu-dominio/webhooks/pey`. Usa su secreto `whsec_` y el `PEY_API_KEY_ID` esperado. El ID no es la clave secreta.
6. Pon un proxy HTTPS delante del servicio. `PUBLIC_BASE_URL` declara ese dominio; el proceso escucha HTTP en `HOST` y `PORT`.

Las claves por sí solas no completan el arranque. También hacen falta identidad, chats permitidos, secreto del webhook, ID de la API key y directorio persistente. `OPENAI_MODEL` usa `gpt-4.1-mini` por defecto y se puede cambiar por un modelo compatible con Responses y salida estructurada.

`DATA_DIR` contiene SQLite y la sesión cifrada. No compartas ese directorio entre comerciantes. El bloqueo de proceso evita abrirlo desde dos servicios a la vez. Tras una caída abrupta, el bloqueo puede tardar hasta 30 segundos en vencer.

## Arrancar y vincular WhatsApp

```bash
npm run build
node --env-file=/ruta/privada/pey.env dist/src/app.js
```

Hay dos sesiones y cada una imprime su propio QR privado: `PRODUCT` (número del producto, `whatsapp-product.enc`) y `MERCHANT` (WhatsApp del comerciante, `whatsapp.enc`). Escanea cada QR desde el teléfono correspondiente. No lo publiques ni lo guardes en logs compartidos.

Cada sesión verifica que su número coincide con la configuración. La sesión `PRODUCT` envía una comprobación al comerciante con un ID reservado y solo después de confirmarla habilita comandos; conserva los recibidos durante la comprobación. Todo el control (alta, propuestas, «Sí», avisos) ocurre en el chat entre el comerciante y el número del producto, nunca en el chat del comerciante consigo mismo. La sesión `MERCHANT` lee solo los chats de clientes elegidos y envía solo cobros autorizados; nada que lea ahí es un comando.

El servicio lee únicamente los chats configurados. Un mensaje de un cliente nunca autoriza un cobro. Un texto del comerciante en el chat de un cliente aporta contexto, pero tampoco autoriza. Las notas de voz quedan fuera de esta entrega.

`GET /health` confirma que el proceso HTTP responde. No certifica que WhatsApp esté conectado ni que la cuenta de pey esté activa.

## Dar de alta la cuenta y cobrar

Escribe «hola» al número del producto. El agente pregunta alias, nombre legal, CLABE y tipo de persona, muestra la CLABE enmascarada y advierte que la activación puede tardar hasta cinco días hábiles. Solo registra la cuenta tras «Sí, autorizo». Atajo equivalente:

```text
ALTA Taller | Nombre legal del titular | CLABE de 18 dígitos | PERSON
Sí, autorizo
```

`BUSINESS` identifica una empresa. El primer mensaje solo prepara una confirmación con CLABE enmascarada. El segundo registra la cuenta. Una cuenta `PENDING` no puede cobrar; la activación puede tardar hasta cinco días hábiles. El servicio consulta el estado cada minuto y también procesa el webhook de activación.

En un chat permitido, escribe la cotización con partidas, total y monto que pides ahora. Cuando el cliente acepte, el extractor espera unos 30 segundos tras el último mensaje y propone el cobro en privado. Responde `SI código` o cita esa propuesta con `sí`. Un `sí` sin código ni cita no envía nada.

Si llega otro texto al chat del cliente después de la propuesta, se suspenden los cobros pendientes de ese chat antes de esperar al modelo. La siguiente propuesta necesita otro código. Esta regla conservadora también puede pedir otra aprobación tras un mensaje que no cambie el precio, sea del comerciante o del cliente.

Para dictar un cobro sin IA:

```text
COBRAR 5215555555556@s.whatsapp.net | Reparación de frenos | 600 | 1200
```

El último valor es el total de la orden, o `UNKNOWN`. El comando prepara una propuesta; todavía debes responder `SI código`. Usa una sola cuenta activa por comerciante en este MVP.

## Continuar una orden

El mensaje de propuesta muestra el ID de la orden. Úsalo en estos comandos:

| Comando | Resultado |
|---|---|
| `SALDO orden importe` | Propone un cobro de saldo con aprobación propia |
| `EFECTIVO orden importe` | Registra efectivo indicado por el dueño y muestra el saldo separado |
| `TOTAL orden importe` | Cambia el total si coincide con las partidas; en caso contrario pide corregir el desglose |
| `TOTAL orden UNKNOWN` | Marca el total como desconocido |
| `NO código` | Rechaza esa propuesta |
| `REPROPONER código` | Genera un código nuevo tras fallo, creación incierta, rechazo o vencimiento |
| `NUEVA chat` | Empieza otro trabajo en ese chat y descarta el contexto de extracción anterior |
| `AYUDA` | Muestra los comandos |

Antes de cotizar un trabajo distinto al mismo cliente, usa `NUEVA chat`. El servicio conserva las órdenes, pagos y IDs de eventos anteriores. El nuevo contexto no reutiliza sus saldos.

Una captura del cliente queda reportada y no cambia el saldo. Los pagos confirmados por pey y el efectivo registrado se muestran por separado. Una orden con total desconocido nunca aparece liquidada.

## Revisar resultados inciertos

Una creación de QR con timeout no se repite. `REPROPONER código` solicita otra aprobación y conserva el caso anterior para revisión. No se supone que pey canceló el primer QR.

Una entrega sin confirmación no se reenvía. Un eco posterior con el ID y destinatario reservados puede confirmarla. Un alta de cuenta incierta queda en revisión para evitar registrar la misma CLABE otra vez.

Las transacciones con receptor, moneda, tipo o monto incompatibles no se suman. Un segundo pago distinto al mismo QR se suma una sola vez como dinero recibido y queda marcado para revisión. El sobrepago permanece visible.

La consulta periódica de transacciones detecta posibles webhooks perdidos. Ese hallazgo abre una revisión y avisa al dueño; no inventa una firma ni marca el pago como verificado. Reenvía la entrega original desde el portal de pey para completar la comprobación.

Si OpenAI devuelve falta de saldo, el proceso avisa una vez y permite usar `COBRAR`. Tras recargar, reinicia el proceso para reactivar la extracción. Los errores transitorios se vuelven a consultar después de 30 segundos.

## Respaldar y restaurar

Detén el servicio antes del respaldo para conservar una sesión y base coherentes.

```bash
SESSION_ENCRYPTION_KEY=… npm run backup -- /ruta/data /ruta/respaldo-nuevo
SESSION_ENCRYPTION_KEY=… npm run backup -- --verify /ruta/respaldo-nuevo
```

La herramienta usa el respaldo SQLite, incluye `whatsapp.enc` si existe y exige un directorio de destino nuevo. Los almacenes de Whatsmeow (`*-wa.db`) solo se guardan cifrados como `*.enc`; sin `SESSION_ENCRYPTION_KEY` el respaldo se niega, y la verificación rechaza copias sin cifrar. No copia la clave. La prueba automatizada restaura y descifra el contenido. Ver [cifrado en reposo](cifrado-en-reposo.md).

Para restaurar, con el servicio detenido:

```bash
SESSION_ENCRYPTION_KEY=… npm run backup -- --restore /ruta/respaldo /ruta/data-vacío
```

El destino debe estar vacío. Configura ese directorio como `DATA_DIR` y conserva la misma clave e identidad. No sobrescribas una base activa.

## Ejecutar el contenedor

```bash
docker build -t pey-hackathon:mvp .
docker run --rm -it --name pey-mvp \
  --env-file /ruta/privada/pey.env \
  -e DATA_DIR=/data -e HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 -v pey-data:/data \
  pey-hackathon:mvp
```

El contenedor corre como usuario sin privilegios. Usa un volumen propio y un proxy HTTPS. La construcción local del contenedor no despliega ningún servicio público.

## A qué cobro se liga un «Sí»

Un «Sí» o «No» sin código solo se liga a un cobro cuya propuesta ya se te entregó. La app registra cuándo el servidor confirmó la entrega de cada propuesta (`prompt_seen`) y compara ese momento con la hora de tu mensaje. Si tu «Sí» salió antes de ver la propuesta vigente, por ejemplo porque el precio cambió mientras respondías, no autoriza nada y la app te pide responder otra vez. Si dos clientes esperan y viste ambos, la app pregunta cuál. Si no se pudo confirmar la entrega, el «Sí» se rechaza. Citar el mensaje de la propuesta o escribir `SI CÓDIGO` sigue identificando un cobro exacto. La hora del mensaje llega con precisión de segundos, así que una respuesta humana siempre queda después de la entrega.

## Notas de voz

Con `TRANSCRIPTION_PROVIDER=openai` y `OPENAI_API_KEY`, las notas de voz de los chats de clientes que lee la sesión del comerciante se transcriben en el servidor y se tratan como texto (por ejemplo, Rafa cotiza por audio y Luis acepta por escrito). El audio no se guarda: se descarga en memoria, se manda al proveedor y se descarta. Un audio de más de unos 600 KB no se transcribe. Si no hay proveedor, la transcripción falla o llega vacía, la app avisa «No pude transcribir una nota de voz» y no propone nada: escribe el precio en el chat.

Las notas de voz en el chat con el número del producto nunca autorizan un cobro ni dan de alta datos, aunque la transcripción diga «Sí». Para autorizar escribe «Sí».

El extractor sin OpenAI entiende separadores de miles («$1,200»), decimales, desgloses en varias líneas y correcciones del estilo «me equivoqué, el aceite sale en $1,000. Total $1,600», que descartan la propuesta anterior sin enviarla.

## Resumen del día

Escribe «resumen», «¿cómo voy?» o «cobros de hoy» al número del producto. La respuesta separa lo confirmado por pey de lo que sigue pendiente y de lo descartado:

```text
*Cobros de hoy*
✅ Ana · $1,200.00
✅ Luis · $1,600.00
Cotización anterior de Luis ($1,500.00): descartada, no se envió
*Confirmado por pey: $2,800.00*
Pendiente por cobrar: $0.00
```

Un comprobante en foto aparece como 📎 «reportado» y no suma a lo confirmado. «Hoy» es el día local de `SUMMARY_TIMEZONE` (por defecto `America/Mexico_City`) según cuándo se te mostró cada propuesta; lo que sigue abierto aparece aunque sea de otro día. Con `SUMMARY_HOUR=20` la app además lo envía una vez al día después de las 20:00 si hay algo que decir.
