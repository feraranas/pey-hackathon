# Integraciones: contratos verificados y pendientes

Consulta realizada el **8 de noviembre de 2026** (hora de Ciudad de México) contra la documentación pública. Lo que aparece aquí como "verificado" se leyó en las fuentes listadas al final. **No** se hicieron llamadas autenticadas a la API ni transacciones: todo lo que dependa de una respuesta real queda en [Pendiente de comprobar en integración](#pendiente-de-comprobar-en-integración).

- OpenAPI: `https://docs.pey.mx/openapi.json`, `info.version` = `2026-10-20`, servidor único `https://api.pey.mx`.
- Autenticación: `Authorization: Bearer <API key>` (esquema `http`/`bearer` en el OpenAPI).

## pey: endpoints que usa el MVP

| Uso | Método y ruta | Notas |
|---|---|---|
| Registrar CLABE del comerciante | `POST /bank-account` | Alta de la cuenta receptora |
| Consultar activación | `GET /bank-account/{id}` | Único modo de ver `PROCESSING` y `ERROR` |
| Crear cobro | `POST /codi/qr` | QR de monto fijo hacia `bankAccountId` |
| Verificar un pago | `GET /transaction/{id}` | `id` = `transactionId` del webhook |
| Red de seguridad por cobro | `GET /transaction/codi/qr/{id}` | `id` = IDC del QR; 20 por página, `nextToken` |
| Conciliación por cuenta | `GET /transaction/bank-account/{id}` | Solo transacciones `PAID`; 80 por página |

Otros endpoints documentados que **no** forman parte del camino crítico: `POST /codi/pn` (push CoDi a un teléfono de 10 dígitos), `POST /payment-link/create`, `POST /payment-link/update`, `GET /payment-link/{id}` y `GET /transaction/api-key`.

### `POST /bank-account`

Petición (todos obligatorios):

| Campo | Tipo y restricción |
|---|---|
| `alias` | string, 1–255 |
| `name` | string, 1–255, nombre legal completo del titular |
| `clabe` | string, `^[0-9]{18}$`; dígito verificador válido y banco con CoDi habilitado |
| `entity` | enum `PERSON` \| `BUSINESS` |

Respuesta `200`: `{ id, codiStatus }`, con `id` ULID y `codiStatus` ∈ `PENDING | PROCESSING | ACTIVE | ERROR`; las cuentas nuevas empiezan en `PENDING`. Errores `400` con `error.type` ∈ `INVALID_REQUEST | INCOMPLETE_PARAMETERS | INVALID_PARAMETER | INVALID_CLABE`, más `requestId`; `503` (`SERVICE_UNAVAILABLE | FLAGS_UNAVAILABLE`) y `500`.

`GET /bank-account/{id}` devuelve además `alias`, `name`, `clabe`, `entity`, `taxId` (si se envió), `errorMessage` (solo en `ERROR`) y `dateCreated` (segundos Unix). Devuelve `404` si la cuenta no existe **o pertenece a otra API key**.

Estados (página *Bank Account*): `PENDING` recibido, sin enviar a Banxico; `PROCESSING` registro en curso; `ACTIVE` puede recibir pagos; `ERROR` falló. "Registration with Banxico takes up to 5 business days." El mensaje al comerciante dice "puede tardar hasta cinco días hábiles", sin prometer un día exacto.

**Webhook `bank.account.updated`:** solo se envía en la transición a `ACTIVE`. `PENDING`, `PROCESSING` y `ERROR` no disparan webhook. Por eso el diseño consulta `GET /bank-account/{id}` periódicamente para detectar `ERROR`. Carga: `type`, `bankAccountId`, `name`, `ownerType` (`API_KEY` para cuentas registradas por API), `ownerId`, `taxId`, `codiStatus` (siempre `ACTIVE`), `clabe`, `entity`.

No existe en el OpenAPI una búsqueda de cuentas por CLABE ni una lista de cuentas de la API key. Si el `POST` queda incierto (timeout, `5xx`, caída), el registro va a revisión manual en vez de reintentarse automáticamente.

### `POST /codi/qr`

| Campo | Tipo y restricción | Uso en el MVP |
|---|---|---|
| `amount` *(obligatorio)* | number, MXN, `>= 0`; `0` permite al pagador escribir el monto | Siempre el monto fijo aprobado, **nunca `0`** |
| `concept` | string, mostrado al pagador | Resumen corto del trabajo |
| `expiration` | integer, segundos; `0` sin vencimiento; mínimo 360 si se define | Vigencia configurable alineada con la oferta |
| `numRef` | string, `^[0-9]{1,7}$` | Referencia numérica interna única |
| `generateImage` | boolean; puede hacer más lenta la respuesta | `false`: se renderiza `qrString` localmente |
| `bankAccountId` | string ULID; la cuenta debe estar `ACTIVE` | Siempre presente. Si se omite, el pago va a la cuenta ligada a la API key, así que omitirlo está prohibido |
| `metadata` | hasta 50 pares escalares, claves ≤ 40, valores ≤ 500; regresan como strings | `chargeIntentId`, `workOrderId`, `revision` |

Respuesta `201`: `id` (IDC asignado por Banxico), `qrString` (contenido del QR) y `qrImage` (PNG en base64 o `null`). Errores `400` con `error.type` ∈ `INVALID_REQUEST | PEY_CONSISTENCY_ERROR | INVALID_STATE | INVALID_AMOUNT | INVALID_PARAMETER`; también `503` y `500`.

- **Unidades:** la API usa pesos decimales (`number`). Internamente se usan centavos enteros. La conversión de salida es `centavos / 100` con a lo sumo dos decimales. La de entrada parsea el número, exige `^\d+(\.\d{1,2})?$` al formatearlo y pone en cuarentena cualquier otro valor. Nunca se suman `number` de JavaScript para calcular saldos.
- **Moneda:** las peticiones no tienen campo de moneda; el monto es implícitamente MXN. Las transacciones sí traen `currency` (ISO 4217) y se exige `"MXN"`.
- **Monto máximo:** el OpenAPI no publica un máximo para QR. Para push el máximo es 1,000,000. Los límites por operación de Banxico y del banco del pagador pueden aplicar (términos, cl. 2.5).
- **Idempotencia:** el OpenAPI **no documenta** clave de idempotencia para crear QR. No se inventa una.
- **Cancelación:** no hay endpoint documentado para cancelar o invalidar un QR. Un QR ya entregado puede pagarse hasta que venza `expiration`. Por eso el diseño siempre fija `expiration` y trata los pagos sobre versiones sustituidas como "pago tardío" que se revisa.
- **Varios pagos por QR:** `GET /transaction/codi/qr/{id}` devuelve una *lista* de transacciones. El diseño no asume que un QR de monto fijo solo se pueda pagar una vez: una segunda transacción `PAID` es un sobrepago que se revisa.

### Webhooks

- Firma: pey usa **Standard Webhooks** y recomienda sus SDK oficiales. En Node se usa el paquete `standardwebhooks` (repositorio `standard-webhooks/standard-webhooks`), verificando el **cuerpo crudo** con el secreto `whsec_…` del portal. El ejemplo de pey lee el encabezado `webhook-id` y lo describe como clave de idempotencia. El SDK valida los encabezados del estándar (`webhook-id`, `webhook-timestamp`, `webhook-signature`); no se implementa un HMAC propio.
- Configuración: el webhook se liga a la API key en el portal y **cada API key admite un solo webhook**. El secreto se puede rotar desde el portal.
- Historial de entregas: disponible en el portal ("Webhook Logs").
- La documentación consultada no especifica la política de reintentos ni el plazo de respuesta esperado. El diseño responde `2xx` en cuanto la evidencia queda guardada, sin hacer trabajo de red antes del ACK.

**Evento `codi.qr.payment_received`:**

| Campo | Significado | Uso |
|---|---|---|
| `type` | `codi.qr.payment_received` | Enrutamiento |
| `transactionId` | ULID de la transacción | Clave única de **aplicación de dinero** |
| `codiQrId` | IDC del QR (igual al `id` de la creación) | Liga con `ProviderCharge` |
| `bankAccountId` | Cuenta que recibió; **solo presente si se envió al crear el QR** | Debe coincidir con el receptor guardado |
| `amount` | Monto en MXN | Pista; se verifica con `GET /transaction/{id}` |
| `apiKeyId` | API key del evento | Debe coincidir con la configurada |
| `numRef`, `concept`, `datePaid`, `metadata` | `metadata.externalMetadata` regresa como strings | Correlación secundaria y auditoría |

Otros eventos documentados: `codi.pn.payment_received`, `payment_link.status_updated` (`pending`, `processing`, `paid`) y `bank.account.updated`.

### Verificación del pago

`GET /transaction/{id}` devuelve `status` (`PENDING | PAID`), `amount`, `amountBreakdown { base, tip, fee }`, `currency`, `paymentMethod` (`CARD | CODI`), `payableType` (`PAYMENT_LINK | API_CODI_QR | API_CODI_PN`), `payableId`, `datePaid` y `metadata`. Para `CODI`, `metadata` trae `clabe` (CLABE receptora), `bankCode`, `accountType`, `description`, `trackingKey` y `externalMetadata`. Responde `404` si la transacción pertenece a otra API key.

Regla para marcar un cobro como **pagado verificado**: firma válida, transacción `PAID`, `currency = "MXN"`, `paymentMethod = "CODI"`, `payableType = "API_CODI_QR"` y `codiQrId` conocido en `ProviderCharge`. Además, el receptor debe coincidir: `bankAccountId` del webhook (si viene) igual al del cobro, y `metadata.clabe` igual a la CLABE registrada para ese receptor. `amountBreakdown.base` se compara contra el monto del intent. Si falta un campo, el receptor se resuelve por el **mapeo autenticado guardado** `IDC → ChargeIntent → ReceivingAccount`, nunca exigiendo un campo inexistente. Cualquier discrepancia manda a cuarentena.

### Link de pago hospedado: sin paridad, fuera del MVP

`POST /payment-link/create` pide `amount`, `successUrl`, `backUrl`, `hasTip`, `clientReferenceId` y `metadata`. **No tiene `bankAccountId`.** Según la documentación, el dinero iría a la cuenta ligada a la API key y no a la CLABE de cada comerciante, lo que rompe el ruteo por comerciante. Por eso el MVP es **QR primero**. El link de pey queda como opción futura solo si pey documenta un receptor por link. Lo que la UX llama «enlace de pago» es una página propia opcional que muestra el QR de pey ([diseño](diseno.md#8b-página-de-cobro-opcional)); no es un link hospedado de pey.

### Ambiente de pruebas: no se asume

El OpenAPI y el tutorial *Create an API Key* dicen que "A dedicated test environment is coming soon" y recomiendan probar en producción con montos como $0.01 MXN. Hay mensajes contradictorios: `llms.txt` menciona `https://api.dev.pey.mx` y `portal.dev.mipey.mx`, y los términos (cl. 3.5) mencionan un sandbox, pero la página "Configure CoDi for Testing" que enlaza `llms.txt` devolvió 404. **El diseño no depende de un sandbox.** Las pruebas automáticas usan un proveedor falso explícito con *fixtures* copiados de los ejemplos de la documentación. Cualquier prueba con dinero real, aunque sea de centavos, es una decisión humana separada.

## Términos del API de pey

Fuente: `https://pey.mx/legal/terminos-api`, "Última actualización: 13 de octubre de 2026". Puntos relevantes:

- 3.5: un integrador que construye para terceros puede registrar a sus clientes con sus credenciales productivas "siempre y cuando el negocio titular haya autorizado el uso de su Cuenta Destino por el Integrador".
- 3.2 y 3.3: pey valida con fuentes públicas y mecanismos disponibles que la cuenta corresponda, y puede pedir documentación adicional.
- 5.4: el modelo de plataforma se autoriza por escrito mediante Contrato Particular. Cada comercio recibe solo en cuentas de su titularidad y acepta los términos. Queda prohibida la cuenta concentradora.
- 4.2(b): prohíbe ingeniería inversa del API, lo que confirma la decisión de no automatizar el portal.

El permiso de plataforma ya está confirmado por el equipo. Aquí solo se registra la referencia. El producto guarda el **consentimiento** explícito del comerciante, pero eso documenta su autorización y **no demuestra** que sea titular de la CLABE. La activación `ACTIVE` la decide pey.

## WhatsApp vía Baileys

Verificado leyendo el paquete npm `baileys@7.0.0-rc14` (también publicado como `@whiskeysockets/baileys`). Es una **release candidate** que declara `engines.node >= 20`.

- `sendMessage(jid, content, options)` acepta `options.messageId`. En el código, las opciones del llamador se aplican después del ID generado, y `generateMessageIDV2` se exporta. Por eso el diseño **preasigna y persiste** el ID antes de enviar, para distinguir ecos del bot sin carreras. Esto se comprobó en el código fuente, no en documentación estable: el adaptador debe probarlo al arrancar y, si falla, deshabilitar comandos (supresión conservadora).
- Baileys no es una API oficial de WhatsApp. La sesión puede cerrarse y el servicio puede imponer restricciones. La sesión se trata como secreto: cifrada en reposo, fuera del repositorio y de los logs.
- Pendiente de comprobar en la sesión real: el formato del JID propio (número y LID en la v7), cómo aparecen los mensajes del chat consigo mismo y la cita (`contextInfo.stanzaId`) cuando el comerciante decide citar una propuesta (opcional: un «sí» simple basta).

## OpenAI

Verificado en el paquete `openai@7.53.0` (`engines.node >= 22`): incluye `audio.transcriptions` y los helpers `zodTextFormat` y `zodResponseFormat` para salida estructurada con Zod. Los modelos concretos se fijan al implementar según la documentación vigente. El modelo solo devuelve `CandidateFacts`: no tiene herramientas para enviar, cobrar ni escribir en la base.

## Versiones del entorno

- Node.js: según `nodejs.org/dist/index.json` y el calendario oficial `nodejs/Release`, la línea 24 ("Krypton", 24.22.x) está en LTS de mantenimiento hasta 2028-04-30. La 26 ("Lithium") entró a LTS activo el 2026-10-28. **Recomendación: Node 24 LTS** por compatibilidad probada con módulos nativos (`better-sqlite3`). Migrar a 26 si los binarios precompilados instalan sin compilar.
- Requisitos publicados en npm: `better-sqlite3@13` exige Node ≥ 22, `openai@7` ≥ 22, `vitest@5` `^22.12 || ^24 || >=26`, `baileys@7` ≥ 20. Las versiones exactas se fijan en el lockfile al iniciar la implementación.

## Pendiente de comprobar en integración

Estas comprobaciones no bloquean el diseño, pero sí las afirmaciones de la demo:

1. Que `payableId` de una transacción `API_CODI_QR` sea el IDC (`codiQrId`). La documentación solo dice "identifier of the resource that was paid".
2. Que `amountBreakdown.base` sea igual al `amount` del QR cuando no hay propina ni comisión al pagador.
3. La política de reintentos y el plazo de los webhooks de pey.
4. Cómo abre o importa el cliente un QR recibido en su mismo teléfono, según su banco. No se promete que funcione en todos los bancos.
5. Los puntos de Baileys listados arriba.
6. Una cuenta `ACTIVE` disponible para la demo. Sin ella, la demo muestra el alta `PENDING` y un proveedor falso **etiquetado como simulación en pantalla**.

## Fuentes

Todas consultadas el 8 nov 2026.

1. https://docs.pey.mx/openapi.json
2. https://docs.pey.mx/llms.txt
3. https://docs.pey.mx/en/docs/types/bank-account
4. https://docs.pey.mx/en/docs/webhooks/bank-account/updated
5. https://docs.pey.mx/en/docs/webhooks/introduction
6. https://docs.pey.mx/en/docs/webhooks/codi/qr
7. https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks/
8. https://docs.pey.mx/en/docs/tutorials/getting-started/create-an-api-key
9. https://docs.pey.mx/en/docs/tutorials/use-cases/display-codi-qr
10. https://docs.pey.mx/en/docs/types/metadata-response
11. https://pey.mx/legal/terminos-api
12. https://nodejs.org/dist/index.json y https://github.com/nodejs/Release (`schedule.json`)
13. Registro npm: `baileys@7.0.0-rc14`, `openai@7.53.0`, `better-sqlite3@13.0.3`, `vitest@5.1.0`, `standardwebhooks@1.1.1`, `@mermaid-js/mermaid-cli@12.2.0`
