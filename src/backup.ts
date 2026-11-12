import Database from "better-sqlite3";
import { mkdir, copyFile, chmod, access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockDataDirectory } from "./lifecycle.js";

/** Whatsmeow device stores, one per session, kept next to pey.sqlite. */
export const SIDECAR_STORES = ["product-wa.db", "merchant-wa.db"] as const;

/** Opens every database in a backup and checks it. Never prints contents. */
export function verifyBackup(directory: string): string[] {
  const checked: string[] = [];
  for (const name of ["pey.sqlite", ...SIDECAR_STORES]) {
    let db: Database.Database;
    try {
      db = new Database(join(resolve(directory), name), {
        readonly: true,
        fileMustExist: true,
      });
    } catch (error) {
      if (name !== "pey.sqlite") continue;
      throw error;
    }
    try {
      const result = db.pragma("integrity_check", { simple: true });
      if (result !== "ok") throw new Error(`Respaldo dañado: ${name}`);
      checked.push(name);
    } finally {
      db.close();
    }
  }
  return checked;
}

export async function backup(dataDir: string, destination: string) {
  const source = resolve(dataDir),
    target = resolve(destination);
  if (source === target)
    throw new Error("El respaldo debe usar otro directorio");
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
    for (const name of SIDECAR_STORES) {
      try {
        await access(join(source, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const device = new Database(join(source, name), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await device.backup(join(target, name));
      } finally {
        device.close();
      }
      await chmod(join(target, name), 0o600);
    }
    try {
      await access(join(source, "whatsapp.enc"));
      await copyFile(
        join(source, "whatsapp.enc"),
        join(target, "whatsapp.enc"),
      );
      await chmod(join(target, "whatsapp.enc"), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(
      join(target, "README.txt"),
      "Respaldo local de SQLite y sesión cifrada. Conserva SESSION_ENCRYPTION_KEY por separado. Restaura con el servicio detenido.\n",
      { mode: 0o600 },
    );
  } finally {
    await release();
  }
}
if (
  process.argv[1]?.endsWith("/backup.ts") ||
  process.argv[1]?.endsWith("/backup.js")
) {
  const [, , source, destination] = process.argv;
  if (source === "--verify" && destination) {
    try {
      console.log(
        `Respaldo íntegro (${verifyBackup(destination).join(", ")}).`,
      );
    } catch {
      console.error("El respaldo no se pudo verificar.");
      process.exitCode = 1;
    }
  } else if (!source || !destination) {
    console.error("Uso: npm run backup -- DATA_DIR DESTINO_NUEVO");
    process.exitCode = 1;
  } else
    backup(source, destination)
      .then(() => {
        const checked = verifyBackup(destination);
        console.log(
          `Respaldo completado y verificado (${checked.join(", ")}). Conserva la clave de cifrado por separado.`,
        );
      })
      .catch(() => {
        console.error(
          "No se pudo crear el respaldo. Detén el servicio y usa un destino nuevo.",
        );
        process.exitCode = 1;
      });
}
