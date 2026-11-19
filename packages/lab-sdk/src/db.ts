import Database from "better-sqlite3";
import type { LabContext } from "./context.js";

/**
 * Opens this instance's own isolated SQLite database. In process-runtime
 * mode each lab instance gets a fresh file under data/instances/<id>.db (or
 * pure :memory: for instance types that don't need a reset-by-restart
 * guarantee); in Docker mode each container has its own filesystem, so the
 * path is local to that container only. No lab instance ever opens another
 * instance's database file, and lab processes never touch the control
 * plane's data/control.db.
 */
export function openInstanceDb(ctx: LabContext): Database.Database {
  const db = new Database(ctx.instanceDbPath);
  db.pragma("journal_mode = WAL");
  return db;
}
