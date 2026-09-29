import http from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors';
import * as repo from './repo';
import * as service from './service';
import * as engine from './engine';

interface Ctx {
  db: DatabaseSync;
  body: any;
  query: URLSearchParams;
  clock: repo.Clock;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => any;

function requireStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new AppError('VALIDATION', `字段 ${field} 必须是非空字符串`, { field });
  return v;
}
function requireInt(v: unknown, field: string, min = 0): number {
  if (!Number.isInteger(v) || (v as number) < min) {
    throw new AppError('VALIDATION', `字段 ${field} 必须是 >= ${min} 的整数`, { field });
  }
  return v as number;
}
function optStr(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return requireStr(v, field);
}

function paginate<T>(rows: T[], q: URLSearchParams) {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(q.get('page_size') ?? '50', 10) || 50));
  const total = rows.length;
  const start = (page - 1) * pageSize;
  return {
    data: rows.slice(start, start + pageSize),
    page,
    page_size: pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-z_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, pattern, keys, handler });
}

route('POST', '/batches', ({ body, clock, db }) => {
  const code = requireStr(body?.code, 'code');
  const name = requireStr(body?.name, 'name');
  return repo.createBatch(db, code, name, clock);
});

route('GET', '/batches', ({ db, query }) => {
  const rows = db.prepare('SELECT id,code,name,status,created_at FROM batches ORDER BY id').all();
  return paginate(rows as unknown[], query);
});

