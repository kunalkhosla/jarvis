import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface Goal {
  id: number;
  text: string;
  type: "watch" | "do";
  created: number;
  lastRun: number;
  expires: number | null;   // epoch ms after which the goal auto-stands-down; null = open-ended
  untilPresent: boolean;    // away-watch: stand down when everyone is home again
  sawAway: boolean;         // has anyone been away since this goal started? (gates untilPresent)
}

/** A deferred do-goal: a one-shot task that fires on a trigger (a scheduled time and/or when
 *  someone arrives home), rather than immediately. E.g. "prepare the home for my arrival". */
export interface Task {
  id: number;
  text: string;
  created: number;
  runAt: number | null;   // epoch ms to fire at; null = not time-triggered
  onArrival: boolean;     // fire when a household member arrives home
}

/** Where the DB lives. As an HA add-on, /data is the persisted volume; standalone falls back
 *  to the working dir. Override with COOPER_DB. */
function dbPath(): string {
  if (process.env.COOPER_DB) return process.env.COOPER_DB;
  return existsSync("/data") ? "/data/cooper.sqlite" : "./cooper.sqlite";
}

/** Durable store for watch-goals + an action/audit log. Survives add-on restarts (the v0.2
 *  in-memory store wiped every goal on restart). Do-goals are one-shot and are NOT persisted. */
export class Store {
  private db: Database.Database;

  constructor(path = dbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        text     TEXT NOT NULL,
        type     TEXT NOT NULL CHECK (type IN ('watch','do')),
        created  INTEGER NOT NULL,
        last_run INTEGER NOT NULL DEFAULT 0,
        expires  INTEGER,
        until_present INTEGER NOT NULL DEFAULT 0,
        saw_away INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS action_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        goal_id INTEGER,
        kind    TEXT NOT NULL,
        detail  TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        text       TEXT NOT NULL,
        created    INTEGER NOT NULL,
        run_at     INTEGER,
        on_arrival INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migrate older DBs that predate later columns (ignore if already present).
    for (const col of ["expires INTEGER", "until_present INTEGER NOT NULL DEFAULT 0", "saw_away INTEGER NOT NULL DEFAULT 0"])
      try { this.db.exec(`ALTER TABLE goals ADD COLUMN ${col}`); } catch { /* already present */ }
  }

  /** All persisted (watch) goals, oldest first — loaded into memory at boot. */
  watchGoals(): Goal[] {
    const rows = this.db
      .prepare("SELECT id, text, type, created, last_run AS lastRun, expires, until_present, saw_away FROM goals ORDER BY id")
      .all() as Array<{ id: number; text: string; type: "watch" | "do"; created: number; lastRun: number; expires: number | null; until_present: number; saw_away: number }>;
    return rows.map((r) => ({
      id: r.id, text: r.text, type: r.type, created: r.created, lastRun: r.lastRun,
      expires: r.expires, untilPresent: !!r.until_present, sawAway: !!r.saw_away,
    }));
  }

  addGoal(text: string, created: number, lastRun: number, expires: number | null = null, untilPresent = false): Goal {
    const info = this.db
      .prepare("INSERT INTO goals (text, type, created, last_run, expires, until_present) VALUES (?, 'watch', ?, ?, ?, ?)")
      .run(text, created, lastRun, expires, untilPresent ? 1 : 0);
    return { id: Number(info.lastInsertRowid), text, type: "watch", created, lastRun, expires, untilPresent, sawAway: false };
  }

  touchGoal(id: number, lastRun: number): void {
    this.db.prepare("UPDATE goals SET last_run = ? WHERE id = ?").run(lastRun, id);
  }

  setSawAway(id: number): void {
    this.db.prepare("UPDATE goals SET saw_away = 1 WHERE id = ?").run(id);
  }

  deleteGoal(id: number): boolean {
    return this.db.prepare("DELETE FROM goals WHERE id = ?").run(id).changes > 0;
  }

  logAction(ts: number, goalId: number | null, kind: string, detail: string): void {
    this.db.prepare("INSERT INTO action_log (ts, goal_id, kind, detail) VALUES (?, ?, ?, ?)").run(ts, goalId, kind, detail);
  }

  // ---- Deferred tasks ----
  tasks(): Task[] {
    const rows = this.db
      .prepare("SELECT id, text, created, run_at, on_arrival FROM tasks ORDER BY id")
      .all() as Array<{ id: number; text: string; created: number; run_at: number | null; on_arrival: number }>;
    return rows.map((r) => ({ id: r.id, text: r.text, created: r.created, runAt: r.run_at, onArrival: !!r.on_arrival }));
  }

  addTask(text: string, created: number, runAt: number | null, onArrival: boolean): Task {
    const info = this.db
      .prepare("INSERT INTO tasks (text, created, run_at, on_arrival) VALUES (?, ?, ?, ?)")
      .run(text, created, runAt, onArrival ? 1 : 0);
    return { id: Number(info.lastInsertRowid), text, created, runAt, onArrival };
  }

  deleteTask(id: number): boolean {
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
  }
}
