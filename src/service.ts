import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors';
import * as repo from './repo';
import * as engine from './engine';

export interface RoundRow {
  id: number;
  batch_id: number;
  seq: number;
  kind: string;
  rule_version_id: number;
  status: string;
  trigger_source: string;
  reason: string;
  affected_students: string;
  idempotency_key: string | null;
}

export function listRounds(db: DatabaseSync, batchId: number): RoundRow[] {
  return db.prepare('SELECT * FROM rounds WHERE batch_id=? ORDER BY seq').all(batchId) as unknown as RoundRow[];
}

function nextSeq(db: DatabaseSync, batchId: number): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM rounds WHERE batch_id=?').get(batchId) as {
    n: number;
  };
  return row.n;
}

function findIdempotent(
  db: DatabaseSync,
  batchId: number,
  key: string | undefined,
): RoundRow | undefined {
  if (!key) return undefined;
  return db
    .prepare('SELECT * FROM rounds WHERE batch_id=? AND idempotency_key=?')
    .get(batchId, key) as unknown as RoundRow | undefined;
}

export interface RunRoundInput {
  batchCode: string;
  kind: 'trial' | 'formal' | 'rerun';
  source: string;
  reason?: string;
  idempotencyKey?: string;
  clock: repo.Clock;
}

export interface RunRoundOutput {
  round: RoundRow;
  result: engine.RunResult;
  blockingPairs: engine.BlockingPair[];
  replayed: boolean;
}

/**
 * 创建并执行一轮。kind=formal 时冻结所用规则版本；结果一经写入不可覆盖。
 * 重复提交（相同幂等键）直接返回既有轮次，保证幂等。
 */
