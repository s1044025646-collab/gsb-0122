import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db';
import * as repo from '../repo';
import * as service from '../service';
import * as engine from '../engine';
import { Scenario } from '../fixtures';

export function tempDb(): { file: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-'));
  const file = path.join(dir, 't.db');
  const db = new DatabaseSync(file);
  migrate(db);
  return { file, db };
}

export const clock: repo.Clock = { now: () => '2026-08-01T08:00:00.000Z' };

export function runScenario(scenario: Scenario) {
  const { db, file } = tempDb();
  const code = scenario.key.toUpperCase();
  scenario.build(db, code);
  const batch = repo.requireBatch(db, code);
  const rv = repo.latestRuleVersion(db, batch.id);
  const rules = engine.loadRules(db, rv.id);
  const result = engine.runDeferredAcceptance(db, batch.id, rules);
  const pairs = engine.findBlockingPairs(db, batch.id, result, rules);
  return { db, file, code, batch, rv, rules, result, pairs };
}

export function formalRound(db: DatabaseSync, code: string, key = 'k') {
  return service.runRound(db, { batchCode: code, kind: 'formal', source: 'test', idempotencyKey: key, clock });
}
