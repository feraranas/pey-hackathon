# Explorador visual de la API de pey

Una página con una tarjeta por endpoint de pey (11) y por evento de webhook (4). Cada tarjeta explica qué hace, deja editar los parámetros, manda la llamada real a través de un proxy y muestra cómo viaja el dato: tu navegador → proxy → api.pey.mx → banco/CoDi → webhook firmado → tu app.

```
npm run explorer        # http://127.0.0.1:4173, usuario «pey», contraseña en el archivo del token
```

## Qué incluye

- **Tarjetas.** Método, ruta, descripción, campos para parámetros de ruta y `nextToken`, cuerpo JSON editable (precargado con el ejemplo de la documentación, con montos de 1 MXN) y botón **Enviar**.
- **Expansores.** «Ejemplo de petición y respuesta» (de la documentación) y «Cómo se mueve el dato». Después de enviar se ven estado, latencia y la respuesta real.
- **Diagrama.** Los seis pasos se iluminan en orden mientras corre la llamada. Las tarjetas de escritura marcan además el webhook que llegará después.
- **Encadenado.** Los IDs que devuelve una respuesta (cuenta, QR, link, transacción, `nextToken`) rellenan los campos de las tarjetas siguientes.
- **Webhooks.** «Simular» firma un ejemplo en local con el secreto y lo manda a `/webhooks/pey` del propio explorador: se ve la verificación, la idempotencia (reenvío con el mismo `webhook-id`), un cuerpo alterado y un timestamp de hace 10 minutos. Un panel en vivo (SSE) lista cada webhook recibido.
- **Dos entornos.** *Sandbox* (por defecto) levanta el simulador local de pey con datos de ejemplo; después de crear un QR, una solicitud push, un link o una cuenta, el botón «Simular…» hace que el «banco» sandbox pague y entregue un webhook firmado de verdad. *Producción* aparece solo si el servidor tiene `PEY_API_KEY`.

## Seguridad

La clave vive solo en el proceso del servidor; el navegador nunca la ve.

| Medida | Detalle |
|---|---|
| Acceso | Todo requiere el token como contraseña (Basic). Solo `/health` y `POST /webhooks/pey` (protegido por firma) son públicos. Diez fallos por minuto bloquean al origen. |
| CSRF | Los POST a `/api/*` exigen una cabecera propia y rechazan `Sec-Fetch-Site` de otro sitio. |
| Rutas | El proxy solo llama a endpoints del catálogo; los IDs se validan y la base de producción es fija (`https://api.pey.mx`). |
| Redacción | Las CLABE salen con los últimos 4 dígitos, los teléfonos y el RFC enmascarados; la clave, el secreto del webhook y el token se sustituyen por `[secreto]`; la imagen del QR se resume. |
| Escrituras en producción | Bloqueadas salvo `EXPLORER_PROD_POSTS=1`; además exigen la casilla de confirmación («usa dinero/cuentas reales»), un monto máximo (`EXPLORER_MAX_AMOUNT`, 5 MXN) y rechazan el teléfono de ejemplo de la documentación. |

## Variables

| Variable | Para qué |
|---|---|
| `EXPLORER_PORT` | Puerto local (4173). Escucha solo en `127.0.0.1`; para verlo desde fuera usa un túnel (por ejemplo `cloudflared tunnel --url http://127.0.0.1:4173`). |
| `EXPLORER_TOKEN_FILE` | Archivo con el token (por defecto `~/.config/pey-explorer/token`; se crea con modo 0600 si no existe). |
| `PEY_API_KEY` | Activa «Producción». |
| `PEY_API_KEY_ID`, `PEY_WEBHOOK_SECRET` | Opcionales: sirven para firmar y verificar webhooks de ejemplo en modo producción. |
| `EXPLORER_PROD_POSTS`, `EXPLORER_MAX_AMOUNT` | Ver «Seguridad». |

Para que pey entregue webhooks reales al panel en vivo, apunta la URL del webhook del portal a `https://<tu-túnel>/webhooks/pey`: la ruta verifica la firma con `PEY_WEBHOOK_SECRET`. No comparte la base de datos de la app: el explorador guarda solo los últimos 200 eventos en memoria.

## Alcance

- Es una herramienta de inspección y demostración, no parte del flujo de cobro: no escribe en la base de la app ni cambia estados de cobros.
- El sandbox imita los cuerpos documentados, no a pey: no hay dinero, y sus errores son más sencillos que los reales.