export function runRound(db: DatabaseSync, input: RunRoundInput): RunRoundOutput {
  const batch = repo.requireBatch(db, input.batchCode);
  const existing = findIdempotent(db, batch.id, input.idempotencyKey);
  if (existing) {
    return {
      round: existing,
      result: loadResult(db, existing.id),
      blockingPairs: loadBlockingPairs(db, existing.id),
      replayed: true,
    };
  }

  const issues = engine.validateApplications(db, batch.id);
  if (issues.length > 0) {
    fail('VALIDATION', '存在指向不存在专业的志愿', issues);
  }

  const rv = repo.latestRuleVersion(db, batch.id);
  const rules = engine.loadRules(db, rv.id);

  const tx = db.exec.bind(db);
  let roundId = 0;
  let round: RoundRow;
  try {
    db.exec('BEGIN IMMEDIATE');
    const seq = nextSeq(db, batch.id);
    const status = input.kind === 'trial' ? 'trial' : 'confirmed';
    db.prepare(
      `INSERT INTO rounds(batch_id,seq,kind,rule_version_id,status,trigger_source,reason,idempotency_key,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      batch.id,
      seq,
      input.kind,
      rv.id,
      status,
      input.source,
      input.reason ?? '',
      input.idempotencyKey ?? null,
      input.clock.now(),
    );
    roundId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: bigint }).id,
    );

    const result = engine.runDeferredAcceptance(db, batch.id, rules);
    persistResult(db, roundId, batch.id, result, input.clock);
    const pairs = engine.findBlockingPairs(db, batch.id, result, rules);
    persistBlockingPairs(db, roundId, pairs);

    if (input.kind === 'formal') {
      repo.freezeRuleVersion(db, rv.id);
      db.prepare("UPDATE batches SET status='admitted' WHERE id=?").run(batch.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    tx('ROLLBACK');
    throw e;
  }

  round = db.prepare('SELECT * FROM rounds WHERE id=?').get(roundId) as unknown as RoundRow;
  return {
    round,
    result: loadResult(db, roundId),
    blockingPairs: loadBlockingPairs(db, roundId),
    replayed: false,
  };
}

function persistResult(
  db: DatabaseSync,
  roundId: number,
  batchId: number,
  result: engine.RunResult,
  clock: repo.Clock,
) {
  const insP = db.prepare(
    'INSERT INTO proposals(round_id,step,student_id,major_code,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
  );
  for (const p of result.proposals) {
    insP.run(roundId, p.step, p.student_id, p.major_code, p.action, p.reason, clock.now());
  }
  const insA = db.prepare(
    'INSERT INTO admissions(round_id,batch_id,student_id,major_code,state,reject_reason,created_at) VALUES(?,?,?,?,?,?,?)',
  );
  for (const a of result.admissions) {
    insA.run(
      roundId,
      batchId,
      a.student_id,
      a.major_code,
      a.state,
      a.reject_reason,
      clock.now(),
    );
  }
}

function persistBlockingPairs(db: DatabaseSync, roundId: number, pairs: engine.BlockingPair[]) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS blocking_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      student_id INTEGER NOT NULL,
      major_code TEXT NOT NULL,
      reason TEXT NOT NULL
    )`,
  ).run();
  const ins = db.prepare(
    'INSERT INTO blocking_pairs(round_id,student_id,major_code,reason) VALUES(?,?,?,?)',
  );
  for (const p of pairs) ins.run(roundId, p.student_id, p.major_code, p.reason);
}

export function loadBlockingPairs(db: DatabaseSync, roundId: number): engine.BlockingPair[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocking_pairs'")
    .get() as { name: string } | undefined;
  if (!table) return [];
  return db
    .prepare('SELECT student_id,major_code,reason FROM blocking_pairs WHERE round_id=?')
    .all(roundId) as unknown as engine.BlockingPair[];
}

export function loadResult(db: DatabaseSync, roundId: number): engine.RunResult {
  const proposals = db
    .prepare('SELECT step,student_id,major_code,action,reason FROM proposals WHERE round_id=? ORDER BY id')
    .all(roundId) as unknown as engine.ProposalRecord[];
  const admissions = db
    .prepare(
      'SELECT student_id,major_code,state,reject_reason FROM admissions WHERE round_id=? ORDER BY student_id',
    )
    .all(roundId) as unknown as engine.AdmissionRecord[];
  const steps = proposals.reduce((m, p) => Math.max(m, p.step), 0);
  return { proposals, admissions, steps };
}

export interface WithdrawInput {
  batchCode: string;
  anonCode: string;
  source: string;
  reason: string;
  idempotencyKey?: string;
  clock: repo.Clock;
}

/**
 * 退档：只能作用于最近一轮的已录取结果；已冻结结果不被覆盖，而是生成新一轮。
 * 退档考生被标记为不符合录取资格（eligible=0），随后对全体在籍考生重跑，
 * 产生连锁补位，受影响考生在新轮次中说明。
 */
export function withdraw(db: DatabaseSync, input: WithdrawInput): RunRoundOutput {
  const batch = repo.requireBatch(db, input.batchCode);
  const existing = findIdempotent(db, batch.id, input.idempotencyKey);
  if (existing) {
    return {
      round: existing,
      result: loadResult(db, existing.id),
      blockingPairs: loadBlockingPairs(db, existing.id),
      replayed: true,
    };
  }
  const rounds = listRounds(db, batch.id);
  const last = rounds[rounds.length - 1];
  if (!last || last.status !== 'confirmed') fail('BAD_STATE', '没有可退档的已确认轮次');

  const student = db
    .prepare('SELECT * FROM students WHERE batch_id=? AND anon_code=?')
    .get(batch.id, input.anonCode) as unknown as repo.Student | undefined;
  if (!student) fail('NOT_FOUND', `考生不存在: ${input.anonCode}`);
  const prior = loadResult(db, last.id);
  const wasAdmitted = prior.admissions.find((a) => a.student_id === student.id)?.major_code;
  if (!wasAdmitted) fail('BAD_STATE', `考生 ${input.anonCode} 在最近一轮未被录取，不能退档`);

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE students SET eligible=0 WHERE id=?').run(student.id);
    db.prepare(
      `INSERT INTO score_revisions(batch_id,student_id,old_score,new_score,old_eligible,new_eligible,source,reason,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      batch.id,
      student.id,
      student.score,
      student.score,
      student.eligible,
      0,
      input.source,
      `退档：${input.reason}`,
      input.clock.now(),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return runRound(db, {
    batchCode: input.batchCode,
    kind: 'rerun',
    source: input.source,
    reason: `退档 ${input.anonCode}：${input.reason}`,
    idempotencyKey: input.idempotencyKey,
    clock: input.clock,
  });
}

export interface ScoreCorrectionInput {
  batchCode: string;
  anonCode: string;
  newScore?: number;
  eligible?: boolean;
  qualifications?: Record<string, { qualified: boolean; reason?: string }>;
  source: string;
  reason: string;
  clock: repo.Clock;
}

/** 成绩/资格更正：保留来源，本身不覆盖历史轮次；之后由 runRound 生成新一轮。 */
export function correctScore(db: DatabaseSync, input: ScoreCorrectionInput): repo.Student {
  const batch = repo.requireBatch(db, input.batchCode);
  const student = db
    .prepare('SELECT * FROM students WHERE batch_id=? AND anon_code=?')
    .get(batch.id, input.anonCode) as unknown as repo.Student | undefined;
  if (!student) fail('NOT_FOUND', `考生不存在: ${input.anonCode}`);

  const newScore = input.newScore ?? student.score;
  const newEligible = input.eligible === undefined ? student.eligible : input.eligible ? 1 : 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO score_revisions(batch_id,student_id,old_score,new_score,old_eligible,new_eligible,source,reason,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      batch.id,
      student.id,
      student.score,
      newScore,
      student.eligible,
      newEligible,
      input.source,
      input.reason,
      input.clock.now(),
    );
    db.prepare('UPDATE students SET score=?, eligible=? WHERE id=?').run(newScore, newEligible, student.id);
    for (const [majorCode, q] of Object.entries(input.qualifications ?? {})) {
      db.prepare(
        `INSERT INTO qualifications(student_id,major_code,qualified,reason,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(student_id,major_code) DO UPDATE SET
           qualified=excluded.qualified, reason=excluded.reason, updated_at=excluded.updated_at`,
      ).run(student.id, majorCode, q.qualified ? 1 : 0, q.reason ?? '', input.clock.now());
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM students WHERE id=?').get(student.id) as unknown as repo.Student;
}

export function roundById(db: DatabaseSync, id: number): RoundRow {
  const r = db.prepare('SELECT * FROM rounds WHERE id=?').get(id) as unknown as RoundRow | undefined;
  if (!r) fail('NOT_FOUND', `轮次不存在: ${id}`);
  return r;
}
