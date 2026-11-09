#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Ejecuta con sudo bash.' >&2; exit 1; fi
docker inspect --format 'Contenedor={{.Name}} Imagen={{.Config.Image}} Estado={{.State.Status}} Reinicios={{.RestartCount}} Inicio={{.State.StartedAt}}' pey-mvp
docker exec pey-mvp node --input-type=module -e '
import { loadConfig } from "./dist/src/config.js";
import { encryptedAuthState } from "./dist/src/whatsapp.js";
const c = loadConfig();
const { state } = await encryptedAuthState(c.DATA_DIR + "/whatsapp.enc", Buffer.from(c.SESSION_ENCRYPTION_KEY, "hex"));
console.log(JSON.stringify({registered: state.creds.registered === true, hasPairingCode: Boolean(state.creds.pairingCode), mode: c.WHATSAPP_PAIRING_MODE}));
'
echo 'registered solo indica el estado guardado; no confirma una conexión activa.'
