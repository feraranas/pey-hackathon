import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import Database from "better-sqlite3";
import { backup, backupKey, restore, verifyBackup } from "../src/backup.js";
import { lockDataDirectory } from "../src/lifecycle.js";

describe("persistent service lifecycle", () => {
  it("excludes simultaneous processes before opening the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pey-lock-"));
    const release = await lockDataDirectory(dir);
    await expect(lockDataDirectory(dir)).rejects.toMatchObject({
      code: "ELOCKED",
    });
    await release();
    const next = await lockDataDirectory(dir);
    await next();
    rmSync(dir, { recursive: true });
  });
  it("restores encrypted data and session from a SQLite backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "pey-backup-"));
    const source = join(root, "data"),
      target = join(root, "snapshot");
    mkdirSync(source);
    const store = new Store(join(source, "pey.sqlite"), "separate-secret");
    store.db
      .prepare("INSERT INTO webhooks VALUES(?,?,?)")
      .run("w1", store.encrypt({ private: "sensitive" }), "DONE");
    store.close();
    writeFileSync(join(source, "whatsapp.enc"), Buffer.from([1, 2, 3, 4]));
    await backup(source, target);
    const restored = new Store(join(target, "pey.sqlite"), "separate-secret");
    const row = restored.db
      .prepare("SELECT event_enc FROM webhooks WHERE id=?")
      .get("w1") as { event_enc: string };
    expect(restored.decrypt(row.event_enc)).toEqual({ private: "sensitive" });
    expect(readFileSync(join(target, "whatsapp.enc"))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    restored.close();
    rmSync(root, { recursive: true });
  });
  it("backs up Whatsmeow device stores only encrypted, verifies them, and restores them", async () => {
    const root = mkdtempSync(join(tmpdir(), "pey-backup-"));
    const source = join(root, "data"),
      target = join(root, "snapshot"),
      restored = join(root, "restored");
    const key = backupKey("separate-secret");
    mkdirSync(source);
    new Store(join(source, "pey.sqlite"), "separate-secret").close();
    const device = new Database(join(source, "merchant-wa.db"));
    device.pragma("journal_mode = WAL");
    device.exec(
      "CREATE TABLE d(v TEXT); INSERT INTO d VALUES('wa-session-key')",
    );
    // The writer stays open, as a running sidecar would.
    await backup(source, target, { key });
    device.close();
    // No plaintext device keys anywhere in the backup.
    for (const file of readdirSync(target))
      expect(readFileSync(join(target, file)).includes("wa-session-key")).toBe(
        false,
      );
    expect(readdirSync(target)).toContain("merchant-wa.db.enc");
    expect(await verifyBackup(target, key)).toEqual([
      "pey.sqlite",
      "merchant-wa.db.enc",
    ]);
    await expect(verifyBackup(target)).rejects.toThrow(
      "SESSION_ENCRYPTION_KEY",
    );
    await expect(verifyBackup(target, backupKey("wrong"))).rejects.toThrow();
    expect(await restore(target, restored, key)).toEqual([
      "pey.sqlite",
      "merchant-wa.db",
    ]);
    const copy = new Database(join(restored, "merchant-wa.db"), {
      readonly: true,
    });
    expect(copy.prepare("SELECT v FROM d").get()).toEqual({
      v: "wa-session-key",
    });
    copy.close();
    await expect(restore(target, restored, key)).rejects.toThrow("vacío");
    writeFileSync(join(target, "pey.sqlite"), "not a database");
    await expect(verifyBackup(target, key)).rejects.toThrow();
    rmSync(root, { recursive: true });
  });
  it("refuses to back up device stores without a key and rejects stray plaintext copies", async () => {
    const root = mkdtempSync(join(tmpdir(), "pey-backup-"));
    const source = join(root, "data"),
      target = join(root, "snapshot");
    mkdirSync(source);
    new Store(join(source, "pey.sqlite"), "k").close();
    new Database(join(source, "product-wa.db")).close();
    await expect(backup(source, target)).rejects.toThrow(
      "SESSION_ENCRYPTION_KEY",
    );
    expect(existsSync(target)).toBe(false);
    await backup(source, target, { key: backupKey("k") });
    writeFileSync(join(target, "product-wa.db"), "plain");
    await expect(verifyBackup(target, backupKey("k"))).rejects.toThrow(
      "sin cifrar",
    );
    rmSync(root, { recursive: true });
  });
});
