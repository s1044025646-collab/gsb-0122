import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let currentDb: DatabaseSync | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  version INTEGER NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, version)
);

CREATE TABLE IF NOT EXISTS majors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  UNIQUE(batch_id, code)
);

CREATE TABLE IF NOT EXISTS priority_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  major_code TEXT NOT NULL,
  rank INTEGER NOT NULL,
  expr TEXT NOT NULL,
  UNIQUE(rule_version_id, major_code, rank)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  anon_code TEXT NOT NULL,
  score INTEGER NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 1,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, anon_code)
);

CREATE TABLE IF NOT EXISTS score_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  old_score INTEGER NOT NULL,
  new_score INTEGER NOT NULL,
  old_eligible INTEGER NOT NULL,
  new_eligible INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qualifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  major_code TEXT NOT NULL,
  qualified INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(student_id, major_code)
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  ordinal INTEGER NOT NULL,
  major_code TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, student_id, ordinal)
);

CREATE TABLE IF NOT EXISTS application_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  ordinal INTEGER NOT NULL,
  old_major_code TEXT,
  new_major_code TEXT,
  source TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  status TEXT NOT NULL,
  trigger_source TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  affected_students TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, seq),
  UNIQUE(batch_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  step INTEGER NOT NULL,
  student_id INTEGER NOT NULL REFERENCES students(id),
  major_code TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_round ON proposals(round_id, step);

CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  major_code TEXT,
  state TEXT NOT NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(round_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_admissions_round ON admissions(round_id);
`;

export function openDb(file: string): DatabaseSync {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  currentDb = db;
  return db;
}

/** 迁移可重复执行：schema 全部使用 IF NOT EXISTS，此函数仅用于显式调用。 */
export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES('schema_version','1')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run();
}

export function getDb(): DatabaseSync {
  if (!currentDb) throw new Error('database not initialized');
  return currentDb;
}
