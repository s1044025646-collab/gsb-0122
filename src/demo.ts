import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './db';
import * as repo from './repo';
import * as service from './service';
import * as engine from './engine';
import { fixedClock, cascade } from './fixtures';

function line(t: string) {
  console.log(`\n### ${t}`);
}

function runDemo(dbFile: string) {
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile, { force: true });
  for (const suffix of ['-wal', '-shmem']) {
    const f = dbFile + (suffix === '-shmem' ? '-shm' : suffix);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  const db = new DatabaseSync(dbFile);
  migrate(db);

  line('1) 载入夹具：连锁挤出场景');
  cascade.build(db, 'DEMO');
  const batch = repo.requireBatch(db, 'DEMO');
  console.log(repo.majors(db, batch.id));

  line('2) 校验志愿');
  console.log(engine.validateApplications(db, batch.id));

  line('3) 试投档（不改变正式状态，可反复重放）');
  const trial = run(db, 'trial', 'demo');
  console.log(summary(db, trial));

  line('4) 稳定性核验（阻塞对数量应为 0）');
  console.log({ blocking_pairs: trial.blockingPairs.length });

  line('5) 正式录取（冻结规则版本）');
  const formal = run(db, 'formal', 'demo', 'formal-1');
  console.log(summary(db, formal));

  line('6) 重复提交同一幂等键：应返回同一轮次且 replayed=true');
  const again = run(db, 'formal', 'demo', 'formal-1');
  console.log({ replayed: again.replayed, same_round: again.round.id === formal.round.id });

  line('7) 退档 S1：生成新一轮，历史结果保留，触发连锁补位');
  const before = service.listRounds(db, batch.id).length;
  const wd = service.withdraw(db, {
    batchCode: 'DEMO',
    anonCode: 'S1',
    source: 'demo',
    reason: '复查发现档案缺失',
    idempotencyKey: 'wd-1',
    clock: fixedClock,
  });
  console.log({
    rounds_before: before,
    rounds_after: service.listRounds(db, batch.id).length,
    new_seq: wd.round.seq,
    admitted: wd.result.admissions.filter((a) => a.state === 'admitted').length,
  });

  line('8) 跨轮次隔离：第 1 轮正式结果仍保留 S1');
  const first = service.loadResult(db, formal.round.id);
  console.log(
    first.admissions.map((a) => ({
      student: (db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id) as any).anon_code,
      major: a.major_code,
    })),
  );

  db.close();
  line(`演示完成，数据库位于 ${dbFile}`);
}

function run(
  db: DatabaseSync,
  kind: 'trial' | 'formal' | 'rerun',
  source: string,
  idem?: string,
) {
  return service.runRound(db, {
    batchCode: 'DEMO',
    kind,
    source,
    idempotencyKey: idem,
    clock: fixedClock,
  });
}

function summary(db: DatabaseSync, out: service.RunRoundOutput) {
  return {
    seq: out.round.seq,
    steps: out.result.steps,
    admissions: out.result.admissions.map((a) => ({
      student: (db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id) as any).anon_code,
      major: a.major_code,
      state: a.state,
      reason: a.reject_reason,
    })),
    blocking_pairs: out.blockingPairs.length,
  };
}

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });
runDemo(path.join(dir, 'demo.db'));
