import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { availableParallelism, platform, arch } from 'node:os';
import { parseArgs } from 'node:util';
import { HranaClient, loadConfig, runStage } from './libsql-stress.mjs';

const { values } = parseArgs({ options: {
  'seed-only': { type: 'boolean', default: false },
  reuse: { type: 'boolean', default: false },
  duration: { type: 'string', default: '8' },
  confirmation: { type: 'string', default: '20' },
  'max-concurrency': { type: 'string', default: '64' },
  'max-write-rows': { type: 'string', default: '1000000' },
  provider: { type: 'string', default: 'layerbase' },
  families: { type: 'string' },
  concurrency: { type: 'string' },
} });
const limits = {
  durationSeconds: Number(values.duration), confirmationSeconds: Number(values.confirmation),
  maxConcurrency: Number(values['max-concurrency']), maxWriteRows: Number(values['max-write-rows']),
  maxRequests: 250_000, maxSeconds: 600,
};
for (const [key, value] of Object.entries(limits)) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
}
if (limits.maxConcurrency > 256) throw new Error('Maximum supported concurrency is 256');
const fixedConcurrency = values.concurrency === undefined ? null : Number(values.concurrency);
if (fixedConcurrency !== null && (!Number.isSafeInteger(fixedConcurrency)
  || fixedConcurrency < 1 || fixedConcurrency > limits.maxConcurrency)) {
  throw new Error('--concurrency must be a positive integer no greater than --max-concurrency');
}

const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const config = loadConfig(values.provider);
const client = new HranaClient({ ...config, maxSockets: limits.maxConcurrency });
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const resultFile = new URL(`./results/${runId}.json`, import.meta.url);
const report = {
  runId, startedAt: new Date().toISOString(), provider: config.provider, endpoint: config.url.origin,
  runtime: { node: process.version, platform: platform(), arch: arch(), cpuCount: availableParallelism() },
  transport: 'Hrana v2 JSON over HTTPS/1.1; pooled TCP/TLS sockets; one SQL statement and stream close per request; no retries',
  limits, fixedConcurrency, schemaSha256: createHash('sha256').update(schema).digest('hex'),
  methodology: {
    phase: 'Closed-loop concurrency; 2-second warmup excluded; all in-flight work drained and included in elapsed time',
    payload: '256 ASCII bytes per inserted event; batch is 100 rows in one atomic INSERT statement',
    seed: '10,000 users + 2,000 projects + 100,000 events generated server-side; seeding excluded from throughput',
    percentiles: 'Client end-to-end latency includes JSON encoding/decoding, network, server, and queueing',
    limitations: 'One remote client, warmed data, bounded stages; these are observed application throughput, not an isolated server maximum',
  }, stages: [],
};
const save = () => writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
const rows = (result) => result.rows.map(row => Object.fromEntries(result.cols.map((col, i) => [col.name,
  row[i].type === 'null' ? null : row[i].type === 'integer' || row[i].type === 'float' ? Number(row[i].value) : row[i].value])));
const query = async (sql, args = []) => rows(await client.execute(sql, args));
const databaseState = async () => (await query(`SELECT sqlite_version() AS sqlite_version,
  (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
  (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys,
  (SELECT page_size FROM pragma_page_size) AS page_size,
  (SELECT page_count FROM pragma_page_count) AS page_count`))[0];
let stop = false;
let circuitOpen = false;
process.on('SIGINT', () => { stop = true; console.log('Stopping after in-flight operations complete.'); });
let requests = 0;
let attemptedInsertRows = 0;
let acknowledgedInsertRows = 0;
let acknowledgedUpdates = 0;
let sequence = 0;
let loadStarted = performance.now();
const budgetReached = () => stop || circuitOpen || requests >= limits.maxRequests || attemptedInsertRows >= limits.maxWriteRows
  || performance.now() - loadStarted >= limits.maxSeconds * 1000;
const payload = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(8);
const userAt = n => ((n * 7919) % 10000) + 1;
const pointSql = 'SELECT id, email, name, plan, benchmark_counter FROM lbbench_users WHERE id = ?';
const joinSql = `SELECT e.id, e.kind, e.created_at, u.name AS user_name, p.name AS project_name
  FROM lbbench_events e JOIN lbbench_users u ON u.id=e.user_id JOIN lbbench_projects p ON p.id=e.project_id
  WHERE e.project_id=? ORDER BY e.created_at DESC LIMIT 20`;
