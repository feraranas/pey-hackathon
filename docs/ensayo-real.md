# Ensayo real con un pago pequeño

Lista ordenada para el primer cobro real. Nada de esto se ha ejecutado: necesita credenciales de pey, números de WhatsApp vinculados y a Ferdinand presente. No pegues secretos, QR, CLABE completa ni cargas de webhooks en Git, chats ni capturas.

## 0 · Antes de empezar

- [ ] `npm run verify` pasa en el SHA que se va a desplegar. Anota el SHA y la fecha.
- [ ] `/etc/pey-hackathon/pey.env` tiene `PEY_API_KEY`, `PEY_API_KEY_ID`, `PEY_WEBHOOK_SECRET`, `PRODUCT_JID`, `MERCHANT_JID`, `PUBLIC_BASE_URL`, `SESSION_ENCRYPTION_KEY`. Compruébalo por nombre, sin imprimir valores: `sudo awk -F= '/^(PEY_|PRODUCT_|MERCHANT_|SESSION_|PUBLIC_)/{print $1}' /etc/pey-hackathon/pey.env`.
- [ ] El respaldo previo existe y verifica (`npm run backup -- --verify`).
- [ ] El volumen de datos está cifrado ([guía](cifrado-en-reposo.md)).
- [ ] Monto acordado, menor de $20 MXN, y un cliente que sea el propio comerciante o una persona que sabe que es una prueba.

## 0.5 · Prueba de solo lectura

`npm run pey:smoke` usa las claves del entorno y no crea QR, no registra cuentas y no mueve dinero. Comprueba que pey acepta la clave (`GET /transaction/api-key`, se espera 200), que el secreto del webhook firma y verifica en local, y con `PUBLIC_BASE_URL` que el endpoint rechaza un POST sin firma (401). Con `PEY_BANK_ACCOUNT_ID` también consulta el estado de esa cuenta (`GET /bank-account/{id}`) y enmascara la CLABE. pey no ofrece un listado de cuentas: el ID sale del portal o del alta.

La clave que se probó el 11 de noviembre de 2026 funciona en `api.pey.mx` (producción) y la rechaza `api.dev.pey.mx` (403). Es una clave real: cualquier QR que se cree con ella cobra dinero real.

## 1 · pey

- [ ] URL del webhook en pey: `https://hooks.ferarana.work/webhooks/pey`, con los eventos `codi.qr.payment_received` y `bank.account.updated`.
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' --data '{}' https://hooks.ferarana.work/webhooks/pey` devuelve `401`.
- [ ] Alta por WhatsApp o `ALTA` con la CLABE real. La cuenta pasa de `PENDING` a `ACTIVE` (hasta 5 días hábiles). No registres otra cuenta sin una decisión de Ferdinand.
- [ ] El comerciante pregunta «estado» al producto y recibe `ACTIVE`.

## 2 · WhatsApp

- [ ] Producto: `node --import tsx scripts/pair-qr.ts <socket> 527715697632@s.whatsapp.net <png>` y escanear. Termina con «Número vinculado y verificado».
- [ ] Comerciante: igual con su número; si la cuenta tiene passkey, ver [sidecar](whatsmeow-sidecar.md).
- [ ] Reiniciar el stack y comprobar que ambas sesiones vuelven sin escanear.

## 3 · Cobro

1. «agrega a <cliente> <número>» al producto.
2. El comerciante acuerda el precio con ese cliente en su chat.
3. El producto propone el cobro. Revisar cliente, partidas y monto. Responder «Sí».
4. El cliente recibe el QR desde el WhatsApp del comerciante. «Listo ✅ Le envié…» llega al comerciante.
5. El cliente paga con CoDi.
6. Observar en este orden: webhook persistido (`202`) → consulta de la transacción → «Recibiste $X (verificado por pey)» **una sola vez** → «resumen» muestra el pago.
7. Repetir la entrega del mismo webhook desde el portal de pey. No debe haber un segundo aviso.

## 4 · Abortar si

- Se envía algo que el comerciante no autorizó.
- El resultado de un envío o de la creación de un QR es incierto: no crear otro QR ni repetir el pago; revisar `reviews` primero.
- La identidad de una sesión no coincide.
- Llegan dos avisos para el mismo pago.

## 5 · Registro

| Fecha y hora (UTC-6) | SHA | Qué se probó | Resultado | Límite |
|---|---|---|---|---|
| | | | | |

Etiqueta cualquier paso simulado como simulado. `/health` y HTTPS no demuestran un pago.
