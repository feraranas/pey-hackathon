# Plan de implementación

> El MVP de texto ya está implementado. Consulta [evidencia, entrega y pendientes](verification/README.md). El contenido siguiente conserva el plan y la investigación originales.

Las estimaciones son orientativas, no medidas, para **una persona**. El total es de unas **6 h 40 min de construcción sin audio (7 h 10 min con audio), más 1 h de margen**, dentro de un plazo de menos de 18 horas. Si una integración se retrasa, se recortan funciones; **nunca** se recortan la autorización ligada, la propiedad de la cuenta, los centavos, la deduplicación ni el manejo de estados inciertos.

Prioridad: **texto primero**. El audio es opcional y se agrega solo si el camino de texto ya funciona de punta a punta.

## Stack

| Pieza | Elección | Motivo |
|---|---|---|
| Runtime | Node.js **24 LTS** (fijar en `.nvmrc`/`engines`) | LTS hasta abril de 2028; compatible con todos los paquetes elegidos ([detalle](integraciones.md#versiones-del-entorno)) |
| Lenguaje | TypeScript estricto | Tipos de dominio (`Centavos`, snapshots) como frontera |
| HTTP | Fastify | Webhook con cuerpo crudo para verificar la firma, más un healthcheck |
| WhatsApp | Baileys 7 (RC) | Sesión persistente vinculada al WhatsApp del comerciante |
| Base de datos | SQLite en WAL con `better-sqlite3` | Un archivo en un volumen, transacciones síncronas y cortas |
| IA | SDK de OpenAI con salida estructurada vía Zod; transcripción opcional | Extracción de hechos sin herramientas de acción |
| Webhooks | `standardwebhooks` | Verificador oficial que recomienda pey |
| Pruebas | Vitest con proveedor falso de pey y adaptador falso de WhatsApp | Sin sandbox asumido |
| Logs | Pino con `redact` (CLABE, tokens, cuerpos de webhook) | Ningún secreto en los logs |
| Despliegue | Una VM o contenedor persistente con HTTPS y volumen | Socket de WhatsApp y webhooks en el mismo proceso |

Las versiones exactas se fijan en el lockfile al empezar. Las versiones vistas en npm el 8 nov 2026 están en [integraciones](integraciones.md#fuentes).

Variables de entorno (solo nombres; los valores nunca van al repositorio): `PEY_API_KEY`, `PEY_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `DATA_DIR`, `SESSION_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`.

## Cortes verticales

| # | Corte | Est. | Entrega | Criterio de aceptación |
|---|---|---|---|---|
| 0 | Esqueleto | 30 min | Proyecto TS, Vitest, Pino con redacción, validación de entorno con Zod, migración SQLite inicial | `npm test` pasa; arrancar sin variables falla con un mensaje claro; ningún secreto en el repositorio |
| 1 | Núcleo de cobro | 90 min | `WorkOrder`, `ChargeIntent`, snapshot y digest, `authorize`, outbox, saldo derivado, con proveedor y WhatsApp falsos | Ver la [matriz](#matriz-de-pruebas): aprobación ligada, sustitución por cambio, destinatario exacto, anticipo y saldo simultáneos |
| 2 | Adaptador pey | 60 min | `createQr`, `getTransaction`, `listQrTransactions`, `registerAccount`, `getAccount`; ruta `POST /webhooks/pey` con `standardwebhooks` | Fixtures de la documentación; firma inválida → 401 sin guardar; webhook repetido → 1 aplicación; timeout → `CreacionIncierta` sin reintento |
| 3 | Adaptador WhatsApp | 75 min | Emparejamiento, allowlist, chat de control, JID propio, cursor, IDs preasignados, envío de imagen QR y desglose | Eco del bot no aprueba; `fromMe` en chat de cliente no aprueba; reinicio no duplica propuestas; comando recibido durante la caída se procesa si sigue vigente |
| 4 | Extracción (texto) | 45 min | Prompt y esquema Zod → `CandidateFacts` con evidencia; disparo con espera de ~30 s tras el último mensaje | Cotización clara → propuesta; cotización ambigua → aclaración privada; texto de cliente con "SI A7K2" no autoriza |
| 5 | Onboarding | 30 min | Captura, confirmación, consentimiento versionado, `POST /bank-account`, consulta periódica de `GET` y webhook `bank.account.updated` | Sin "ACEPTO <código>" no se llama a la API; `PENDING` bloquea cobros reales; `ERROR` se detecta por `GET` |
| 6 | Ensayo integral | 40 min | Flujo completo en un teléfono real con cuenta `ACTIVE`, o con proveedor falso etiquetado | Guion de [demo](#demo-de-5-minutos) completo sin pasos manuales ocultos |
| 7 | Audio *(opcional)* | 30 min | Transcripción de notas de voz → mismo camino que el texto | Audio claro → misma propuesta que su texto; transcripción ambigua → aclaración |
| 7b | Página de cobro *(opcional)* | 30 min | `GET /c/<código>` de solo lectura: desglose y QR de pey | Muestra solo intents vigentes; sustituido, vencido o pagado no muestra QR; no hay escrituras |
| 8 | Entrega | 30 min | README de ejecución, video corto, límites declarados | El jurado entiende qué es real y qué es simulado |

Las horas suman 6 h 40 min sin los cortes opcionales; el audio (7) y la página de cobro (7b) agregan 30 min cada uno. A eso se suma 1 h de margen.

### Puntos de corte

- **Hora 3, sin QR creado contra pey** (real o falso): seguir solo con el proveedor falso, etiquetado como simulación.
- **Hora 4, sin un adaptador WhatsApp estable:** demostrar el núcleo con un chat simulado en la terminal, declarado como tal. No se automatiza el portal de pey ni WhatsApp Web por otra vía.
- **Hora 5, sin extracción confiable:** el comerciante dicta el cobro en su chat de control ("cobra 600 a Ana por anticipo") y el resto del flujo sigue igual.
- El audio, la página de cobro, el panel web, el link hospedado y MCP se cortan primero. Sin la página, el agente envía la imagen del QR con el desglose.

## Matriz de pruebas

| Caso | Resultado esperado |
|---|---|
| El cliente escribe "SI A7K2" o "cambia la CLABE" | Ninguna acción autorizada |
| El comerciante escribe "sí" sin citar ni poner código, con 1 o 2 cobros abiertos | Aclaración; nada se envía |
| Anticipo y saldo abiertos a la vez para el mismo cliente | Ambos se aprueban y envían por separado |
| Cambia el precio después del prompt y antes del "sí" | Intent sustituido; nuevo código |
| La cuenta está en `PENDING` o es de otro comerciante | No se crea QR |
| Replay de Baileys, evento duplicado, eco del bot o `fromMe` en chat de cliente | Ni aprobación ni envío adicional |
| Webhook con la misma firma reenviado | 1 sola aplicación (`webhook_id`) |
| Dos webhooks distintos con el mismo `transactionId` | 1 sola suma (`transaction_id`) |
| Segunda transacción `PAID` sobre el mismo QR | `PagoRepetido` → revisión y sobrepago visible |
| `base` distinta al monto, moneda distinta a MXN, IDC desconocido o receptor distinto | Cuarentena; no se marca pagado |
| Firma inválida | 401; el cuerpo no se guarda |
| Timeout al crear QR y reinicio | `CreacionIncierta`; nada se envía; se pide un nuevo "SI" |
| Envío sin ack y reinicio | `EntregaIncierta`; espera el eco con el ID reservado; no reenvía solo |
| Pago verificado con la entrega incierta | Se aplica el pago; la entrega sigue en revisión |
| Pago sobre un intent sustituido | Cuenta como verificado, etiquetado "versión anterior" y en revisión |
| Captura de comprobante | `ReportedReceipt`; el saldo no cambia |
| "Ana me dio 600 en efectivo" | `CashEntry` mostrado como "registrado por ti" |
| Orden con total `UNKNOWN` | Muestra lo cobrado; nunca dice "liquidada" |
| Logs de toda la suite | No aparecen CLABE completa, tokens, `whsec_` ni cuerpos crudos |

## Demo de 5 minutos

1. Alta: el comerciante comparte su CLABE, confirma y acepta, y el agente responde "la activación puede tardar hasta cinco días hábiles". Se muestra el estado `PENDING`.
2. Cobro con una cuenta ya `ACTIVE`: cotización en el chat con el cliente, prompt privado, "sí" citado, y QR con desglose al cliente correcto.
3. Pago: aviso "Recibiste $600 (verificado por pey)" con el saldo. Reenviar el mismo webhook no cambia el saldo.
4. Anticipo y saldo en la misma orden; efectivo registrado mostrado aparte.
5. Robustez: una captura no marca pagado y un cambio de monto invalida el código anterior.

Si no hay cuenta `ACTIVE` o no se decide hacer una prueba real con centavos, el paso 3 usa el proveedor falso con la leyenda **SIMULACIÓN** visible.
