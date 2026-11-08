#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 && -t 0 && -t 1 ]] || { echo 'Ejecuta con sudo bash en tu terminal privada.'; exit 1; }
base=/home/bimah/pey-deploy
image=pey-hackathon:15075ba-pairing-code-1
docker container inspect pey-mvp >/dev/null
if docker container inspect pey-mvp-before-code >/dev/null 2>&1; then
  echo 'Ya existe el respaldo pey-mvp-before-code; revisar antes de continuar.'; exit 1
fi
[[ $(docker inspect --format '{{.HostConfig.LogConfig.Type}}' pey-mvp) == none ]] || { echo 'Revisar logging privado.'; exit 1; }
docker build -f "$base/source/Dockerfile.verify" -t "$image" "$base/source"
docker run --rm --network none --env-file /etc/pey-hackathon/pey.env \
  -e WHATSAPP_PAIRING_MODE=code --entrypoint node "$image" --input-type=module \
  -e 'import {loadConfig} from "./dist/src/config.js"; loadConfig(); console.log("Configuración válida")'
docker stop -t 120 pey-mvp >/dev/null
docker rename pey-mvp pey-mvp-before-code
docker update --restart=no pey-mvp-before-code >/dev/null
rollback() {
  docker rm -f pey-mvp >/dev/null 2>&1 || true
  docker rename pey-mvp-before-code pey-mvp
  docker update --restart=unless-stopped pey-mvp >/dev/null
  docker start pey-mvp >/dev/null
}
if ! docker create --name pey-mvp --restart unless-stopped --init -it \
  --log-driver none --stop-timeout 120 --env-file /etc/pey-hackathon/pey.env \
  -e HOST=0.0.0.0 -e PORT=3000 -e DATA_DIR=/data -e WHATSAPP_PAIRING_MODE=code \
  -p 127.0.0.1:3000:3000 -v pey-data:/data "$image" >/dev/null; then
  rollback; exit 1
fi
echo 'En el teléfono del servicio abre WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.'
echo 'El código es privado. Después de vincular: Ctrl-P seguido de Ctrl-Q. No Ctrl-C.'
if ! docker start -ai pey-mvp; then
  echo 'Falló el arranque; restaurando el contenedor anterior.'
  rollback; exit 1
fi
curl --retry 5 --retry-connrefused --retry-delay 1 --fail --silent --show-error http://127.0.0.1:3000/health
echo
echo 'HTTP disponible no acredita WhatsApp conectado ni cuenta bancaria ACTIVE.'
