// Writes the current pairing QR of a sidecar session to a PNG and keeps it
// fresh while the QR rotates. Exits when the expected number is linked.
// The PNG is a pairing secret: it is written 0600 and never logged.
import { chmod, rm } from "node:fs/promises";
import QRCode from "qrcode";
import { SidecarWhatsApp } from "../src/sidecar.js";

const [socketPath, jid, png] = process.argv.slice(2);
if (!socketPath || !jid || !png)
  throw new Error("uso: pair-qr <socket> <numero@s.whatsapp.net> <salida.png>");
let adapter: SidecarWhatsApp;
adapter = new SidecarWhatsApp({
  session: "PRODUCT",
  socketPath,
  expectedOwnJids: [jid],
  allowedJids: [],
  pairedAt: Date.now(),
  onObservation: () => {},
  onEcho: () => {},
  onPairingQr: (code) => {
    QRCode.toFile(png, code, { width: 640, margin: 4 })
      .then(() => chmod(png, 0o600))
      .then(() => console.log(`${new Date().toISOString()} QR actualizado`))
      .catch(() => console.log("no se pudo escribir el QR"));
  },
  onPasskeyRequest: () =>
    console.log("WhatsApp pide una passkey: paso humano pendiente"),
  onIdentity: () => {
    console.log("Número vinculado y verificado; se borra el QR");
    adapter.stop();
    rm(png, { force: true }).finally(() => process.exit(0));
  },
  onError: (e) => console.log("error:", e instanceof Error ? e.message : e),
});
await adapter.start();
