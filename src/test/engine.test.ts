import test from 'node:test';
import assert from 'node:assert/strict';
import * as repo from '../repo';
import * as service from '../service';
import * as engine from '../engine';
import { runScenario, tempDb, clock } from './helpers';
import {
  cascade,
  tie,
  zeroCapacity,
  allReject,
  qualification,
  concurrent,
} from '../fixtures';
import {
  enumerateFeasible,
  hasBlockingPair,
  isFeasible,
  ExStudent,
  ExMajor,
} from '../exhaustive';

test('连锁挤出：S2 被挤出 A 后顺延占据 B，S3 最终落选', () => {
  const { result, pairs, db } = runScenario(cascade);
  const by = new Map(result.admissions.map((a) => [a.student_id, a]));
  const id = (code: string) =>
    (db.prepare('SELECT id FROM students WHERE anon_code=?').get(code) as { id: number }).id;
  assert.equal(by.get(id('S1'))!.major_code, 'A');
  assert.equal(by.get(id('S2'))!.major_code, 'B');
  assert.equal(by.get(id('S3'))!.state, 'unassigned');
  assert.ok(result.steps >= 2, '必须是多轮投档而非顺序贪心');
  assert.equal(pairs.length, 0);
});

test('同分：确定性哈希决定唯一席位，且结果可重放', () => {
  const a = runScenario(tie);
  const b = runScenario(tie);
  const pick = (r: ReturnType<typeof runScenario>) =>
    r.result.admissions.find((x) => x.major_code === 'B')!.student_id;
  assert.equal(pick(a), pick(b), '重放必须得到相同的同分胜出者');
  assert.equal(a.pairs.length, 0);
  const winner = (a.db.prepare('SELECT anon_code FROM students WHERE id=?').get(pick(a)) as any).anon_code;
  assert.ok(['S2', 'S3'].includes(winner));
});

test('零容量：申请被拒绝并给出原因，考生顺延下一志愿', () => {
  const { result } = runScenario(zeroCapacity);
  const rej = result.proposals.find((p) => p.action === 'reject' && p.major_code === 'Z');
  assert.ok(rej);
  assert.match(rej!.reason, /容量为零/);
  const adm = result.admissions.find((x) => x.state === 'admitted');
  assert.equal(adm!.major_code, 'A');
});

test('全部落选：所有考生 unassigned 且有原因', () => {
  const { result, pairs } = runScenario(allReject);
  assert.ok(result.admissions.every((a) => a.state === 'unassigned'));
  assert.ok(result.admissions.every((a) => a.reject_reason.length > 0));
  assert.equal(pairs.length, 0);
});

test('资格不符：S1 被 A 拒绝并说明原因，顺延录取 B', () => {
  const { result, db } = runScenario(qualification);
  const qrej = result.proposals.find((p) => p.action === 'reject' && p.major_code === 'A');
  assert.match(qrej!.reason, /资格不符/);
  assert.match(qrej!.reason, /体检/);
  const s1id = (db.prepare('SELECT id FROM students WHERE anon_code=?').get('S1') as { id: number }).id;
  const s1 = result.admissions.find((a) => a.student_id === s1id);
  assert.equal(s1!.major_code, 'B');
  assert.ok(s1);
});

test('容量约束：任何专业录取人数不超过容量', () => {
  for (const scenario of [cascade, tie, zeroCapacity, allReject, qualification, concurrent]) {
    const { result, db, batch } = runScenario(scenario);
    const caps = new Map(repo.majors(db, batch.id).map((m) => [m.code, m.capacity]));
    const counts = new Map<string, number>();
    for (const a of result.admissions)
      if (a.major_code) counts.set(a.major_code, (counts.get(a.major_code) ?? 0) + 1);
    for (const [m, n] of counts) assert.ok(n <= caps.get(m)!, `${scenario.key}: ${m} 超容量`);
  }
});

