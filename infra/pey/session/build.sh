#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Ejecuta con sudo bash.' >&2; exit 1; }
base=/home/bimah/pey-deploy
python3 - "$base" <<'PY'
from pathlib import Path
import sys,json,hashlib
b=Path(sys.argv[1]);m=json.loads((b/'source-manifest.json').read_text())
assert m['commit']=='15075ba59ec1767d6a7a542de284c4680337cd1b'
for e in m['files']:
 data=(b/'source'/e['path']).read_bytes()
 assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==e['sha'],e['path']
print('Archivos del commit verificados.')
PY
if ! command -v docker >/dev/null; then
    apt-get update
    apt-get install -y docker.io
fi
systemctl enable --now docker
docker build -f "$base/source/Dockerfile.verify" --target build \
    -t pey-hackathon:verify-15075ba "$base/source"
docker build --label org.opencontainers.image.revision=15075ba59ec1767d6a7a542de284c4680337cd1b \
    -t pey-hackathon:15075ba59ec1767d6a7a542de284c4680337cd1b "$base/source"
docker image inspect --format '{{.Id}}' pey-hackathon:15075ba59ec1767d6a7a542de284c4680337cd1b
echo 'Construcción y pruebas terminadas. Aún no se arrancó la aplicación ni se publicaron rutas.'
