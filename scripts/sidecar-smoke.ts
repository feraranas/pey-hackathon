import { SidecarWhatsApp } from "../src/sidecar.js";

const [socketPath, jid] = process.argv.slice(2);
if (!socketPath || !jid)
  throw new Error("uso: sidecar-smoke <socket> <numero@s.whatsapp.net>");
let qr = 0;
const errors: string[] = [];
const adapter = new SidecarWhatsApp({
  session: "MERCHANT",
  socketPath,
  expectedOwnJids: [jid],
  allowedJids: [],
  pairedAt: Date.now(),
  onObservation: () => {},
  onEcho: () => {},
  onPairingQr: () => void qr++,
  onError: (e) => void errors.push(e instanceof Error ? e.message : "error"),
});
await adapter.start();
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_MS ?? 8000)));
console.log(
  JSON.stringify({ ready: adapter.ready, pairingQrsReceived: qr, errors }),
);
adapter.stop();
