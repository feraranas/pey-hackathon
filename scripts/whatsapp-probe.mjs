// Diagnostic only: credentials live in memory and disappear when this process exits.
// Never log QR content, notification bodies, messages, IDs, or credentials.
import makeWASocket, { Browsers, DisconnectReason, initAuthCreds } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

if (process.argv.includes('--self-test')) {
  if (typeof makeWASocket !== 'function' || typeof initAuthCreds !== 'function' ||
      typeof Browsers.ubuntu !== 'function' || !QRCode.create('probe').modules.size) process.exit(1);
  console.log('Dependencias disponibles; no se abrió ninguna conexión.');
  process.exit(0);
}
if (!process.stdout.isTTY) throw new Error('Se requiere una terminal privada.');
const buckets = {};
const auth = {
  creds: initAuthCreds(),
  keys: {
    async get(type, ids) {
      return Object.fromEntries(ids.filter(id => buckets[type]?.[id] != null).map(id => [id, buckets[type][id]]));
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        buckets[type] ??= {};
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value == null) delete buckets[type][id]; else buckets[type][id] = value;
        }
      }
    },
  },
};
const socket = makeWASocket({ auth, browser: Browsers.ubuntu('Chrome'), syncFullHistory: false,
  printQRInTerminal: false, logger: pino({ level: 'silent' }) });
let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  console.log(reason);
  socket.end(undefined);
  setTimeout(() => process.exit(0), 100).unref();
}
socket.ws.on('CB:notification', node => {
  const type = node?.attrs?.type;
  if (type === 'passkey_prologue_request' || type === 'crsc_continuation') {
    console.log(`DIAGNÓSTICO: WhatsApp solicitó ${type}; no se guardó ni imprimió su contenido.`);
  }
});
socket.ev.on('creds.update', update => Object.assign(auth.creds, update));
socket.ev.on('connection.update', update => {
  if (update.qr) {
    const m = QRCode.create(update.qr).modules, margin = 4, width = m.size + margin * 2;
    const dark = (r, c) => r >= margin && c >= margin && r < m.size + margin && c < m.size + margin && m.get(r - margin, c - margin);
    let out = '';
    for (let r = 0; r < width; r += 2) {
      out += '\x1b[0;30;47m';
      for (let c = 0; c < width; c++) out += dark(r,c) ? (dark(r+1,c) ? '█' : '▀') : (dark(r+1,c) ? '▄' : ' ');
      out += '\x1b[0m\n';
    }
    process.stdout.write(`QR PRIVADO: usa Dispositivos vinculados. Requiere ${width} columnas. No compartas el QR.\n${out}`);
  }
  if (update.connection === 'open') finish('DIAGNÓSTICO: conexión abierta. Sesión temporal descartada al salir; no es una sesión de producción.');
  if (update.connection === 'close') {
    const code = update.lastDisconnect?.error?.output?.statusCode;
    finish(`DIAGNÓSTICO: conexión cerrada; código=${typeof code === 'number' ? code : 'desconocido'}; loggedOut=${code === DisconnectReason.loggedOut}.`);
  }
});
setTimeout(() => finish('DIAGNÓSTICO: tiempo agotado sin completar vinculación.'), 180_000).unref();
console.log('Prueba temporal aislada: no crea archivos, no expone puertos y no envía mensajes.');
console.log('Al salir se descarta la sesión. La aplicación y su volumen permanecen intactos.');
