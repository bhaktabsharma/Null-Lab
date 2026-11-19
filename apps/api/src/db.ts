import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, type Env } from "./env.js";

export type ControlDb = Database.Database;

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        is_guest INTEGER NOT NULL DEFAULT 0,
        xp INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS labs (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        family TEXT NOT NULL,
        subcategory TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        estimated_minutes INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lab_instances (
        id TEXT PRIMARY KEY,
        lab_id TEXT NOT NULL REFERENCES labs(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        port INTEGER,
        base_url TEXT,
        instance_token TEXT NOT NULL,
        pid INTEGER,
        db_path TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_instances_user ON lab_instances(user_id);
      CREATE INDEX IF NOT EXISTS idx_instances_status ON lab_instances(status);

      CREATE TABLE IF NOT EXISTS solves (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        lab_id TEXT NOT NULL REFERENCES labs(id),
        instance_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        xp_awarded INTEGER NOT NULL,
        verified_at TEXT NOT NULL,
        UNIQUE(user_id, lab_id)
      );

      CREATE TABLE IF NOT EXISTS solve_attempts (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        lab_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        resulted_in_award INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_instance ON solve_attempts(instance_id);

      CREATE TABLE IF NOT EXISTS instance_events (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_instance ON instance_events(instance_id);

      CREATE TABLE IF NOT EXISTS saved_labs (
        user_id TEXT NOT NULL,
        lab_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, lab_id)
      );

      CREATE TABLE IF NOT EXISTS preferences (
        user_id TEXT PRIMARY KEY,
        theme_preset TEXT NOT NULL DEFAULT 'ice-cyan',
        theme_custom_accent TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `,
  },
];

export function openControlDb(env: Env): ControlDb {
  const isMemory = env.DATABASE_PATH === ":memory:";
  const dbPath = isMemory
    ? ":memory:"
    : path.isAbsolute(env.DATABASE_PATH)
      ? env.DATABASE_PATH
      : path.join(REPO_ROOT, env.DATABASE_PATH);
  if (!isMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL mode needs a real file on disk; an in-memory DB (used by the
  // automated test suite) stays on the default rollback journal.
  if (!isMemory) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: ControlDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id));
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec(m.sql);
    insert.run(m.id, new Date().toISOString());
    console.log(`[db] applied migration ${m.id}`);
  }
}
