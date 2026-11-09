# Investigación de la API pública de Pey

Revisión del 7 de noviembre de 2026 de la [documentación](https://docs.pey.mx/docs/category/api-reference), su sitemap y la [especificación OpenAPI](https://docs.pey.mx/openapi.json). Se encontraron 11 endpoints documentados y cuatro eventos de webhook. No se documentaron métodos PUT, PATCH o DELETE. Esto no descarta endpoints internos no publicados.

La URL base de producción es `https://api.pey.mx`; se autentica con `Authorization: Bearer <api-key>`. `{id}` representa el identificador del recurso. [Introducción](https://docs.pey.mx/docs/api/codi-api).

## GET

| Endpoint | Para qué sirve |
|---|---|
| [`/bank-account/{id}`](https://docs.pey.mx/docs/api/get-bank-account) | Consulta una cuenta registrada y su estado de activación para CoDi. |
| [`/payment-link/{id}`](https://docs.pey.mx/docs/api/get-payment-link) | Consulta los detalles de un link de pago. |
| [`/transaction/{id}`](https://docs.pey.mx/docs/api/get-transaction) | Consulta una transacción concreta. El ID de transacción es distinto al ID del QR. |
| [`/transaction/api-key`](https://docs.pey.mx/docs/api/get-api-key-transactions) | Lista las transacciones recibidas por la API key, 80 por página. |
| [`/transaction/bank-account/{id}`](https://docs.pey.mx/docs/api/get-bank-account-transactions) | Lista los pagos CoDi recibidos por una cuenta registrada, 80 por página, del más reciente al más antiguo. |
| [`/transaction/codi/qr/{id}`](https://docs.pey.mx/docs/api/get-co-di-qr-transactions) | Lista los pagos de un QR CoDi concreto, 20 por página. |

Los tres listados de transacciones usan `nextToken` para consultar la página siguiente. Solo se pueden consultar recursos asociados con la API key.

## POST

| Endpoint | Para qué sirve |
|---|---|
| [`/bank-account`](https://docs.pey.mx/docs/api/register-bank-account) | Registra una cuenta bancaria mediante su CLABE para recibir pagos CoDi. La activación puede tardar hasta cinco días hábiles. |
| [`/codi/qr`](https://docs.pey.mx/docs/api/create-qr) | Crea un QR CoDi para cobrar. Puede devolver una imagen; con monto `0`, el pagador elige cuánto pagar. |
| [`/codi/pn`](https://docs.pey.mx/docs/api/create-push-notification) | Envía una solicitud de pago CoDi al teléfono del pagador. |
| [`/payment-link/create`](https://docs.pey.mx/docs/api/create-payment-link) | Crea un link de pago compartible, con propina opcional y URLs de regreso. |
| [`/payment-link/update`](https://docs.pey.mx/docs/api/update-payment-link) | Cambia únicamente el monto de un link, siempre que siga en estado `pending`. |

En QR y notificaciones push, `bankAccountId` permite elegir una cuenta activa; si se omite, se usa la cuenta CoDi vinculada a la API key. [Detalle](https://docs.pey.mx/docs/changelog/bank-accounts).

## Webhooks

Pey envía estos eventos a una URL configurada por el integrador; no son endpoints de Pey para llamar.

| Evento | Cuándo ocurre |
|---|---|
| [`bank.account.updated`](https://docs.pey.mx/docs/webhooks/bank-account/updated) | Una cuenta registrada pasa a `ACTIVE`. Los demás estados no generan este evento. |
| [`codi.pn.payment_received`](https://docs.pey.mx/docs/webhooks/codi/pn) | Se completa un pago solicitado mediante notificación push CoDi. |
| [`codi.qr.payment_received`](https://docs.pey.mx/docs/webhooks/codi/qr) | Se recibe un pago mediante un QR CoDi. |
| [`payment_link.status_updated`](https://docs.pey.mx/docs/webhooks/payment-link/status-update) | Cambia el estado de un link de pago: `pending`, `processing` o `paid`. |

La documentación indica que cada API key admite una URL de webhook y que las solicitudes se firman mediante Standard Webhooks. La configuración se realiza en el portal. [Configuración](https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks) · [Autenticación e historial](https://docs.pey.mx/docs/webhooks/introduction).

## Cómo obtener `apiKeyId`

El campo `apiKeyId` aparece en los webhooks de [QR](https://docs.pey.mx/docs/webhooks/codi/qr), [push](https://docs.pey.mx/docs/webhooks/codi/pn) y [links de pago](https://docs.pey.mx/docs/webhooks/payment-link/status-update). No se encontró un endpoint público documentado para consultarlo directamente. Para listar transacciones mediante `GET /transaction/api-key` no se necesita ese ID: Pey identifica la clave mediante el encabezado `Authorization`.

La creación de API keys, configuración de webhooks, rotación de secretos y consulta del historial de entregas se describen como acciones del portal; no se encontraron endpoints públicos documentados para ellas. [API keys](https://docs.pey.mx/docs/tutorials/getting-started/create-an-api-key) · [Webhooks](https://docs.pey.mx/docs/tutorials/getting-started/set-up-webhooks).
