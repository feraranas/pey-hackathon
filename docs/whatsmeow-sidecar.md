# Sidecar de Whatsmeow

El frente 1 y el frente 2 del [plan de tres horas](plan-tres-horas/01-whatsmeow.md) se materializan en `sidecar/` (Go, Whatsmeow) y `src/sidecar.ts` (adaptador Node). Baileys sigue disponible y es el transporte por defecto. Cada sesión (`PRODUCT` y `MERCHANT`) elige el suyo con `PRODUCT_TRANSPORT` y `MERCHANT_TRANSPORT`.

## Contrato (protocolo 1)

NDJSON sobre un socket Unix con permisos `0600` en un directorio `0700`. Nunca TCP. Un solo cliente a la vez; un segundo recibe `protocol_error` y se cierra. Un frame mide como máximo 1 MiB.

| Frame | Dirección | Garantía |
|---|---|---|
| `hello` (`protocol`, `version`) | sidecar → Node | Node cierra si `protocol` no es 1. |
| `status` (`phase`, `identity`) | sidecar → Node | Solo trae identidad con la sesión conectada y el número esperado. Node exige que coincida con la configuración; si no, queda no listo y no envía. |
| `message` (`chat`, `chatAlt`, `id`, `fromMe`, `at`, `text`, `quotedId`, `hasImage`) | sidecar → Node | Solo chats 1:1. Node descarta el chat propio, los no elegidos y lo anterior a la vinculación. |
| `send` (`ref`, `id`, `to`, `text`, `imageB64`) | Node → sidecar | ID reservado y persistido por Node. El sidecar valida y nunca reintenta. |
| `send_result` (`outcome`) | sidecar → Node | `acked` es acuse del servidor, no entrega ni pago. `failed_before_transmit` es un fallo seguro. `uncertain` y los timeouts van a revisión. |
| `pair_qr`, `passkey_request`, `passkey_code` | sidecar → Node | Se repiten a un cliente que se conecta tarde y se descartan al conectar. Son privados; no se registran. |
| `passkey_response`, `passkey_confirm`, `passkey_cancel` | Node → sidecar | Pasos del usuario durante la vinculación. |
| `overflow` | sidecar → Node | Se perdieron mensajes con Node desconectado (cola de 1000). Node queda no listo hasta reiniciar y revisar. |

El adaptador cierra por defecto ante versión incompatible, identidad distinta, frame desbordado, desbordamiento de cola o pérdida de conexión con un envío en curso (incierto, sin reenvío).

## Construir y ejecutar

```bash
cd sidecar && go build -o sidecar . && go test ./...
./sidecar -socket /run/pey/merchant/wa.sock -db /var/lib/pey/merchant-wa.db -number 5215550000001
```

`SIDECAR_DEBUG_EVENTS=1` imprime solo los nombres de los tipos de evento de Whatsmeow, nunca contenidos. La base SQLite del dispositivo queda en `0600`; Whatsmeow no la cifra, así que la VPS debe cifrar el disco o el volumen y un solo proceso debe escribirla.

Para verificar el apretón de manos sin enviar nada: `node --import tsx scripts/sidecar-smoke.ts /run/pey/merchant/wa.sock 5215550000001@s.whatsapp.net`.

## Qué falta, y es humano

1. **Escanear el QR** de cada número (el sidecar lo entrega como `pair_qr`; la app lo imprime en la terminal).
2. **Passkey del comerciante.** Si la cuenta tiene passkey, WhatsApp pide una firma WebAuthn con el origen de `whatsapp.com`. El sidecar ya entrega `passkey_request` y acepta `passkey_response` y `passkey_confirm`, pero un navegador no firma ese desafío desde `localhost` ni desde otro dominio. Este es el bloqueo del frente 1 y sigue sin resolverse: no se improvisó un puente. El número dedicado del producto es una cuenta nueva, que normalmente no tiene passkey, así que `PRODUCT` puede vincularse sin ese paso.
3. Con el comerciante presente: comprobar identidad, un envío a un chat elegido, cerrar y reiniciar para demostrar reconexión, y anotar el dispositivo vinculado temporal.

Verificado en esta caja (no con una cuenta real): el sidecar abre su almacén, crea el socket `0600`, anuncia `hello` y `status`, y entrega un `pair_qr` real de los servidores de WhatsApp; el adaptador Node lo recibe y queda no listo hasta que el número vinculado coincida.

## Vincular un número y regenerar el QR

El QR rota cada 20 a 60 segundos y el sidecar abre uno nuevo cuando se agota el canal (cada dos minutos y medio, sin reiniciar). `scripts/pair-qr.ts` escribe el QR vigente en un PNG `0600` y lo actualiza con cada rotación, y termina cuando el número esperado queda vinculado:

```bash
node --import tsx scripts/pair-qr.ts /run/pey/product/wa.sock 527715697632@s.whatsapp.net /ruta/qr.png
```

Abre el PNG justo antes de escanear (WhatsApp → Dispositivos vinculados → Vincular un dispositivo). Si lo escaneas tarde, vuelve a abrir el mismo archivo. El PNG y el almacén `wa.db` son secretos: no los versiones ni los compartas.

Los números de México tienen dos escrituras, `52` más diez dígitos y `521` más diez dígitos. El sidecar y el adaptador tratan ambas como el mismo número al verificar la identidad. Al enviar a un cliente, usa el JID que WhatsApp devuelva para él.
