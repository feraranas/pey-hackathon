import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export class Store {
  readonly db: Database.Database;
  private readonly key: Buffer;
  constructor(path: string, key: string) {
    if (!key) throw new Error("Encryption key required");
    this.key = createHash("sha256").update(key).digest();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY, self_jids TEXT NOT NULL, control_jid TEXT NOT NULL, paired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(merchant_id TEXT NOT NULL, jid TEXT NOT NULL, PRIMARY KEY(merchant_id,jid));
      CREATE TABLE IF NOT EXISTS events(chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(chat_jid,message_id));
      CREATE TABLE IF NOT EXISTS cursor(merchant_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, data_enc TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT UNIQUE, consent_id TEXT, UNIQUE(id,merchant_id), FOREIGN KEY(merchant_id) REFERENCES merchants(id));
      CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, code TEXT UNIQUE NOT NULL, text TEXT NOT NULL, version TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT UNIQUE, accepted_at INTEGER);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, chat_jid TEXT NOT NULL, account_id TEXT NOT NULL, revision INTEGER NOT NULL, FOREIGN KEY(account_id,merchant_id) REFERENCES accounts(id,merchant_id));
      CREATE TABLE IF NOT EXISTS versions(order_id TEXT NOT NULL, revision INTEGER NOT NULL, lines TEXT NOT NULL, total INTEGER, PRIMARY KEY(order_id,revision));
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, order_id TEXT NOT NULL, revision INTEGER NOT NULL, recipient TEXT NOT NULL, account_id TEXT NOT NULL, snapshot TEXT NOT NULL, digest TEXT NOT NULL, expires_at INTEGER NOT NULL, approval_state TEXT NOT NULL, creation_state TEXT NOT NULL, delivery_state TEXT NOT NULL, payment_state TEXT NOT NULL, prompt_id TEXT UNIQUE NOT NULL, UNIQUE(id,recipient));
      CREATE TABLE IF NOT EXISTS approvals(intent_id TEXT PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS charges(intent_id TEXT PRIMARY KEY, num_ref TEXT UNIQUE NOT NULL, qr_id TEXT UNIQUE, qr_enc TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, semantic_key TEXT UNIQUE NOT NULL, intent_id TEXT, recipient TEXT, message_id TEXT UNIQUE, payload_enc TEXT NOT NULL, state TEXT NOT NULL, FOREIGN KEY(intent_id,recipient) REFERENCES intents(id,recipient));
      CREATE TABLE IF NOT EXISTS webhooks(id TEXT PRIMARY KEY, event_enc TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(transaction_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, amount INTEGER NOT NULL, flags TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cash(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount INTEGER NOT NULL, message_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, order_id TEXT, media_ref TEXT NOT NULL, message_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    this.db
      .prepare("UPDATE jobs SET state='UNCERTAIN' WHERE state='IN_FLIGHT'")
      .run();
    this.db
      .prepare(
        "UPDATE intents SET creation_state='UNCERTAIN' WHERE id IN (SELECT intent_id FROM jobs WHERE kind='create_qr' AND state='UNCERTAIN')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE intents SET delivery_state='UNCERTAIN' WHERE id IN (SELECT intent_id FROM jobs WHERE kind='deliver' AND state='UNCERTAIN')",
      )
      .run();
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  decrypt<T>(value: string): T {
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  }
  close(): void {
    this.db.close();
  }
}
