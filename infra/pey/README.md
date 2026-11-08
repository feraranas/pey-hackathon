# Despliegue Pey en Hetzner

## Inventario

Nginx comparte la VPS con `media.ferarana.work` (muestras estáticas) y `logs.ferarana.work` (GoAccess protegido). No reemplazar esos sitios ni sus reglas de firewall. `hooks.ferarana.work` usa un registro A DNS-only en Cloudflare. HTTPS usa Certbot y renovación automática.

- Contenedor: `pey-mvp`; HTTP publicado solo en `127.0.0.1:3000`.
- Volumen: `pey-data`, montado en `/data`; contiene SQLite y `whatsapp.enc` cifrado.
- Entorno privado: `/etc/pey-hackathon/pey.env`, root, `0600`.
- Sitio: `/etc/nginx/sites-available/pey-hooks`, enlace en `sites-enabled`.
- Certificado: `/etc/letsencrypt/live/hooks.ferarana.work/`; no versionar su contenido.
- Logs Docker: `none` para evitar persistir QR/códigos. Diagnóstico visible mediante attach privado.
- Copias de sesiones: `/var/backups/pey-whatsapp/`; privadas, excluidas del repo.

## Construcción y arranque reproducibles

Desde la raíz del repositorio, en un entorno de construcción autorizado:

```bash
docker build -f Dockerfile.verify -t pey-hackathon:reviewed .
```

Esta construcción ejecuta TypeScript, pruebas y compilación antes de producir la imagen. Para una VPS sin código fuente, exporta/importa la imagen o usa un registro privado. No es necesario instalar credenciales de GitHub en producción.

Para una instalación nueva, con entorno privado completo y volumen nuevo:

```bash
sudo docker volume create pey-data
sudo docker run --name pey-mvp --restart unless-stopped --init -it \
  --log-driver none --stop-timeout 120 \
  --env-file /etc/pey-hackathon/pey.env \
  -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/data \
  -e WHATSAPP_PAIRING_MODE=qr \
  -p 127.0.0.1:3000:3000 -v pey-data:/data pey-hackathon:reviewed
```

No ejecutes ese comando sobre un contenedor existente. Para desacoplarte sin detenerlo: Ctrl-P, Ctrl-Q. No publicar 3000 en todas las interfaces. Conserva la clave de cifrado e identidad del volumen.

## Nginx y verificación

`session/nginx.conf` es el bootstrap HTTP para ACME; `session/hooks-tls.conf` es el sitio final. Adapta el hostname si cambia. Instala el sitio nuevo, valida `sudo nginx -t` y recarga. Obtén el certificado por webroot antes de instalar el bloque TLS. Conserva el temporizador de Certbot y un hook de recarga de Nginx; verifica `sudo certbot renew --dry-run`.

```bash
curl --fail http://127.0.0.1:3000/health
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' --data '{}' \
  https://hooks.ferarana.work/webhooks/pey
```

El segundo debe devolver `401`. `/health` no acredita vinculación ni cuenta `ACTIVE`. Firma válida + evento persistido devuelve `202`; un ID de API key incorrecto devuelve `403`; fallo al persistir, `503`. La verificación del pago ocurre después en el worker, consultando Pey.

## Actualizar y volver atrás

Construye y prueba antes de detener el servicio. Conserva la imagen anterior y un respaldo coherente del volumen con el contenedor detenido; la clave de cifrado se respalda separadamente. Nunca ejecutes dos instancias contra el mismo volumen.

Detén el contenedor, renómbralo y desactiva su reinicio automático. Crea el nuevo con el mismo entorno, volumen, puerto y política de logs. Si falla, detén y elimina solo el contenedor nuevo (sin `-v`), devuelve el nombre al anterior, restaura su política de reinicio y arráncalo. Si una actualización migra el esquema, el rollback de imagen por sí solo puede no ser suficiente: restaura también el respaldo compatible.

Para retirar solo la ruta pública, elimina el enlace `sites-enabled/pey-hooks`, valida Nginx y recarga. No reemplaces toda la configuración de Nginx con un respaldo antiguo que pueda perder cambios de otras aplicaciones.

## Diagnóstico pendiente de WhatsApp

Se añadieron `connection`, `registered`, `qrAvailable`, `statusCode` y `willReconnect`, sin volcar errores crudos ni credenciales. Un `401` desconectó la sesión sin reintento; el QR más reciente no produjo confirmación de identidad. El mensaje de passkey del teléfono no es prueba de una sesión vinculada. Se necesita observar `connection=open`, identidad verificada y la comprobación del chat propio.

La configuración actual presenta `Browsers.ubuntu("Chrome")`, mantiene `syncFullHistory=false`, usa QR por defecto y ofrece código como alternativa. No se ha confirmado que Ubuntu resuelva la incidencia. No repetir resets ni cambiar prefijos telefónicos sin evidencia.

## Archivo de la sesión de despliegue

`session/` conserva los scripts exactos preparados en esta conversación para revisión y trazabilidad. **No es un instalador genérico ni se debe ejecutar en bloque.** Usan `/home/bimah/pey-deploy`, imágenes y nombres históricos; requieren adaptar rutas al entorno. `build.sh` y `source-manifest.json` corresponden al commit original, antes de las modificaciones: su validación no debe pasarse por alto ni se aplica al árbol nuevo. `deploy.sh` fija el hash de la primera imagen.

Los scripts `update-*` se ejecutaron secuencialmente durante el diagnóstico y conservan contenedores anteriores; no reutilizarlos indiscriminadamente. `reset-whatsapp-session.py` respalda y retira únicamente el archivo de sesión con la aplicación detenida; requiere una decisión explícita de volver a vincular. Nunca elimina SQLite.

`discover-key-id.*` fue una herramienta temporal: valida firma, muestra un ID candidato y devuelve `503` deliberadamente, sin persistir ni procesar pagos. No es el receptor de producción. El ID finalmente se identificó en la entrada de la API key del portal; no se incluye aquí ningún valor privado.
