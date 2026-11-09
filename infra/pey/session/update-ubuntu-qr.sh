#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 && -t 0 && -t 1 ]] || { echo 'Ejecuta con sudo bash en tu terminal privada.'; exit 1; }
base=/home/bimah/pey-deploy
image=pey-hackathon:15075ba-ubuntu-qr-3
docker container inspect pey-mvp >/dev/null
if docker container inspect pey-mvp-before-ubuntu-qr >/dev/null 2>&1; then
  echo 'Ya existe el respaldo pey-mvp-before-ubuntu-qr; revisar antes de continuar.'; exit 1
fi
[[ $(docker inspect --format '{{.HostConfig.LogConfig.Type}}' pey-mvp) == none ]] || { echo 'Revisar logging privado.'; exit 1; }
docker build -f "$base/source/Dockerfile.verify" -t "$image" "$base/source"
docker run --rm --network none --env-file /etc/pey-hackathon/pey.env \
  -e WHATSAPP_PAIRING_MODE=qr --entrypoint node "$image" --input-type=module \
  -e 'import {loadConfig} from "./dist/src/config.js"; loadConfig(); console.log("Configuración válida")'
docker stop -t 120 pey-mvp >/dev/null
docker rename pey-mvp pey-mvp-before-ubuntu-qr
docker update --restart=no pey-mvp-before-ubuntu-qr >/dev/null
rollback() {
  docker rm -f pey-mvp >/dev/null 2>&1 || true
  docker rename pey-mvp-before-ubuntu-qr pey-mvp
  docker update --restart=unless-stopped pey-mvp >/dev/null
  docker start pey-mvp >/dev/null
}
if ! docker create --name pey-mvp --restart unless-stopped --init -it \
  --log-driver none --stop-timeout 120 --env-file /etc/pey-hackathon/pey.env \
  -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/data -e WHATSAPP_PAIRING_MODE=qr \
  -p 127.0.0.1:3000:3000 -v pey-data:/data "$image" >/dev/null; then
  rollback; exit 1
fi
# Reset only the failed auth file with a verified private backup, then attach.
python3 "$base/reset-whatsapp-session.py"
