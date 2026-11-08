import http from 'node:http';
import { Webhook } from 'standardwebhooks';

// Secret arrives through stdin, never Docker arguments, environment or disk.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const verifier = new Webhook(input.trim());
input = '';
const server = http.createServer(async (req, res) => {
  const reply = (code) => { res.writeHead(code, { 'Cache-Control': 'no-store' }); res.end(); };
  if (req.method !== 'POST' || req.url !== '/webhooks/pey') return reply(404);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) { reply(413); req.destroy(); return; }
      chunks.push(chunk);
    }
    const headers = {};
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      if (typeof req.headers[name] !== 'string') return reply(401);
      headers[name] = req.headers[name];
    }
    let event;
    try { event = verifier.verify(Buffer.concat(chunks).toString('utf8'), headers); }
    catch { return reply(401); }
    if (event?.type === 'codi.qr.payment_received' &&
        typeof event.apiKeyId === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(event.apiKeyId)) {
      console.log('Firma válida. apiKeyId candidato: ' + event.apiKeyId);
      console.log('Confirma que Pey usa datos de tu API key, no una plantilla ficticia.');
    } else {
      console.log('Firma válida; no contiene un apiKeyId de QR con formato ULID utilizable.');
    }
    // Discovery does not persist events: never acknowledge a payment as accepted.
    res.setHeader('Retry-After', '60');
    reply(503);
  } catch { if (!res.headersSent) reply(400); else res.destroy(); }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(3000, '0.0.0.0', () => {
  console.log('Captura temporal lista. Envía la prueba desde Pey a https://hooks.ferarana.work/webhooks/pey');
  console.log('Sin firma: 401. Con firma: 503 deliberado; no se guardan ni procesan pagos.');
});
setTimeout(() => process.exit(0), 10 * 60 * 1000);
