import { DatabaseSync } from 'node:sqlite';
import * as repo from './repo';
import { migrate } from './db';

/** 固定时钟，保证夹具与演示完全可重放。 */
export const fixedClock: repo.Clock = { now: () => '2026-08-01T08:00:00.000Z' };

export interface Scenario {
  key: string;
  description: string;
  build(db: DatabaseSync, code: string): void;
}

function base(db: DatabaseSync, code: string, majors: Array<[string, string, number]>, students: repo.StudentInput[]) {
  const batch = repo.createBatch(db, code, code, fixedClock);
  for (const [c, n, cap] of majors) repo.upsertMajor(db, batch.id, c, n, cap);
  for (const s of students) repo.upsertStudent(db, batch.id, s, fixedClock);
  return batch;
}

function apps(db: DatabaseSync, batchId: number, entries: Array<[string, string[]]>) {
  for (const [code, prefs] of entries) {
    repo.replaceApplications(
      db,
      batchId,
      {
        anon_code: code,
        ordinals: prefs.map((m, i) => ({ ordinal: i + 1, major_code: m })),
        source: 'fixture',
      },
      fixedClock,
    );
  }
}

/** 连锁挤出：容量 1，三人同填 A，落选者顺延引发后续挤出。 */
export const cascade: Scenario = {
  key: 'cascade',
  description: '连锁挤出：A 容量 1，高分者占 A，触发后续专业顺延与挤出',
  build(db, code) {
    const b = base(
      db,
      code,
      [
        ['A', '专业A', 1],
        ['B', '专业B', 1],
      ],
      [
        { anon_code: 'S1', score: 90 },
        { anon_code: 'S2', score: 80 },
        { anon_code: 'S3', score: 70 },
      ],
    );
    apps(db, b.id, [
      ['S1', ['A']],
      ['S2', ['A', 'B']],
      ['S3', ['A', 'B']],
    ]);
  },
};

/** 同分：默认 score desc + 确定性哈希打破并列。 */
export const tie: Scenario = {
  key: 'tie',
  description: '同分：S2、S3 同分竞争 B，由公开确定性哈希决定',
  build(db, code) {
    const b = base(
      db,
      code,
      [
        ['A', '专业A', 1],
        ['B', '专业B', 1],
      ],
      [
        { anon_code: 'S1', score: 90 },
        { anon_code: 'S2', score: 80 },
        { anon_code: 'S3', score: 80 },
      ],
    );
    apps(db, b.id, [
      ['S1', ['A']],
      ['S2', ['A', 'B']],
      ['S3', ['A', 'B']],
    ]);
  },
};

/** 零容量：专业 C 容量 0，申请应被拒绝并说明。 */
export const zeroCapacity: Scenario = {
  key: 'zero_capacity',
  description: '零容量：Z 容量为 0，申请 Z 必被拒绝',
  build(db, code) {
    const b = base(
      db,
      code,
      [
        ['A', '专业A', 1],
        ['Z', '专业Z', 0],
      ],
      [
        { anon_code: 'S1', score: 90, qualifications: {} },
      ],
    );
    apps(db, b.id, [['S1', ['Z', 'A']]]);
  },
};

/** 全部落选：专业容量合计小于人数，且志愿受限。 */
export const allReject: Scenario = {
  key: 'all_reject',
  description: '全部落选：唯一专业容量 0，所有考生最终未录取',
  build(db, code) {
    const b = base(
      db,
      code,
      [['Z', '专业Z', 0]],
      [{ anon_code: 'S1', score: 90 }, { anon_code: 'S2', score: 80 }],
    );
    apps(db, b.id, [
      ['S1', ['Z']],
      ['S2', ['Z']],
    ]);
  },
};

/** 资格变更：S1 对 A 不合格，必须顺延到 B。 */
export const qualification: Scenario = {
  key: 'qualification',
  description: '资格不符：S1 报考 A 资格不符，顺延录取 B',
  build(db, code) {
    const b = base(
      db,
      code,
      [
        ['A', '专业A', 1],
        ['B', '专业B', 1],
      ],
      [
        {
          anon_code: 'S1',
          score: 95,
          qualifications: { A: { qualified: false, reason: '体检结论受限' } },
        },
        { anon_code: 'S2', score: 80 },
      ],
    );
    apps(db, b.id, [
      ['S1', ['A', 'B']],
      ['S2', ['A']],
    ]);
  },
};

/** 并发确认：多名考生竞争有限名额，用于重复确认幂等测试。 */
export const concurrent: Scenario = {
  key: 'concurrent',
  description: '并发确认：多名考生竞争 A 仅 2 个名额；重复正式录取须幂等',
  build(db, code) {
    const b = base(
      db,
      code,
      [['A', '专业A', 2]],
      [
        { anon_code: 'S1', score: 90 },
        { anon_code: 'S2', score: 85 },
        { anon_code: 'S3', score: 80 },
        { anon_code: 'S4', score: 75 },
      ],
    );
    apps(db, b.id, [
      ['S1', ['A']],
      ['S2', ['A']],
      ['S3', ['A']],
      ['S4', ['A']],
    ]);
  },
};

export const scenarios: Scenario[] = [cascade, tie, zeroCapacity, allReject, qualification, concurrent];

export function buildScenario(scenario: Scenario, dbFile: string, code?: string): DatabaseSync {
  const db = new DatabaseSync(dbFile);
  migrate(db);
  scenario.build(db, code ?? scenario.key.toUpperCase());
  return db;
}