route('POST', '/batches/:code/majors', ({ body, db, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  const majors = Array.isArray(body?.majors) ? body.majors : [body];
  for (const m of majors) {
    const code = requireStr(m?.code, 'code');
    const name = requireStr(m?.name, 'name');
    const cap = requireInt(m?.capacity, 'capacity', 0);
    repo.upsertMajor(db, batch.id, code, name, cap);
  }
  return { imported: majors.length, majors: repo.majors(db, batch.id) };
});

route('GET', '/batches/:code/majors', ({ db, query, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  return paginate(repo.majors(db, batch.id) as unknown[], query);
});

route('POST', '/batches/:code/priorities', ({ body, db, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  const rv = repo.latestRuleVersion(db, batch.id);
  const items: Array<{ major_code: string; exprs: string[] }> = Array.isArray(body?.items)
    ? body.items
    : [{ major_code: requireStr(body?.major_code, 'major_code'), exprs: requireExprs(body?.exprs) }];
  for (const it of items) {
    const mc = requireStr(it?.major_code, 'major_code');
    const exprs = requireExprs(it?.exprs);
    for (const e of exprs) validateExpr(e);
    repo.setPriorities(db, rv.id, mc, exprs);
  }
  return { rule_version: rv.version, items };
});

route('POST', '/batches/:code/rule-versions', ({ body, db, params, clock }) => {
  const batch = repo.requireBatch(db, params!.code);
  const created = repo.createNextRuleVersion(
    db,
    batch.id,
    optStr(body?.note, 'note') ?? '派生规则版本',
    clock,
  );
  return created;
});

function requireExprs(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new AppError('VALIDATION', 'exprs 必须是字符串数组');
  }
  return v;
}
function validateExpr(e: string) {
  if (!/^(score (desc|asc)|metric\.[A-Za-z_][A-Za-z0-9_]* (desc|asc)|tiebreak\(anon\))$/.test(e.trim())) {
    throw new AppError('VALIDATION', `非法优先序表达式: ${e}`);
  }
}

route('POST', '/batches/:code/students', ({ body, db, params, clock }) => {
  const batch = repo.requireBatch(db, params!.code);
  const source = requireStr(body?.source, 'source');
  const list = Array.isArray(body?.students) ? body.students : [body];
  const created = [];
  for (const raw of list) {
    const input: repo.StudentInput = {
      anon_code: requireStr(raw?.anon_code, 'anon_code'),
      score: requireInt(raw?.score, 'score', 0),
      eligible: raw?.eligible === undefined ? undefined : Boolean(raw.eligible),
      metrics: raw?.metrics,
      qualifications: raw?.qualifications,
    };
    created.push(repo.upsertStudent(db, batch.id, input, clock));
  }
  void source;
  return { imported: created.length };
});

route('GET', '/batches/:code/students', ({ db, query, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  let rows = repo.students(db, batch.id) as unknown[];
  if (query.get('eligible') === 'true') rows = (rows as any[]).filter((r) => r.eligible === 1);
  if (query.get('eligible') === 'false') rows = (rows as any[]).filter((r) => r.eligible === 0);
  return paginate(rows, query);
});

route('POST', '/batches/:code/applications', ({ body, db, params, clock }) => {
  const batch = repo.requireBatch(db, params!.code);
  const source = requireStr(body?.source, 'source');
  const list = Array.isArray(body?.students)
    ? body.students
    : [{ anon_code: requireStr(body?.anon_code, 'anon_code'), ordinals: body?.ordinals }];
  for (const s of list) {
    const ordinals = s?.ordinals;
    if (!Array.isArray(ordinals)) throw new AppError('VALIDATION', 'ordinals 必须是数组');
    const norm = ordinals.map((o: any, i: number) => ({
      ordinal: Number.isInteger(o?.ordinal) ? o.ordinal : i + 1,
      major_code: requireStr(o?.major_code, 'major_code'),
    }));
    repo.replaceApplications(db, batch.id, {
      anon_code: requireStr(s?.anon_code, 'anon_code'),
      ordinals: norm,
      source,
      reason: optStr(body?.reason, 'reason'),
    }, clock);
  }
  return { imported: list.length };
});

route('GET', '/batches/:code/applications', ({ db, query, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  return paginate(repo.allApplications(db, batch.id) as unknown[], query);
});

route('POST', '/batches/:code/validate', ({ db, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  return { issues: engine.validateApplications(db, batch.id) };
});

route('POST', '/batches/:code/rounds/trial', roundHandler('trial'));
route('POST', '/batches/:code/rounds/formal', roundHandler('formal'));
route('POST', '/batches/:code/rounds/rerun', roundHandler('rerun'));

function roundHandler(kind: 'trial' | 'formal' | 'rerun'): Handler {
  return ({ body, db, params, clock }) => {
    const out = service.runRound(db, {
      batchCode: params!.code,
      kind,
      source: requireStr(body?.source, 'source'),
      reason: optStr(body?.reason, 'reason'),
      idempotencyKey: optStr(body?.idempotency_key, 'idempotency_key'),
      clock,
    });
    return presentRound(db, out);
  };
}

route('POST', '/batches/:code/withdraw', ({ body, db, params, clock }) => {
  const out = service.withdraw(db, {
    batchCode: params!.code,
    anonCode: requireStr(body?.anon_code, 'anon_code'),
    source: requireStr(body?.source, 'source'),
    reason: requireStr(body?.reason, 'reason'),
    idempotencyKey: optStr(body?.idempotency_key, 'idempotency_key'),
    clock,
  });
  return presentRound(db, out);
});

route('POST', '/batches/:code/corrections', ({ body, db, params, clock }) => {
  const student = service.correctScore(db, {
    batchCode: params!.code,
    anonCode: requireStr(body?.anon_code, 'anon_code'),
    newScore: body?.new_score,
    eligible: body?.eligible,
    qualifications: body?.qualifications,
    source: requireStr(body?.source, 'source'),
    reason: requireStr(body?.reason, 'reason'),
    clock,
  });
  return { anon_code: student.anon_code, score: student.score, eligible: student.eligible };
});

route('GET', '/batches/:code/rounds', ({ db, query, params }) => {
  const batch = repo.requireBatch(db, params!.code);
  return paginate(service.listRounds(db, batch.id) as unknown[], query);
});

route('GET', '/rounds/:id', ({ db, params, query }) => {
  const id = requireInt(Number(params!.id), 'id', 1);
  const round = service.roundById(db, id);
  const out = {
    round,
    blocking_pairs: service.loadBlockingPairs(db, id),
  } as any;
  if (query.get('detail') !== '0') {
    out.result = service.loadResult(db, id);
  }
  return out;
});

function presentRound(db: DatabaseSync, out: service.RunRoundOutput) {
  const admitted = out.result.admissions.filter((a) => a.state === 'admitted').length;
  return {
    replayed: out.replayed,
    round: out.round,
    steps: out.result.steps,
    admitted,
    unassigned: out.result.admissions.length - admitted,
    blocking_pairs: out.blockingPairs,
  };
}

const STATUS: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE_FROZEN: 409,
  ROUND_FROZEN: 409,
  BAD_STATE: 409,
  IDEMPOTENCY_REPLAY: 409,
  QUALIFICATION: 422,
  CAPACITY: 422,
  INTERNAL: 500,
};

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export function startServer(db: DatabaseSync, clock: repo.Clock = repo.isoClock): Promise<ServerHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    let body: any = {};
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: { code: 'VALIDATION', message: '请求体不是合法 JSON' } });
        }
      }
      const match = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!match) return send(404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
      const m = url.pathname.match(match.pattern)!;
      const params: Record<string, string> = {};
      match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const ctx: Ctx = { db, body, query: url.searchParams, clock, params };
      try {
        const result = match.handler(ctx);
        send(200, { ok: true, ...(result && typeof result === 'object' ? result : { result }) });
      } catch (e) {
        if (e instanceof AppError) {
          return send(STATUS[e.code] ?? 500, { error: { code: e.code, message: e.message, details: e.details } });
        }
        send(500, { error: { code: 'INTERNAL', message: (e as Error).message } });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 端口 0 = 由操作系统自动分配；显式只绑定回环地址。
    const listener = server.listen(0, '127.0.0.1', () => {
      const port = (listener.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((e) => (e ? rej(e) : res())),
          ),
      });
    });
  });
}