const insertSql = 'INSERT INTO lbbench_writes(id,run_id,user_id,created_at,payload) VALUES (?,?,?,?,?)';
const batchSql = 'INSERT INTO lbbench_writes(id,run_id,user_id,created_at,payload) VALUES '
  + Array.from({ length: 100 }, () => '(?,?,?,?,?)').join(',');
function checked(condition, message) {
  if (!condition) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; throw error; }
}
async function point() {
  const id = userAt(++sequence); requests++;
  const r = await client.execute(pointSql, [id]);
  checked(r.rows?.length === 1 && Number(r.rows[0][0].value) === id, 'Point lookup returned incorrect row');
  return { readQueries: 1, rowsReturned: 1 };
}
async function join() {
  const id = ((++sequence * 37) % 2000) + 1; requests++;
  const r = await client.execute(joinSql, [id]);
  checked(r.rows?.length === 20, 'Indexed join did not return 20 seeded events');
  return { readQueries: 1, rowsReturned: 20 };
}
async function insert(batch = false) {
  const count = batch ? 100 : 1;
  // Reserve row budget synchronously before any I/O, including uncertain writes.
  if (attemptedInsertRows + count > limits.maxWriteRows) {
    stop = true; const error = new Error('Write row budget exhausted'); error.code = 'BUDGET'; throw error;
  }
  const args = [];
  for (let i = 0; i < count; i++) {
    const n = ++sequence;
    args.push(`${runId}:${n}`, runId, userAt(n), Math.floor(Date.now()/1000), payload);
  }
  attemptedInsertRows += count; requests++;
  const r = await client.execute(batch ? batchSql : insertSql, args, false);
  checked(r.affected_row_count === count, 'INSERT affected-row count did not match');
  acknowledgedInsertRows += count;
  return { writeQueries: 1, rowsWritten: count };
}
async function update() {
  const id = userAt(++sequence); requests++;
  const r = await client.execute('UPDATE lbbench_users SET benchmark_counter=benchmark_counter+1 WHERE id=?', [id], false);
  checked(r.affected_row_count === 1, 'UPDATE affected-row count did not match');
  acknowledgedUpdates++;
  return { writeQueries: 1, rowsWritten: 1 };
}
async function mixed(worker, iteration) {
  return (worker + iteration) % 5 === 0 ? insert() : point();
}

async function stage(family, concurrency, operation, confirmation = false) {
  console.log(JSON.stringify({ starting: family, concurrency, confirmation }));
  const result = await runStage({ client, name: family, concurrency, operation,
    durationSeconds: confirmation ? limits.confirmationSeconds : limits.durationSeconds,
    warmupSeconds: 2, shouldStop: budgetReached });
  result.confirmation = confirmation;
  report.stages.push(result);
  if ([result, result.warmup].some(phase => phase &&
    (phase.errorCodes.HTTP_429 || phase.errorCodes.TIMEOUT))) {
    circuitOpen = true;
    report.stopReason = 'Service overload or request timeouts; remaining load skipped';
  }
  save();
  return result;
}

