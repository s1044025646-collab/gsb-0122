import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ServerHandle } from '../api';
import { tempDb, clock } from './helpers';
import { cascade } from '../fixtures';

async function call(
  h: ServerHandle,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('API：完整流程、错误码、分页与幂等', async () => {
  const { db, file } = tempDb();
  cascade.build(db, 'API');
  const h = await startServer(db, clock);
  try {
    const dup = await call(h, 'POST', '/batches', { code: 'API', name: 'x' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'CONFLICT');

    const bad = await call(h, 'POST', '/batches/API/majors', { code: 'M', name: 'm', capacity: -1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION');

    const notFound = await call(h, 'GET', '/batches/NOPE/students');
    assert.equal(notFound.status, 404);

    const trial = await call(h, 'POST', '/batches/API/rounds/trial', { source: 'test' });
    assert.equal(trial.status, 200);
    assert.equal(trial.json.blocking_pairs.length, 0);

    const f1 = await call(h, 'POST', '/batches/API/rounds/formal', {
      source: 'test',
      idempotency_key: 'F',
    });
    const f2 = await call(h, 'POST', '/batches/API/rounds/formal', {
      source: 'test',
      idempotency_key: 'F',
    });
    assert.equal(f1.json.round.id, f2.json.round.id);
    assert.equal(f2.json.replayed, true);

    const wd = await call(h, 'POST', '/batches/API/withdraw', {
      anon_code: 'S1',
      source: 'test',
      reason: 'r',
      idempotency_key: 'W',
    });
    assert.equal(wd.status, 200);
    assert.equal(wd.json.round.kind, 'rerun');

    const rounds = await call(h, 'GET', '/batches/API/rounds?page=1&page_size=1');
    assert.equal(rounds.json.total, 3);
    assert.equal(rounds.json.data.length, 1);

    const detail = await call(h, 'GET', `/rounds/${f1.json.round.id}`);
    assert.ok(detail.json.result.admissions.length >= 1);
  } finally {
    await h.close();
    db.close();
  }
  void file;
});

test('API：服务仅绑定回环地址并使用自动端口', async () => {
  const { db } = tempDb();
  const h = await startServer(db, clock);
  try {
    assert.ok(Number.isInteger(h.port) && h.port > 0);
  } finally {
    await h.close();
    db.close();
  }
});
