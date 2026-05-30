import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Where the DB lives. As an HA add-on, /data is the persisted volume; standalone falls back
 *  to the working dir. Override with COOPER_DB. */
function dbPath(): string {
  if (process.env.COOPER_DB) return process.env.COOPER_DB;
  return existsSync("/data") ? "/data/cooper.sqlite" : "./cooper.sqlite";
}

/** v2 store: just an append-only action/audit log. The bespoke engine's goals/tasks/sequence tables
 *  are gone — durable behavior now lives in HA itself (the automations/scripts Cooper authors), so the
 *  add-on holds no runtime state to persist. (Dropping better-sqlite3 entirely is a future cleanup.) */
export class Store {
  private db: Database.Database;

  constructor(path = dbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        goal_id INTEGER,
        kind    TEXT NOT NULL,
        detail  TEXT
      );
    `);
  }

  logAction(ts: number, goalId: number | null, kind: string, detail: string): void {
    this.db.prepare("INSERT INTO action_log (ts, goal_id, kind, detail) VALUES (?, ?, ?, ?)").run(ts, goalId, kind, detail);
  }
}
