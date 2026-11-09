#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 && -t 0 && -t 1 ]] || { echo 'Ejecuta con sudo bash en tu terminal privada.' >&2; exit 1; }
base=/home/bimah/pey-deploy
image=pey-hackathon:15075ba59ec1767d6a7a542de284c4680337cd1b
expected=sha256:6a0fc19b5f3c9f7716208f7e50650937a9717c52de8b3a503118034dd9b0520d
[[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$expected" ]] || { echo 'La imagen no coincide con la construcción reportada.' >&2; exit 1; }
if docker container inspect pey-mvp >/dev/null 2>&1; then
    echo 'Ya existe pey-mvp. Revisar antes de actualizar.' >&2; exit 1
fi
if docker volume inspect pey-data >/dev/null 2>&1; then
    echo 'Ya existe pey-data. Revisar su identidad y clave antes de reutilizar.' >&2; exit 1
fi
if ss -H -lnt '( sport = :3000 )' | read -r _; then
    echo 'Puerto 3000 ocupado.' >&2; exit 1
fi
site=/etc/nginx/sites-available/pey-hooks
[[ ! -e "$site" && ! -L /etc/nginx/sites-enabled/pey-hooks ]] || { echo 'El sitio hooks ya existe; revisar estado antes de continuar.' >&2; exit 1; }
backup=/var/backups/pey-deploy/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$backup"
cp -a /etc/nginx "$backup/nginx"
install -d -m 755 /var/lib/letsencrypt
install -m 644 "$base/nginx.conf" "$site"
ln -s "$site" /etc/nginx/sites-enabled/pey-hooks
if ! nginx -t; then
    unlink /etc/nginx/sites-enabled/pey-hooks
    echo "No se recargó Nginx. Respaldo: $backup" >&2; exit 1
fi
systemctl reload nginx
# Reuse the existing registered Let's Encrypt account; no secret input in argv.
certbot certonly --non-interactive --webroot -w /var/lib/letsencrypt \
    -d hooks.ferarana.work --cert-name hooks.ferarana.work
install -m 644 "$base/hooks-tls.conf" "$site"
nginx -t
systemctl reload nginx
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' '/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx' > /etc/letsencrypt/renewal-hooks/deploy/pey-reload
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/pey-reload
systemctl enable --now certbot.timer
if [[ ! -f /etc/pey-hackathon/pey.env ]]; then
    python3 "$base/configure-private.py"
fi
[[ "$(stat -c '%u:%a' /etc/pey-hackathon/pey.env)" == '0:600' ]] || { echo 'Revisa propietario/permisos del archivo privado.' >&2; exit 1; }
# Validate only; do not call Pey, OpenAI or WhatsApp in this check.
docker run --rm --network none --env-file /etc/pey-hackathon/pey.env \
    --entrypoint node "$image" --input-type=module \
    -e 'import {loadConfig} from "./dist/src/config.js"; loadConfig(); console.log("Configuración válida.")'
docker volume create pey-data >/dev/null
docker create --name pey-mvp --restart unless-stopped --init -it \
    --log-driver none --stop-timeout 120 \
    --env-file /etc/pey-hackathon/pey.env \
    -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/data \
    -p 127.0.0.1:3000:3000 -v pey-data:/data "$image" >/dev/null
echo 'Arranca la aplicación. Escanea el QR PRIVADO desde el teléfono configurado.'
echo 'Docker no guardará stdout/stderr. No pegues el QR ni la salida privada en el chat.'
echo 'Para dejarla funcionando y volver a la terminal: Ctrl-P seguido de Ctrl-Q. No Ctrl-C.'
docker start -ai pey-mvp
echo 'Estado HTTP local (no acredita WhatsApp ni cuenta ACTIVE):'
curl --retry 5 --retry-connrefused --retry-delay 1 --fail --silent --show-error http://127.0.0.1:3000/health
echo
echo 'POST sin firma por HTTPS: se espera 401.'
curl --retry 5 --retry-all-errors --retry-delay 1 --silent --show-error \
    -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' \
    --data '{}' https://hooks.ferarana.work/webhooks/pey
echo 'Pendiente: confirmar WhatsApp, cuenta ACTIVE, entrega real Pey y verificación posterior del pago.'
