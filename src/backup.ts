import Database from "better-sqlite3";
import { mkdir, copyFile, chmod, access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockDataDirectory } from "./lifecycle.js";

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
  if (!source || !destination) {
    console.error("Uso: npm run backup -- DATA_DIR DESTINO_NUEVO");
    process.exitCode = 1;
  } else
    backup(source, destination)
      .then(() =>
        console.log(
          "Respaldo completado. Conserva la clave de cifrado por separado.",
        ),
      )
      .catch(() => {
        console.error(
          "No se pudo crear el respaldo. Detén el servicio y usa un destino nuevo.",
        );
        process.exitCode = 1;
      });
}
