import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockDataDirectory } from "./lifecycle.js";

/**
 * Whatsmeow device stores, one per session, kept next to pey.sqlite. They hold
 * the WhatsApp session keys in clear, so a backup only ever contains them
 * encrypted (`<name>.enc`).
 */
export const SIDECAR_STORES = ["product-wa.db", "merchant-wa.db"] as const;

const MISSING_KEY =
  "Los almacenes de Whatsmeow solo se respaldan cifrados: define SESSION_ENCRYPTION_KEY";

/** The same derivation the app uses for its encrypted columns. */
export const backupKey = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

export function encryptBytes(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function decryptBytes(data: Buffer, key: Buffer): Buffer {
  if (data.length < 29 || data[0] !== 1) throw new Error("Respaldo inválido");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
}

function integrity(path: string, label: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error(`Respaldo dañado: ${label}`);
  } finally {
    db.close();
  }
}

/**
 * Opens every database in a backup and checks it. Encrypted device stores need
 * the key. Never prints contents.
 */
export async function verifyBackup(
  directory: string,
  key?: Buffer,
): Promise<string[]> {
  const dir = resolve(directory);
  const checked: string[] = [];
  integrity(join(dir, "pey.sqlite"), "pey.sqlite");
  checked.push("pey.sqlite");
  for (const name of SIDECAR_STORES) {
    for (const stray of [name, `${name}-wal`, `${name}-shm`])
      if (await exists(join(dir, stray)))
        throw new Error(`El respaldo contiene ${stray} sin cifrar`);
    if (!(await exists(join(dir, `${name}.enc`)))) continue;
    if (!key) throw new Error(MISSING_KEY);
    const scratch = await mkdtemp(join(tmpdir(), "pey-verify-"));
    try {
      const plain = join(scratch, name);
      await writeFile(
        plain,
        decryptBytes(await readFile(join(dir, `${name}.enc`)), key),
        { mode: 0o600 },
      );
      integrity(plain, name);
      checked.push(`${name}.enc`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return checked;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function backup(
  dataDir: string,
  destination: string,
  options: { key?: Buffer } = {},
) {
  const source = resolve(dataDir),
    target = resolve(destination);
  if (source === target)
    throw new Error("El respaldo debe usar otro directorio");
  const stores: string[] = [];
  for (const name of SIDECAR_STORES)
    if (await exists(join(source, name))) stores.push(name);
  if (stores.length && !options.key) throw new Error(MISSING_KEY);
  const release = await lockDataDirectory(source);
  try {
    await mkdir(target, { mode: 0o700 });
    const db = new Database(join(source, "pey.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(join(target, "pey.sqlite"));
    } finally {
      db.close();
    }
    await chmod(join(target, "pey.sqlite"), 0o600);
    for (const name of stores) {
      const scratch = await mkdtemp(join(tmpdir(), "pey-backup-"));
      try {
        const device = new Database(join(source, name), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          await device.backup(join(scratch, name));
        } finally {
          device.close();
        }
        await writeFile(
          join(target, `${name}.enc`),
          encryptBytes(await readFile(join(scratch, name)), options.key!),
          { mode: 0o600 },
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    if (await exists(join(source, "whatsapp.enc"))) {
      await copyFile(
        join(source, "whatsapp.enc"),
        join(target, "whatsapp.enc"),
      );
      await chmod(join(target, "whatsapp.enc"), 0o600);
    }
    await writeFile(
      join(target, "README.txt"),
      "Respaldo de SQLite y sesiones. Los almacenes de Whatsmeow (.enc) y whatsapp.enc están cifrados. Conserva SESSION_ENCRYPTION_KEY por separado. Restaura con el servicio detenido.\n",
      { mode: 0o600 },
    );
  } finally {
    await release();
  }
}

/**
 * Restores a verified backup into a new, empty data directory. Device stores
 * are decrypted only inside that directory (0600).
 */
export async function restore(
  backupDir: string,
  dataDir: string,
  key?: Buffer,
): Promise<string[]> {
  const from = resolve(backupDir),
    to = resolve(dataDir);
  await verifyBackup(from, key);
  await mkdir(to, { recursive: true, mode: 0o700 });
  if ((await readdir(to)).length)
    throw new Error("El destino de la restauración debe estar vacío");
  const restored: string[] = [];
  for (const name of ["pey.sqlite", "whatsapp.enc"]) {
    if (!(await exists(join(from, name)))) continue;
    await copyFile(join(from, name), join(to, name));
    await chmod(join(to, name), 0o600);
    restored.push(name);
  }
  for (const name of SIDECAR_STORES) {
    if (!(await exists(join(from, `${name}.enc`)))) continue;
    await writeFile(
      join(to, name),
      decryptBytes(await readFile(join(from, `${name}.enc`)), key!),
      { mode: 0o600 },
    );
    restored.push(name);
  }
  return restored;
}

function keyFromEnv(): Buffer | undefined {
  const secret = process.env.SESSION_ENCRYPTION_KEY;
  return secret ? backupKey(secret) : undefined;
}

if (
  process.argv[1]?.endsWith("/backup.ts") ||
  process.argv[1]?.endsWith("/backup.js")
) {
  const [, , first, second, third] = process.argv;
  const done = (message: string) => console.log(message);
  const failed = (message: string) => (error: unknown) => {
    console.error(
      `${message}${error instanceof Error && /cifrad|vacío|inválido|dañado|sin cifrar|SESSION/.test(error.message) ? ` ${error.message}.` : ""}`,
    );
    process.exitCode = 1;
  };
  if (first === "--verify" && second)
    verifyBackup(second, keyFromEnv())
      .then((checked) => done(`Respaldo íntegro (${checked.join(", ")}).`))
      .catch(failed("El respaldo no se pudo verificar."));
  else if (first === "--restore" && second && third)
    restore(second, third, keyFromEnv())
      .then((files) => done(`Restaurado (${files.join(", ")}).`))
      .catch(failed("No se pudo restaurar."));
  else if (!first || !second || first.startsWith("--")) {
    console.error(
      "Uso: npm run backup -- DATA_DIR DESTINO_NUEVO | --verify RESPALDO | --restore RESPALDO DATA_DIR_VACÍO",
    );
    process.exitCode = 1;
  } else
    backup(first, second, { key: keyFromEnv() })
      .then(() => verifyBackup(second, keyFromEnv()))
      .then((checked) =>
        done(
          `Respaldo completado y verificado (${checked.join(", ")}). Conserva la clave de cifrado por separado.`,
        ),
      )
      .catch(
        failed(
          "No se pudo crear el respaldo. Detén el servicio y usa un destino nuevo.",
        ),
      );
}
