import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

let instance: DatabaseSync | null = null

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'created',
  current_round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  label TEXT NOT NULL,
  tiebreak_keys TEXT NOT NULL DEFAULT '["score_desc","candidate_id_asc"]',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, label)
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  round_no INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'initial',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, round_no)
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  anon_code TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 1,
  score INTEGER NOT NULL,
  score_source TEXT NOT NULL,
  score_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, anon_code)
);

CREATE TABLE IF NOT EXISTS score_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  round_no INTEGER NOT NULL,
  old_score INTEGER,
  new_score INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  round_no INTEGER NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  eligible INTEGER NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, round_no, program_id)
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  priority_rule_version INTEGER REFERENCES rule_versions(id),
  priority_order TEXT NOT NULL DEFAULT 'score_desc,candidate_id_asc',
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, code)
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  rank_no INTEGER NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  source TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(round_id, candidate_id, rank_no),
  UNIQUE(round_id, candidate_id, program_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  round_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'computed',
  input_digest TEXT NOT NULL,
  blocked_pairs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(round_id, kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  round INTEGER NOT NULL,
  type TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  program_id INTEGER,
  detail TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  rank_no INTEGER NOT NULL,
  UNIQUE(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  round_no INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  program_id INTEGER NOT NULL REFERENCES programs(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  status TEXT NOT NULL DEFAULT 'admitted',
  idempotency_key TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE(batch_id, candidate_id),
  UNIQUE(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  round_no INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  program_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  new_round_no INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_ref INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(scope, idempotency_key)
);
`

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  db.exec(
    `INSERT INTO schema_migrations(version, applied_at)
     VALUES (1, datetime('now'))
     ON CONFLICT(version) DO NOTHING`,
  )
 return db
}

export function getDatabase(path = process.env.TOUDANG_DB ?? 'data/app.db'): DatabaseSync {
  if (!instance) {
    instance = openDatabase(path)
  }
  return instance
}

export function closeDatabase(): void {
  if (instance) {
    instance.close()
    instance = null
  }
}

export function resetDatabase(path?: string): DatabaseSync {
  closeDatabase()
  instance = openDatabase(path ?? process.env.TOUDANG_DB ?? 'data/app.db')
  return instance
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
