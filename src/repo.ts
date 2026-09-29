import { DatabaseSync } from 'node:sqlite';
import { AppError, fail } from './errors';

export interface Clock {
  now(): string;
}

export const isoClock: Clock = { now: () => new Date().toISOString() };

export interface Student {
  id: number;
  batch_id: number;
  anon_code: string;
  score: number;
  eligible: number;
  metrics_json: string;
}

export function batchByCode(db: DatabaseSync, code: string) {
  return db.prepare('SELECT * FROM batches WHERE code=?').get(code) as
    | { id: number; code: string; name: string; status: string }
    | undefined;
}

export function requireBatch(db: DatabaseSync, code: string) {
  const b = batchByCode(db, code);
  if (!b) fail('NOT_FOUND', `批次不存在: ${code}`);
  return b!;
}

export function createBatch(db: DatabaseSync, code: string, name: string, clock: Clock) {
  try {
    db.prepare('INSERT INTO batches(code,name,created_at) VALUES(?,?,?)').run(code, name, clock.now());
  } catch (e) {
    if ((e as Error).message?.includes('UNIQUE')) fail('CONFLICT', `批次已存在: ${code}`);
    throw e;
  }
  const batch = requireBatch(db, code);
  db.prepare(
    'INSERT INTO rule_versions(batch_id,version,note,created_at) VALUES(1,?,?,?)',
  ).run(batch.id, '初始规则版本', clock.now());
  return batch;
}

export function latestRuleVersion(db: DatabaseSync, batchId: number) {
  const row = db
    .prepare('SELECT * FROM rule_versions WHERE batch_id=? ORDER BY version DESC LIMIT 1')
    .get(batchId) as { id: number; version: number; frozen: number } | undefined;
  if (!row) fail('INTERNAL', `批次 ${batchId} 缺少规则版本`);
  return row!;
}

export function ruleVersion(db: DatabaseSync, id: number) {
  return db.prepare('SELECT * FROM rule_versions WHERE id=?').get(id) as
    | { id: number; batch_id: number; version: number; frozen: number }
    | undefined;
}

export function upsertMajor(db: DatabaseSync, batchId: number, code: string, name: string, cap: number) {
  db.prepare(
    `INSERT INTO majors(batch_id,code,name,capacity) VALUES(?,?,?,?)
     ON CONFLICT(batch_id,code) DO UPDATE SET name=excluded.name, capacity=excluded.capacity`,
  ).run(batchId, code, name, cap);
}

export function majors(db: DatabaseSync, batchId: number) {
  return db
    .prepare('SELECT code,name,capacity FROM majors WHERE batch_id=? ORDER BY code')
    .all(batchId) as Array<{ code: string; name: string; capacity: number }>;
}

export function setPriorities(
  db: DatabaseSync,
  rvId: number,
  majorCode: string,
  exprs: string[],
) {
  const rv = ruleVersion(db, rvId)!;
  if (rv.frozen) fail('RULE_FROZEN', `规则版本 v${rv.version} 已冻结，不能修改优先序`);
  db.prepare('DELETE FROM priority_items WHERE rule_version_id=? AND major_code=?').run(rvId, majorCode);
  exprs.forEach((expr, i) => {
    db.prepare(
      'INSERT INTO priority_items(rule_version_id,major_code,rank,expr) VALUES(?,?,?,?)',
    ).run(rvId, majorCode, i + 1, expr);
  });
}

export function priorities(db: DatabaseSync, rvId: number) {
  return db
    .prepare('SELECT major_code,rank,expr FROM priority_items WHERE rule_version_id=? ORDER BY major_code,rank')
    .all(rvId) as Array<{ major_code: string; rank: number; expr: string }>;
}

export function freezeRuleVersion(db: DatabaseSync, rvId: number) {
  db.prepare('UPDATE rule_versions SET frozen=1 WHERE id=?').run(rvId);
}

/** 在当前版本已冻结后派生新版本，并复制既有优先序。 */
export function createNextRuleVersion(
  db: DatabaseSync,
  batchId: number,
  note: string,
  clock: Clock,
) {
  const prev = latestRuleVersion(db, batchId);
  db.prepare(
    'INSERT INTO rule_versions(batch_id,version,note,created_at) VALUES(?,?,?,?)',
  ).run(batchId, prev.version + 1, note, clock.now());
  const next = latestRuleVersion(db, batchId);
  const items = db
    .prepare('SELECT major_code,rank,expr FROM priority_items WHERE rule_version_id=? ORDER BY major_code,rank')
    .all(prev.id) as Array<{ major_code: string; rank: number; expr: string }>;
  for (const it of items) {
    db.prepare(
      'INSERT INTO priority_items(rule_version_id,major_code,rank,expr) VALUES(?,?,?,?)',
    ).run(next.id, it.major_code, it.rank, it.expr);
  }
  return { version: next.version, id: next.id };
}

