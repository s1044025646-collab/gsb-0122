import { DatabaseSync } from 'node:sqlite';
import { deterministicTiebreak } from './hash';
import { fail } from './errors';
import * as repo from './repo';

export interface Applicant {
  student: repo.Student;
  metrics: Record<string, number>;
  tie: string;
}

function metric(s: repo.Student): Record<string, number> {
  try {
    return JSON.parse(s.metrics_json) as Record<string, number>;
  } catch {
    return {};
  }
}

function exprValue(expr: string, a: Applicant): number | string {
  const e = expr.trim();
  if (e === 'tiebreak(anon)') return a.tie;
  const m = e.match(/^(score|metric\.[A-Za-z_][A-Za-z0-9_]*)\s+(desc|asc)$/);
  if (!m) fail('VALIDATION', `不支持的优先序表达式: ${e}`);
  if (m![1] === 'score') return a.student.score;
  return a.metrics[m![1].slice('metric.'.length)] ?? 0;
}

function isDesc(expr: string): boolean {
  return /\bdesc\b/.test(expr);
}

/** 依据冻结优先序比较申请人；末位确定性哈希保证全序。返回 1 表示 a 优先。 */
export function compareApplicant(exprs: string[], a: Applicant, b: Applicant): number {
  for (const raw of exprs) {
    const expr = raw.trim();
    if (expr === 'tiebreak(anon)') {
      if (a.tie === b.tie) continue;
      return a.tie < b.tie ? 1 : -1;
    }
    const va = exprValue(expr, a) as number;
    const vb = exprValue(expr, b) as number;
    if (va === vb) continue;
    const greater = va > vb;
    return greater === isDesc(expr) ? 1 : -1;
  }
  return 0;
}

function defaultExprs(): string[] {
  return ['score desc', 'tiebreak(anon)'];
}

export interface PriorityRules {
  byMajor: Map<string, string[]>;
}

export function loadRules(db: DatabaseSync, rvId: number): PriorityRules {
  const byMajor = new Map<string, string[]>();
  for (const p of repo.priorities(db, rvId)) {
    const list = byMajor.get(p.major_code) ?? [];
    list.push(p.expr);
    byMajor.set(p.major_code, list);
  }
  return { byMajor };
}

function exprsFor(rules: PriorityRules, majorCode: string): string[] {
  const list = rules.byMajor.get(majorCode);
  if (!list || list.length === 0) return defaultExprs();
  if (!list.some((e) => e.trim() === 'tiebreak(anon)')) return [...list, 'tiebreak(anon)'];
  return list;
}

export interface ValidationIssue {
  anon_code: string;
  ordinal: number;
  major_code: string;
  issue: string;
}

export function validateApplications(db: DatabaseSync, batchId: number): ValidationIssue[] {
  const majorSet = new Set(repo.majors(db, batchId).map((m) => m.code));
  const issues: ValidationIssue[] = [];
  for (const app of repo.allApplications(db, batchId)) {
    if (!majorSet.has(app.major_code)) {
      issues.push({
        anon_code: app.anon_code,
        ordinal: app.ordinal,
        major_code: app.major_code,
        issue: '专业不存在',
      });
    }
  }
  return issues;
}

export interface ProposalRecord {
  step: number;
  student_id: number;
  major_code: string;
  action: 'apply' | 'held' | 'reject';
  reason: string;
}

export interface AdmissionRecord {
  student_id: number;
  major_code: string | null;
  state: 'admitted' | 'unassigned';
  reject_reason: string;
}

export interface RunResult {
  proposals: ProposalRecord[];
  admissions: AdmissionRecord[];
  steps: number;
}

/**
 * 考生发起的延迟接受（多轮投档）。不自动补填专业；资格不符立即拒绝并说明原因。
 */