test('不会自动补填未填报专业', () => {
  const { result, db } = runScenario(cascade);
  const s3 = result.admissions.find((a) => {
    const code = (db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id) as any).anon_code;
    return code === 'S3';
  })!;
  assert.equal(s3.major_code, null);
});

test('小规模穷举：DA 结果可行且稳定，稳定匹配无阻塞对', () => {
  const prefs = [
    [0, 1],
    [0],
    [1],
  ];
  const score = [90, 80, 70];
  const students: ExStudent[] = prefs.map((p, id) => ({
    id,
    prefs: p,
    rankApplicant: (other: number) => score[other] - score[id],
  }));
  const majors: ExMajor[] = [
    { id: 0, capacity: 1, prefers: (a, b) => score[a] > score[b], qualified: () => true },
    { id: 1, capacity: 1, prefers: (a, b) => score[a] > score[b], qualified: () => true },
  ];
  const feasible = enumerateFeasible(students, majors);
  assert.ok(feasible.length >= 2);
  const daMatch = new Map<number, number>([
    [0, 0],
    [2, 1],
  ]);
  assert.ok(isFeasible({ match: daMatch }, majors, [0, 1, 2]));
  assert.equal(hasBlockingPair({ match: daMatch }, students, majors), false);
});

test('重放确定性：相同输入两次投档申请轨迹完全一致', () => {
  const a = runScenario(cascade);
  const b = runScenario(cascade);
  assert.deepEqual(a.result.proposals, b.result.proposals);
});

test('退档与成绩更正生成新轮次，已冻结结果不可覆盖', () => {
  const { db, code } = runScenario(concurrent);
  const formal = service.runRound(db, {
    batchCode: code,
    kind: 'formal',
    source: 'test',
    idempotencyKey: 'f1',
    clock,
  });
  const frozenResult = service.loadResult(db, formal.round.id);

  service.withdraw(db, {
    batchCode: code,
    anonCode: 'S1',
    source: 'test',
    reason: '档案问题',
    idempotencyKey: 'w1',
    clock,
  });
  const afterWithdraw = service.loadResult(db, formal.round.id);
  assert.deepEqual(afterWithdraw.admissions, frozenResult.admissions, '冻结轮次结果不被覆盖');

  const rounds = service.listRounds(db, formal.round.batch_id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1].kind, 'rerun');
});

test('幂等：重复确认返回同一轮次', () => {
  const { db, code } = runScenario(concurrent);
  const a = service.runRound(db, { batchCode: code, kind: 'formal', source: 't', idempotencyKey: 'K', clock });
  const b = service.runRound(db, { batchCode: code, kind: 'formal', source: 't', idempotencyKey: 'K', clock });
  assert.equal(a.round.id, b.round.id);
  assert.equal(b.replayed, true);
});

test('事务回滚：无效志愿导致投档失败时不残留轮次', () => {
  const { db, code } = runScenario(cascade);
  const batch = repo.requireBatch(db, code);
  repo.replaceApplications(
    db,
    batch.id,
    { anon_code: 'S1', ordinals: [{ ordinal: 1, major_code: 'GHOST' }], source: 'test' },
    clock,
  );
  assert.throws(
    () => service.runRound(db, { batchCode: code, kind: 'trial', source: 't', clock }),
    /不存在/,
  );
  const count = (db.prepare('SELECT COUNT(*) c FROM rounds').get() as any).c;
  assert.equal(count, 0);
});

test('重启持久化：关闭并以相同文件重开，结果仍可读取', () => {
  const { db, file, code } = runScenario(cascade);
  const out = service.runRound(db, { batchCode: code, kind: 'formal', source: 't', idempotencyKey: 'p', clock });
  db.close();
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const reopened = new DatabaseSync(file);
  const loaded = service.loadResult(reopened, out.round.id);
  assert.equal(loaded.admissions.length, out.result.admissions.length);
  reopened.close();
});
