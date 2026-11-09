# Ejecutar el servicio

## Preparar Node y la configuración

1. Usa Node 24.22.2 con `nvm use` y ejecuta `npm ci`.
2. Copia `.env.example` a un archivo privado fuera del repositorio. Completa los valores.
3. Genera `SESSION_ENCRYPTION_KEY` con `openssl rand -hex 32`. Conserva esa clave junto con los respaldos, en un lugar separado.
4. Define `SELF_JID` con el número de WhatsApp del comerciante. Define `ALLOWED_CHAT_JIDS` con los chats individuales autorizados, separados por comas.
5. Configura en el portal de pey el webhook `https://tu-dominio/webhooks/pey`. Usa su secreto `whsec_` y el `PEY_API_KEY_ID` esperado. El ID no es la clave secreta.
6. Pon un proxy HTTPS delante del servicio. `PUBLIC_BASE_URL` declara ese dominio; el proceso escucha HTTP en `HOST` y `PORT`.

Las claves por sí solas no completan el arranque. También hacen falta identidad, chats permitidos, secreto del webhook, ID de la API key y directorio persistente. `OPENAI_MODEL` usa `gpt-4.1-mini` por defecto y se puede cambiar por un modelo compatible con Responses y salida estructurada.

`DATA_DIR` contiene SQLite y la sesión cifrada. No compartas ese directorio entre comerciantes. El bloqueo de proceso evita abrirlo desde dos servicios a la vez. Tras una caída abrupta, el bloqueo puede tardar hasta 30 segundos en vencer.

## Arrancar y vincular WhatsApp

```bash
npm run build
node --env-file=/ruta/privada/pey.env dist/src/app.js
```

Escanea el QR de vinculación que aparece en la terminal desde el teléfono configurado. Ese QR es privado. No lo publiques ni lo guardes en logs compartidos.

El servicio verifica que el número de la sesión coincide con `SELF_JID`. Envía una comprobación al chat del dueño con un ID reservado. Solo después de confirmar ese ID habilita comandos; conserva los comandos recibidos durante esa comprobación para procesarlos después. En una reconexión vuelve a comprobarlo. Los alias LID descubiertos se guardan para reconocer el chat propio.

El servicio lee únicamente los chats configurados. Un mensaje de un cliente nunca autoriza un cobro. Un texto del comerciante en el chat de un cliente aporta contexto, pero tampoco autoriza. Las notas de voz quedan fuera de esta entrega.

`GET /health` confirma que el proceso HTTP responde. No certifica que WhatsApp esté conectado ni que la cuenta de pey esté activa.

## Dar de alta la cuenta y cobrar

Escribe los comandos en el chat contigo mismo. Sustituye los ejemplos por tus datos reales.

```text
ALTA Taller | Nombre legal del titular | CLABE de 18 dígitos | PERSON
ACEPTO código-recibido
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
npm run backup -- /ruta/data /ruta/respaldo-nuevo
```

La herramienta usa el respaldo SQLite, incluye `whatsapp.enc` si existe y exige un directorio de destino nuevo. No copia la clave de cifrado. La prueba automatizada restaura y descifra el contenido de un respaldo.

Para restaurar, con el servicio detenido copia los archivos del respaldo a un directorio vacío, configura ese directorio como `DATA_DIR` y conserva la misma clave e identidad. No sobrescribas una base activa.

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
