#!/usr/bin/env python3
"""Collect runtime values only on the user's private interactive terminal."""
import getpass
import os
from pathlib import Path
import re
import secrets
import sys

if os.geteuid() != 0 or not sys.stdin.isatty():
    raise SystemExit('Requiere root y una terminal interactiva privada.')
target = Path('/etc/pey-hackathon/pey.env')
if target.exists():
    raise SystemExit('El archivo privado ya existe. No se sobrescribió.')

def ask(name, *, default=None, pattern=None):
    while True:
        value = getpass.getpass(name + (f' [{default}]' if default else '') + ': ').strip()
        if not value and default is not None:
            value = default
        if default == '' and not value:
            return value
        if value and not any(c in value for c in '\r\n\x00') and (not pattern or re.fullmatch(pattern, value)):
            return value
        print('Valor vacío o formato inválido; vuelve a escribirlo.')

print('Introduce los valores aquí. La entrada está oculta y no se imprime.')
print('Si ya hay un webhook en esta API key, revisa su uso antes de reemplazarlo.')
print('Portal Pey → Desarrollador → API key correcta → webhook:')
print('https://hooks.ferarana.work/webhooks/pey')
print('Guarda el secreto obtenido. El endpoint responderá cuando termine el arranque.')
values = {
    'MODE': 'live', 'HOST': '0.0.0.0', 'PORT': '3000', 'DATA_DIR': '/data',
    'PUBLIC_BASE_URL': 'https://hooks.ferarana.work',
    'SESSION_ENCRYPTION_KEY': secrets.token_hex(32),
    'PEY_API_KEY': ask('PEY_API_KEY'),
    'PEY_API_KEY_ID': ask('PEY_API_KEY_ID'),
    'PEY_WEBHOOK_SECRET': ask('PEY_WEBHOOK_SECRET', pattern=r'whsec_\S+'),
    'OPENAI_API_KEY': ask('OPENAI_API_KEY (vacío para usar el extractor determinista)', default=''),
    'OPENAI_MODEL': ask('OPENAI_MODEL', default='gpt-4.1-mini'),
    'MERCHANT_ID': ask('MERCHANT_ID', default='merchant-1'),
    'MERCHANT_JID': ask('MERCHANT_JID (WhatsApp del comerciante, número completo@s.whatsapp.net)', pattern=r'\d+@s\.whatsapp\.net'),
    'PRODUCT_JID': ask('PRODUCT_JID (número dedicado del producto, número completo@s.whatsapp.net)', pattern=r'\d+@s\.whatsapp\.net'),
    'EXTRACTION_DELAY_MS': '30000',
}
while True:
    chats = ask('ALLOWED_CHAT_JIDS (opcional; chats individuales separados por comas)', default='')
    entries = [v.strip() for v in chats.split(',') if v.strip()]
    if all(re.fullmatch(r'\d+@(s\.whatsapp\.net|lid)', v) for v in entries) and values['MERCHANT_JID'] not in entries and values['PRODUCT_JID'] not in entries and values['MERCHANT_JID'] != values['PRODUCT_JID']:
        values['ALLOWED_CHAT_JIDS'] = ','.join(entries)
        break
    print('Revisa los JID. El chat propio no debe estar en la lista de clientes.')
target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(target.parent, 0o700)
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(''.join(f'{k}={v}\n' for k,v in values.items() if v != ''))
    f.flush()
    os.fsync(f.fileno())
print('Configuración guardada en /etc/pey-hackathon/pey.env (root, 0600).')
print('Se generó una clave de cifrado nueva. Respalda este archivo en un lugar privado; no la regeneres para este volumen.')
