#!/usr/bin/env python3
"""Back up and remove only the failed WhatsApp auth session, with app stopped."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if os.geteuid() != 0 or not sys.stdin.isatty():
    raise SystemExit('Ejecuta con sudo python3 en una terminal privada.')

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)

mounts = json.loads(docker('inspect', '--format', '{{json .Mounts}}', 'pey-mvp'))
mount = next((m for m in mounts if m['Destination'] == '/data'), None)
if not mount or mount.get('Type') != 'volume' or mount.get('Name') != 'pey-data':
    raise SystemExit('Volumen inesperado; no se modificó nada.')
if docker('inspect', '--format', '{{.HostConfig.LogConfig.Type}}', 'pey-mvp').strip() != 'none':
    raise SystemExit('Logging inesperado; revisar privacidad antes de continuar.')
source = Path(mount['Source']) / 'whatsapp.enc'
if source.is_symlink() or not source.is_file():
    raise SystemExit('No se encontró una sesión regular; no se modificó nada.')
subprocess.run(['docker', 'stop', '-t', '120', 'pey-mvp'], check=True, stdout=subprocess.DEVNULL)
if docker('inspect', '--format', '{{.State.Running}}', 'pey-mvp').strip() != 'false':
    raise SystemExit('No se confirmó la parada; no se modificó la sesión.')
for container in docker('ps', '-q', '--filter', 'volume=pey-data').split():
    raise SystemExit('Otro contenedor usa el volumen. Servicio detenido; revisar antes de continuar.')
os.umask(0o077)
backup_root = Path('/var/backups/pey-whatsapp')
backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(backup_root, 0o700)
backup = Path(tempfile.mkdtemp(prefix='session-', dir=backup_root))
saved = backup / 'whatsapp.enc'
metadata = source.stat()
shutil.copyfile(source, saved)
os.chmod(saved, 0o600)
with saved.open('rb') as f:
    os.fsync(f.fileno())
if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(saved.read_bytes()).digest():
    raise SystemExit('Falló la verificación del respaldo; sesión original conservada, servicio detenido.')
(backup / 'restore-info.json').write_text(json.dumps({
    'original_path': str(source), 'uid': metadata.st_uid,
    'gid': metadata.st_gid, 'mode': metadata.st_mode & 0o777,
}) + '\n')
source.unlink()
print(f'Sesión anterior respaldada en {backup}. SQLite y configuración conservados.', flush=True)
print('El siguiente código es privado. Úsalo en el WhatsApp del servicio.', flush=True)
print('Para dejarlo funcionando: Ctrl-P seguido de Ctrl-Q, no Ctrl-C.', flush=True)
subprocess.run(['docker', 'start', '-ai', 'pey-mvp'], check=True)
