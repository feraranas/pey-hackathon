// Writes the current pairing QR of a sidecar session to a PNG and keeps it
// fresh while the QR rotates. Exits when the expected number is linked.
// The PNG is a pairing secret: it is written 0600 and never logged.
//
// Optional 4th argument: a phone number (digits, international form). The
// script then also asks WhatsApp for an 8-character linking code, writes it
// with its creation time to the 5th argument (0600), and requests a new one on
// SIGUSR1. The code is a pairing secret too and is never printed.
import { chmod, rm, writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { SidecarWhatsApp } from "../src/sidecar.js";

const [socketPath, jid, png, phone, codeFile] = process.argv.slice(2);
if (!socketPath || !jid || !png)
  throw new Error("uso: pair-qr <socket> <numero@s.whatsapp.net> <salida.png>");
let adapter: SidecarWhatsApp;
let codeTimer: NodeJS.Timeout | undefined;
let codeFailures = 0;
const askForCode = () => {
  if (!phone) return;
  clearTimeout(codeTimer);
  codeFailures = 0;
  adapter.requestPairCode(phone);
  // Answer arrives as onPairCode or onPairCodeError; the latter retries.
};
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
  onPairCode: (code) => {
    if (!codeFile) return;
    const body = `${code}\ncreado ${new Date().toISOString()} (${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })} hora de CDMX)\n`;
    writeFile(codeFile, body, { mode: 0o600 })
      .then(() => chmod(codeFile, 0o600))
      .then(() =>
        console.log(
          `${new Date().toISOString()} código de vinculación escrito`,
        ),
      )
      .catch(() => console.log("no se pudo escribir el código"));
  },
  onPairCodeError: (detail) => {
    console.log(`código de vinculación no disponible: ${detail}`);
    // Typically "not connected yet" right after start. Try again shortly.
    clearTimeout(codeTimer);
    if (++codeFailures < 20) codeTimer = setTimeout(askForCode, 3000);
  },
  onPasskeyRequest: () =>
    console.log("WhatsApp pide una passkey: paso humano pendiente"),
  onIdentity: () => {
    console.log("Número vinculado y verificado; se borra el QR");
    adapter.stop();
    Promise.all([
      rm(png, { force: true }),
      codeFile ? rm(codeFile, { force: true }) : undefined,
    ]).finally(() => process.exit(0));
  },
  onError: (e) => console.log("error:", e instanceof Error ? e.message : e),
});
await adapter.start();
if (phone) {
  process.on("SIGUSR1", askForCode);
  codeTimer = setTimeout(askForCode, 1500);
}