export function runDeferredAcceptance(
  db: DatabaseSync,
  batchId: number,
  rules: PriorityRules,
  opts: { activeStudentIds?: Set<number> } = {},
): RunResult {
  const majorRows = new Map(repo.majors(db, batchId).map((m) => [m.code, m]));
  const students = repo.students(db, batchId).filter(
    (s) => (!opts.activeStudentIds || opts.activeStudentIds.has(s.id)) && s.eligible === 1,
  );

  const prefs = new Map<number, Array<{ ordinal: number; major_code: string }>>();
  for (const s of students) {
    const list = repo
      .applicationsOf(db, batchId, s.id)
      .filter((a) => majorRows.has(a.major_code));
    prefs.set(s.id, list);
  }

  const makeApplicant = (s: repo.Student): Applicant => ({
    student: s,
    metrics: metric(s),
    tie: deterministicTiebreak(['anon', s.anon_code]),
  });
  const applicantById = new Map(students.map((s) => [s.id, makeApplicant(s)]));

  const proposals: ProposalRecord[] = [];
  const nextIndex = new Map<number, number>();
  const held = new Map<string, number[]>();
  const finalSeat = new Map<number, string>();
  const exhaustReason = new Map<number, string>();

  let active: number[] = students.map((s) => s.id);
  let step = 0;
  const qualCache = new Map<number, Map<string, { qualified: number; reason: string }>>();
  const qualOf = (sid: number) => {
    let q = qualCache.get(sid);
    if (!q) {
      q = repo.qualificationMap(db, sid);
      qualCache.set(sid, q);
    }
    return q;
  };

  while (active.length > 0) {
    step += 1;
    const newlyRejected: number[] = [];
    for (const sid of active) {
      const idx = nextIndex.get(sid) ?? 0;
      const list = prefs.get(sid)!;
      if (idx >= list.length) {
        exhaustReason.set(sid, '志愿已全部检索，未被任何专业暂留');
        continue;
      }
      const choice = list[idx];
      nextIndex.set(sid, idx + 1);
      const major = majorRows.get(choice.major_code)!;
      proposals.push({ step, student_id: sid, major_code: major.code, action: 'apply', reason: '' });

      const q = qualOf(sid).get(major.code);
      if (q && q.qualified === 0) {
        proposals.push({
          step,
          student_id: sid,
          major_code: major.code,
          action: 'reject',
          reason: `资格不符：${q.reason || '未通过资格审核'}`,
        });
        newlyRejected.push(sid);
        continue;
      }

      if (major.capacity <= 0) {
        proposals.push({ step, student_id: sid, major_code: major.code, action: 'reject', reason: '专业容量为零' });
        newlyRejected.push(sid);
        continue;
      }

      const pool = held.get(major.code) ?? [];
      pool.push(sid);
      const exprs = exprsFor(rules, major.code);
      pool.sort((x, y) => compareApplicant(exprs, applicantById.get(y)!, applicantById.get(x)!));
      if (pool.length > major.capacity) {
        const dropped = pool.pop()!;
        finalSeat.delete(dropped);
        proposals.push({
          step,
          student_id: dropped,
          major_code: major.code,
          action: 'reject',
          reason: `容量 ${major.capacity} 已满，按冻结优先序排名靠后`,
        });
        newlyRejected.push(dropped);
      }
      held.set(major.code, pool);
      for (const kept of pool) finalSeat.set(kept, major.code);
      proposals.push({ step, student_id: sid, major_code: major.code, action: 'held', reason: '' });
    }
    active = newlyRejected;
  }

  const admissions: AdmissionRecord[] = students.map((s) => {
    const code = finalSeat.get(s.id) ?? null;
    return {
      student_id: s.id,
      major_code: code,
      state: code ? 'admitted' : 'unassigned',
      reject_reason: code ? '' : exhaustReason.get(s.id) ?? '未录取',
    };
  });

  return { proposals, admissions, steps: step };
}

export interface BlockingPair {
  student_id: number;
  major_code: string;
  reason: string;
}

/** 阻塞对核验：考生更偏好的、资格符合的专业仍有空位，或其按优先序优于已录取者。 */
export function findBlockingPairs(
  db: DatabaseSync,
  batchId: number,
  result: RunResult,
  rules: PriorityRules,
): BlockingPair[] {
  const majorRows = new Map(repo.majors(db, batchId).map((m) => [m.code, m]));
  const currentMajor = new Map<number, string | null>(
    result.admissions.map((a) => [a.student_id, a.major_code]),
  );
  const seats = new Map<string, number[]>();
  for (const a of result.admissions) {
    if (a.major_code) seats.set(a.major_code, [...(seats.get(a.major_code) ?? []), a.student_id]);
  }
  const studentById = new Map(repo.students(db, batchId).map((s) => [s.id, s]));

  const makeApplicant = (s: repo.Student): Applicant => ({
    student: s,
    metrics: metric(s),
    tie: deterministicTiebreak(['anon', s.anon_code]),
  });

  const pairs: BlockingPair[] = [];
  for (const adm of result.admissions) {
    const s = studentById.get(adm.student_id);
    if (!s || s.eligible !== 1) continue;
    const list = repo.applicationsOf(db, batchId, s.id);
    const ranks = new Map(list.map((p, i) => [p.major_code, i]));
    const currentRank = adm.major_code ? ranks.get(adm.major_code) : undefined;
    const applicant = makeApplicant(s);
    const quals = repo.qualificationMap(db, s.id);
    for (const [majorCode, rank] of ranks) {
      if (currentRank !== undefined && rank >= currentRank) continue;
      const q = quals.get(majorCode);
      if (q && q.qualified === 0) continue;
      const major = majorRows.get(majorCode);
      if (!major || major.capacity <= 0) continue;
      const occupants = seats.get(majorCode) ?? [];
      if (occupants.length < major.capacity) {
        pairs.push({ student_id: s.id, major_code: majorCode, reason: '专业仍有空位且考生更偏好该专业' });
        continue;
      }
      const exprs = exprsFor(rules, majorCode);
      const weakest = occupants
        .map((oid) => ({ oid, a: makeApplicant(studentById.get(oid)!) }))
        .sort((x, y) => compareApplicant(exprs, y.a, x.a))
        .pop()!;
      if (compareApplicant(exprs, applicant, weakest.a) > 0) {
        pairs.push({
          student_id: s.id,
          major_code: majorCode,
          reason: `按冻结优先序该考生优于已录取者 ${weakest.a.student.anon_code}`,
        });
      }
    }
  }
  return pairs;
}