export interface StudentInput {
  anon_code: string;
  score: number;
  eligible?: boolean;
  metrics?: Record<string, number>;
  qualifications?: Record<string, { qualified: boolean; reason?: string }>;
}

export function upsertStudent(
  db: DatabaseSync,
  batchId: number,
  input: StudentInput,
  clock: Clock,
) {
  const metrics = JSON.stringify(input.metrics ?? {});
  db.prepare(
    `INSERT INTO students(batch_id,anon_code,score,eligible,metrics_json,created_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(batch_id,anon_code) DO UPDATE SET
       score=excluded.score, eligible=excluded.eligible, metrics_json=excluded.metrics_json`,
  ).run(batchId, input.anon_code, input.score, input.eligible === false ? 0 : 1, metrics, clock.now());
  const s = db
    .prepare('SELECT * FROM students WHERE batch_id=? AND anon_code=?')
    .get(batchId, input.anon_code) as unknown as Student;
  for (const [majorCode, q] of Object.entries(input.qualifications ?? {})) {
    db.prepare(
      `INSERT INTO qualifications(student_id,major_code,qualified,reason,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(student_id,major_code) DO UPDATE SET
         qualified=excluded.qualified, reason=excluded.reason, updated_at=excluded.updated_at`,
    ).run(s.id, majorCode, q.qualified ? 1 : 0, q.reason ?? '', clock.now());
  }
  return s;
}

export function students(db: DatabaseSync, batchId: number): Student[] {
  return db
    .prepare('SELECT * FROM students WHERE batch_id=? ORDER BY anon_code')
    .all(batchId) as unknown as Student[];
}

export function qualificationMap(db: DatabaseSync, studentId: number) {
  const rows = db
    .prepare('SELECT major_code,qualified,reason FROM qualifications WHERE student_id=?')
    .all(studentId) as Array<{ major_code: string; qualified: number; reason: string }>;
  return new Map(rows.map((r) => [r.major_code, r]));
}

export interface AppInput {
  anon_code: string;
  ordinals: Array<{ ordinal: number; major_code: string }>;
  source: string;
  reason?: string;
}

export function replaceApplications(
  db: DatabaseSync,
  batchId: number,
  input: AppInput,
  clock: Clock,
) {
  const s = db
    .prepare('SELECT * FROM students WHERE batch_id=? AND anon_code=?')
    .get(batchId, input.anon_code) as Student | undefined;
  if (!s) fail('NOT_FOUND', `考生不存在: ${input.anon_code}`);
  const old = db
    .prepare('SELECT ordinal,major_code FROM applications WHERE batch_id=? AND student_id=? ORDER BY ordinal')
    .all(batchId, s.id) as Array<{ ordinal: number; major_code: string }>;
  const oldMap = new Map(old.map((o) => [o.ordinal, o.major_code]));
  const seen = new Set<number>();
  for (const o of input.ordinals) {
    if (seen.has(o.ordinal)) fail('VALIDATION', `志愿序号重复: ${o.ordinal}`);
    seen.add(o.ordinal);
    const prev = oldMap.get(o.ordinal) ?? null;
    if (prev !== o.major_code) {
      db.prepare(
        `INSERT INTO application_revisions(batch_id,student_id,ordinal,old_major_code,new_major_code,source,reason,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(batchId, s.id, o.ordinal, prev, o.major_code, input.source, input.reason ?? '', clock.now());
    }
  }
  for (const [ordinal, oldCode] of oldMap) {
    if (!seen.has(ordinal)) {
      db.prepare(
        `INSERT INTO application_revisions(batch_id,student_id,ordinal,old_major_code,new_major_code,source,reason,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(batchId, s.id, ordinal, oldCode, null, input.source, input.reason ?? '', clock.now());
    }
  }
  db.prepare('DELETE FROM applications WHERE batch_id=? AND student_id=?').run(batchId, s.id);
  for (const o of input.ordinals) {
    db.prepare(
      'INSERT INTO applications(batch_id,student_id,ordinal,major_code,source,created_at) VALUES(?,?,?,?,?,?)',
    ).run(batchId, s.id, o.ordinal, o.major_code, input.source, clock.now());
  }
}

export function applicationsOf(db: DatabaseSync, batchId: number, studentId: number) {
  return db
    .prepare('SELECT ordinal,major_code FROM applications WHERE batch_id=? AND student_id=? ORDER BY ordinal')
    .all(batchId, studentId) as Array<{ ordinal: number; major_code: string }>;
}

export function allApplications(db: DatabaseSync, batchId: number) {
  return db
    .prepare(
      `SELECT a.student_id, a.ordinal, a.major_code, s.anon_code
       FROM applications a JOIN students s ON s.id=a.student_id
       WHERE a.batch_id=? ORDER BY a.student_id, a.ordinal`,
    )
    .all(batchId) as Array<{ student_id: number; ordinal: number; major_code: string; anon_code: string }>;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
