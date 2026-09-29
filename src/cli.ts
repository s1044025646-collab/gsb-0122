#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { openDb, migrate } from './db';
import * as repo from './repo';
import * as service from './service';
import * as engine from './engine';
import * as api from './api';
import { scenarios } from './fixtures';

const args = process.argv.slice(2);
const command = args[0];

const DB_PATH = process.env.ADMISSION_DB || path.join(process.cwd(), 'data', 'admission.db');

function print(label: string, value: unknown) {
  console.log(`\n== ${label} ==`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function snapshot(db: ReturnType<typeof openDb>, code: string) {
  const batch = repo.batchByCode(db, code);
  if (!batch) return { exists: false };
  const rounds = service.listRounds(db, batch.id);
  const last = rounds[rounds.length - 1];
  const lastResult = last
    ? service
        .loadResult(db, last.id)
        .admissions.map((a) => ({
          student: db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id),
          major: a.major_code,
          state: a.state,
          reason: a.reject_reason,
        }))
    : [];
  return {
    batch: { code: batch.code, name: batch.name, status: batch.status },
    majors: repo.majors(db, batch.id),
    students: repo.students(db, batch.id).length,
    rounds: rounds.map((r) => ({ seq: r.seq, kind: r.kind, status: r.status })),
    last_round_admissions: lastResult,
  };
}

function main() {
  const db = openDb(DB_PATH);
  migrate(db);
  switch (command) {
    case 'init':
      print('初始化数据库', { db: DB_PATH });
      break;

    case 'create-batch': {
      const [, code, name] = args;
      const b = repo.createBatch(db, code, name ?? code, repo.isoClock);
      print('已创建批次', b);
      break;
    }

    case 'import': {
      const [, code, file] = args;
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const batch = repo.requireBatch(db, code);
      print('操作前', snapshot(db, code));
      for (const m of payload.majors ?? [])
        repo.upsertMajor(db, batch.id, m.code, m.name, m.capacity);
      for (const s of payload.students ?? [])
        repo.upsertStudent(db, batch.id, { ...s, eligible: s.eligible ?? true }, repo.isoClock);
      for (const a of payload.applications ?? [])
        repo.replaceApplications(
          db,
          batch.id,
          {
            anon_code: a.anon_code,
            ordinals: a.ordinals.map((o: any, i: number) =>
              typeof o === 'string' ? { ordinal: i + 1, major_code: o } : o,
            ),
            source: a.source ?? payload.source ?? 'cli-import',
          },
          repo.isoClock,
        );
      print('操作后', snapshot(db, code));
      break;
    }

    case 'validate': {
      const [, code] = args;
      const batch = repo.requireBatch(db, code);
      const issues = engine.validateApplications(db, batch.id);
      print('志愿校验结果', issues.length ? issues : '全部志愿指向存在的专业');
      break;
    }

    case 'new-rule': {
      const [, code, note = '派生规则版本'] = args;
      const batch = repo.requireBatch(db, code);
      const created = repo.createNextRuleVersion(db, batch.id, note, repo.isoClock);
      print('已派生新规则版本（复制旧版本优先序）', created);
      break;
    }

    case 'trial':
    case 'confirm':
    case 'rerun': {
      const [, code, source = 'cli', idem] = args;
      const kind = command === 'trial' ? 'trial' : command === 'confirm' ? 'formal' : 'rerun';
      print('操作前', snapshot(db, code));
      const out = service.runRound(db, {
        batchCode: code,
        kind,
        source,
        idempotencyKey: idem,
        clock: repo.isoClock,
      });
      print('操作后', {
        replayed: out.replayed,
        round: { seq: out.round.seq, kind: out.round.kind, status: out.round.status },
        steps: out.result.steps,
        proposals_tail: out.result.proposals.slice(-12),
        admissions: out.result.admissions.map((a) => ({
          student: (db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id) as any).anon_code,
          major: a.major_code,
          state: a.state,
          reason: a.reject_reason,
        })),
        blocking_pairs: out.blockingPairs,
      });
      break;
    }

    case 'stability': {
      const [, code] = args;
      const batch = repo.requireBatch(db, code);
      const rounds = service.listRounds(db, batch.id);
      const last = rounds[rounds.length - 1];
      if (!last) throw new Error('尚无轮次');
      const rv = repo.ruleVersion(db, last.rule_version_id)!;
      const pairs = service.loadBlockingPairs(db, last.id);
      print('稳定性核验', {
        round_seq: last.seq,
        rule_version: rv.version,
        blocking_pair_count: pairs.length,
        stable: pairs.length === 0,
        pairs,
      });
      break;
    }

    case 'withdraw': {
      const [, code, anon, reason, source = 'cli', idem] = args;
      print('操作前', snapshot(db, code));
      const out = service.withdraw(db, {
        batchCode: code,
        anonCode: anon,
        source,
        reason,
        idempotencyKey: idem,
        clock: repo.isoClock,
      });
      print('操作后（已生成新轮次，历史结果保留）', {
        round_seq: out.round.seq,
        admitted: out.result.admissions.filter((a) => a.state === 'admitted').length,
        admissions: out.result.admissions.map((a) => ({
          student: (db.prepare('SELECT anon_code FROM students WHERE id=?').get(a.student_id) as any).anon_code,
          major: a.major_code,
          state: a.state,
        })),
      });
      break;
    }

    case 'correct-score': {
      const [, code, anon, newScore, source = 'cli', reason = '成绩更正'] = args;
      print('操作前', snapshot(db, code));
      const s = service.correctScore(db, {
        batchCode: code,
        anonCode: anon,
        newScore: Number(newScore),
        source,
        reason,
        clock: repo.isoClock,
      });
      print('操作后（成绩已更正，请执行 rerun 生成新轮次）', {
        anon_code: s.anon_code,
        score: s.score,
        eligible: s.eligible,
      });
      break;
    }

    case 'status': {
      const [, code] = args;
      print('当前状态', snapshot(db, code));
      break;
    }

    case 'fixture': {
      print('内置夹具', scenarios.map((s) => ({ key: s.key, description: s.description })));
      break;
    }

    case 'serve': {
      void api.startServer(db).then((h) => {
        const portFile = path.join(path.dirname(DB_PATH), 'server.port');
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        fs.writeFileSync(portFile, String(h.port));
        console.log(JSON.stringify({ listening: '127.0.0.1', port: h.port, db: DB_PATH, port_file: portFile }));
        process.on('SIGINT', () => void h.close().then(() => process.exit(0)));
        process.on('SIGTERM', () => void h.close().then(() => process.exit(0)));
      });
      break;
    }

    default:
      console.log(`用法:
  init
  create-batch <code> [name]
  import <code> <data.json>
  validate <code>
  new-rule <code> [note]
  trial <code> [source] [idempotency-key]
  confirm <code> [source] [idempotency-key]
  rerun <code> [source] [idempotency-key]
  stability <code>
  withdraw <code> <anon> <reason> [source] [idempotency-key]
  correct-score <code> <anon> <newScore> [source] [reason]
  status <code>
  fixture
  serve`);
  }
}

main();
