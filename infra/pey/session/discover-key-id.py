#!/usr/bin/env python3
import getpass
import os
from pathlib import Path
import subprocess
import sys

if os.geteuid() != 0 or not sys.stdin.isatty():
    raise SystemExit('Ejecuta con sudo python3 en la nueva terminal privada.')
name = 'pey-key-discovery'
if subprocess.run(['docker', 'container', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    raise SystemExit('Ya existe el contenedor de captura; revisarlo antes de continuar.')
secret = getpass.getpass('PEY_WEBHOOK_SECRET de la API key correcta (oculto): ').strip()
if not secret.startswith('whsec_') or any(c.isspace() for c in secret):
    raise SystemExit('Secreto inválido.')
code = Path('/home/bimah/pey-deploy/discover-key-id.mjs').read_text()
image = 'pey-hackathon:15075ba59ec1767d6a7a542de284c4680337cd1b'
print('Mantén pausado el asistente original. Ctrl-C aquí detiene y elimina la captura.', flush=True)
try:
    result = subprocess.run([
        'docker', 'run', '--rm', '-i', '--name', name, '--log-driver', 'none',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64',
        '-p', '127.0.0.1:3000:3000', '--entrypoint', 'node', image,
        '--input-type=module', '-e', code,
    ], input=secret + '\n', text=True)
except KeyboardInterrupt:
    pass
finally:
    secret = ''
    subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('Captura detenida. Puerto liberado; ya puedes continuar en la terminal original.')