try {
  report.before = await databaseState();
  const existing = await query("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'lbbench_%' ORDER BY name");
  if (existing.length && !values.reuse) throw new Error('Benchmark tables already exist. Use --reuse to retain data and benchmark them.');
  if (!existing.length) {
    console.log('Creating four benchmark tables and indexes.');
    for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await client.execute(statement, [], false);
    await client.execute(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<10000)
      INSERT INTO lbbench_users(id,email,name,plan)
      SELECT n,printf('user%05d@benchmark.invalid',n),printf('Benchmark User %05d',n),
      CASE n%3 WHEN 0 THEN 'pro' WHEN 1 THEN 'free' ELSE 'team' END FROM s`, [], false);
    await client.execute(`WITH RECURSIVE s(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM s WHERE n<2000)
      INSERT INTO lbbench_projects(id,owner_id,name,status)
      SELECT n,((n*7)%10000)+1,printf('Project %04d',n),CASE n%4 WHEN 0 THEN 'archived' ELSE 'active' END FROM s`, [], false);
    for (let first = 1; first <= 100000; first += 10000) {
      await client.execute(`WITH RECURSIVE s(n) AS (VALUES(?) UNION ALL SELECT n+1 FROM s WHERE n<?)
        INSERT INTO lbbench_events(id,user_id,project_id,kind,created_at,payload)
        SELECT n,((n*73)%10000)+1,((n*37)%2000)+1,
        CASE n%3 WHEN 0 THEN 'page_view' WHEN 1 THEN 'api_request' ELSE 'job_completed' END,
        1700000000+n,? FROM s`, [first, first + 9999, payload], false);
    }
  }
  report.seedCounts = (await query(`SELECT (SELECT count(*) FROM lbbench_users) AS users,
    (SELECT count(*) FROM lbbench_projects) AS projects,(SELECT count(*) FROM lbbench_events) AS events`))[0];
  checked(report.seedCounts.users === 10000 && report.seedCounts.projects === 2000 && report.seedCounts.events === 100000,
    'Unexpected seed row counts');
  report.updateCounterBefore = (await query('SELECT sum(benchmark_counter) AS total FROM lbbench_users'))[0].total;
  report.queryPlans = {
    point: await query('EXPLAIN QUERY PLAN ' + pointSql, [1]),
    join: await query('EXPLAIN QUERY PLAN ' + joinSql, [1]),
  };
  console.log(JSON.stringify({ seedCounts: report.seedCounts, metadata: report.before }));
  save();
  if (!values['seed-only']) {
    loadStarted = performance.now();
    const families = [
      ['point_read', point, [1, 8, 32, 64, 128, 256]],
      ['indexed_join_20_rows', join, [1, 8, 32, 64, 128]],
      ['single_insert', () => insert(), [1, 8, 32, 64, 128, 256]],
      ['single_update', update, [1, 8, 32, 64, 128, 256]],
      ['mixed_80_read_20_insert', mixed, [1, 8, 32, 64, 128]],
      ['batch_insert_100_rows', () => insert(true), [1, 4, 16, 32]],
    ];
    const selected = values.families ? new Set(values.families.split(',')) : null;
    if (selected) for (const family of selected) {
      checked(families.some(([name]) => name === family), `Unknown workload: ${family}`);
    }
    for (const [family, operation, levels] of families.filter(([name]) => !selected || selected.has(name))) {
      const candidates = [];
      for (const concurrency of fixedConcurrency === null ? levels.filter(c => c <= limits.maxConcurrency) : [fixedConcurrency]) {
        if (budgetReached()) break;
        const result = await stage(family, concurrency, operation);
        candidates.push(result);
        // Stop escalating a family once it exhibits material errors.
        if (result.errorRate > 0.01 || result.warmup?.errorRate > 0.01 || result.stopReason) break;
      }
      const best = candidates.filter(r => r.errorRate === 0 && !r.stopReason)
        .sort((a,b) => b.successfulRequestsPerSecond-a.successfulRequestsPerSecond)[0];
      if (best && !budgetReached()) await stage(family, best.concurrency, operation, true);
      if (budgetReached()) break;
    }
  }
  report.loadElapsedSeconds = (performance.now() - loadStarted)/1000;
  report.accounting = { requests, attemptedInsertRows, acknowledgedInsertRows, acknowledgedUpdates,
    stoppedByBudgetOrSignal: budgetReached() };
  report.verification = (await query(`SELECT
    (SELECT count(*) FROM lbbench_writes WHERE run_id=?) AS persistedInserts,
    (SELECT sum(benchmark_counter) FROM lbbench_users) AS updateCounterAfter,
    (SELECT count(*) FROM lbbench_writes WHERE run_id=? AND length(payload)<>256) AS invalidPayloads`, [runId,runId]))[0];
  report.verification.insertCountMatchesAcknowledged = report.verification.persistedInserts === acknowledgedInsertRows;
  report.verification.updateCountMatchesAcknowledged = report.verification.updateCounterAfter - report.updateCounterBefore === acknowledgedUpdates;
  report.verification.foreignKeyViolations = (await query('PRAGMA foreign_key_check')).length;
  report.verification.quickCheck = await query('PRAGMA quick_check(1)');
  report.after = await databaseState();
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ resultFile: resultFile.pathname, accounting: report.accounting,
    verification: report.verification, databaseBytes: report.after.page_size*report.after.page_count }));
} catch (error) {
  report.failure = { code: error.code || 'ERROR', message: String(error.message).split(config.authToken).join('[redacted]').slice(0,240) };
  report.finishedAt = new Date().toISOString();
  save();
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  client.close();
}
