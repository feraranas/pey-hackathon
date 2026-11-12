import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import Database from "better-sqlite3";
import { backup, verifyBackup } from "../src/backup.js";
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
  it("backs up Whatsmeow device stores and verifies every database", async () => {
    const root = mkdtempSync(join(tmpdir(), "pey-backup-"));
    const source = join(root, "data"),
      target = join(root, "snapshot");
    mkdirSync(source);
    new Store(join(source, "pey.sqlite"), "separate-secret").close();
    const device = new Database(join(source, "merchant-wa.db"));
    device.pragma("journal_mode = WAL");
    device.exec("CREATE TABLE d(v TEXT); INSERT INTO d VALUES('keys')");
    // The writer stays open, as a running sidecar would.
    await backup(source, target);
    device.close();
    expect(verifyBackup(target)).toEqual(["pey.sqlite", "merchant-wa.db"]);
    const copy = new Database(join(target, "merchant-wa.db"), {
      readonly: true,
    });
    expect(copy.prepare("SELECT v FROM d").get()).toEqual({ v: "keys" });
    copy.close();
    writeFileSync(join(target, "pey.sqlite"), "not a database");
    expect(() => verifyBackup(target)).toThrow();
    rmSync(root, { recursive: true });
  });
});
