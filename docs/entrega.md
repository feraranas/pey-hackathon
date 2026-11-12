# Entrega: registro de criterios, despliegue y recuperación

Base de este registro: `main` en `039cb00` (11 de noviembre de 2026, hora de Ciudad de México). Cada fila separa lo demostrado en simulación de lo que exige una cuenta, un número o la VPS reales. Una fila simulada no acredita un pago real.

## Registro por criterio

| # | Criterio | Resultado | Cómo se comprobó | Límite |
|---|---|---|---|---|
| 1 | Sesión vinculada, identidad, reconexión, recepción y envío autorizados | Simulado | `test/sidecar.test.ts` y `go test` del sidecar; el binario real llega a WhatsApp y entrega un `pair_qr`; `npm run verify` | Falta escanear el QR de cada número y la passkey del comerciante ([sidecar](whatsmeow-sidecar.md)). |
| 2 | El comerciante autoriza una propuesta vigente antes del envío | Simulado | `test/binding.test.ts` (un «Sí» solo liga lo que el comerciante vio), `test/conversation.test.ts`, `test/core.test.ts`, `npm run demo:story` | Con WhatsApp real depende de `PRODUCT_JID` y de la sesión del producto. |
| 3 | QR real a cuenta `ACTIVE`, pago pequeño, webhook firmado, consulta por API | Simulado | `test/e2e.test.ts` y `npm run local` usan un sandbox local que firma webhooks | Falta la API key de pey, el secreto del webhook y una cuenta bancaria activa. |
| 4 | Duplicados y reinicios no duplican acreditación ni aviso; lo incierto va a revisión | Probado en pruebas | `test/core.test.ts`, `test/webhook-order.test.ts`, `test/runtime.test.ts`, `test/e2e.test.ts` | Igual que arriba para el flujo real. |
| 5 | Pruebas, CI, configuración, respaldo y recuperación documentados | Parcial | CI verde en cada PR; `test/backup.test.ts`; [ensayo real](ensayo-real.md); este documento | El despliegue en la VPS no se ejecutó: no hay acceso SSH desde esta caja. |

## Despliegue con Whatsmeow

El archivo [compose.yaml](../compose.yaml) levanta la app y un sidecar por sesión con la misma imagen. Los sockets viven en volúmenes separados y no se publican. Solo la app publica `127.0.0.1:3000`, detrás de Nginx.

```bash
docker build -f Dockerfile.verify -t pey-hackathon:reviewed .
docker image inspect pey-hackathon:reviewed --format '{{.Id}}'   # registra el digest
MERCHANT_NUMBER=52155... PRODUCT_NUMBER=52155... docker compose up -d
```

El archivo `/etc/pey-hackathon/pey.env` debe incluir `PRODUCT_JID`, `MERCHANT_JID`, las claves de pey y `SESSION_ENCRYPTION_KEY`. No lo copies a Git ni lo imprimas. El archivo compose no se ha ejecutado aquí porque la caja no tiene Docker; solo se validó su sintaxis y la compilación estática del sidecar. Ejecuta primero `docker compose config` en la VPS.

Los almacenes de dispositivos (`merchant-wa.db`, `product-wa.db`) usan SQLite sin cifrado propio ([guía](cifrado-en-reposo.md)). Cifra el disco o el volumen de la VPS y no abras el mismo volumen desde dos procesos de la app: `.service` lo impide.

## Respaldo y restauración

1. Detén la app: `docker compose stop app`. El respaldo toma el cerrojo de `DATA_DIR`.
2. `npm run backup -- /ruta/data /ruta/respaldo-nuevo` copia `pey.sqlite` y `whatsapp.enc`, y guarda los almacenes `*-wa.db` solo cifrados (`*.enc`), con la API de respaldo de SQLite (coherente con WAL, sin copiar archivos a medias). Necesita `SESSION_ENCRYPTION_KEY` y verifica `integrity_check`. Más detalle en [cifrado en reposo](cifrado-en-reposo.md).
3. Verifica más tarde con `npm run backup -- --verify /ruta/respaldo`. Para restaurar: `npm run backup -- --restore /ruta/respaldo /ruta/data-vacío`.
4. Guarda la clave `SESSION_ENCRYPTION_KEY` por separado y la copia fuera de la VPS.
5. Para restaurar: detén todo, copia los archivos a un volumen nuevo, verifica y arranca. Restaurar una base antigua puede perder pagos posteriores. Si el resultado de un pago o envío es incierto, conserva la evidencia y detén los reintentos antes de decidir.

## Reversión

Conserva la imagen y el compose anteriores. Para volver atrás, detén el stack nuevo, restaura la imagen anterior con el mismo volumen y arranca. Si la versión nueva migró el esquema, restaura también el respaldo compatible. Si cambia el transporte (Baileys a Whatsmeow), no hay compatibilidad de sesión: la nueva sesión requiere volver a vincular.

## Pasos que solo puede hacer una persona

1. Crear `/etc/pey-hackathon/pey.env` con `PEY_API_KEY`, `PEY_API_KEY_ID`, `PEY_WEBHOOK_SECRET`, `PRODUCT_JID` y `MERCHANT_JID`.
2. Escanear el QR del número del producto y el del comerciante.
3. Firmar la passkey del comerciante (ver [sidecar](whatsmeow-sidecar.md)).
4. Activar la cuenta bancaria en pey (hasta 5 días hábiles) y aprobar un cobro pequeño en persona.
5. Acceso SSH a la VPS para ejecutar los pasos anteriores; esta caja no lo tiene.
