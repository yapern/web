import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HranaClient, loadConfig } from './libsql-stress.mjs';

const sourceReport = process.argv[2];
if (!sourceReport) throw new Error('Usage: node benchmarks/post-load.mjs path/to/layerbase-result.json');

const report = JSON.parse(readFileSync(sourceReport, 'utf8'));
if (report.provider !== 'layerbase') throw new Error('Post-load probes only accept a Layerbase report');
if (typeof report.runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(report.runId)) {
  throw new Error('Report runId is missing or invalid');
}
const reportFinishedMs = Date.parse(report.finishedAt);
if (!Number.isFinite(reportFinishedMs)) throw new Error('Report finishedAt is missing or invalid');
const acknowledgedInsertRows = report.accounting?.acknowledgedInsertRows;
if (!Number.isSafeInteger(acknowledgedInsertRows) || acknowledgedInsertRows < 0) {
  throw new Error('Report acknowledgedInsertRows is missing or invalid');
}

const config = loadConfig('layerbase');
const probeOffsetsSeconds = Array.from({ length: 10 }, (_, index) => index * 35);
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const scheduleAnchorMs = Math.max(reportFinishedMs, startedMs);
const scheduleAnchorReason = reportFinishedMs > startedMs ? 'report-finish' : 'invocation';
const payload = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(8);
const outputDirectory = new URL('./results/', import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
const resultFile = new URL(`./results/${report.runId}-post-load.json`, import.meta.url);
const result = {
  sourceReport: basename(sourceReport),
  runId: report.runId,
  provider: 'layerbase',
  startedAt,
  finishedAt: null,
  transport: 'Hrana v2 JSON over HTTPS/1.1; fresh one-socket client per probe and verification; no retries',
  schedule: {
    intervalSeconds: 35,
    plannedOffsetsSeconds: probeOffsetsSeconds,
    anchor: new Date(scheduleAnchorMs).toISOString(),
    anchorReason: scheduleAnchorReason,
    relativeTo: 'source report finishedAt; when invoked late, probes begin immediately and retain 35-second spacing',
  },
  probes: [],
  diagnosticWrite: null,
  verification: null,
  errors: [],
};

const safeText = (value) => {
  let text = String(value ?? 'Unknown error');
  for (const secret of [config.authToken, config.url.hostname, config.url.origin]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/https?:\/\/[^\s"']+/gi, '[redacted URL]').slice(0, 240);
};
const safeError = (error) => ({
  code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'ERROR',
  message: safeText(error?.message),
});
const save = () => writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
const rows = (response) => response.rows.map(row => Object.fromEntries(response.cols.map((column, index) => {
  const value = row[index];
  return [column.name, value?.type === 'integer' || value?.type === 'float'
    ? Number(value.value) : value?.type === 'null' ? null : value?.value];
})));
const freshClient = () => new HranaClient({ ...config, maxSockets: 1, timeoutMs: 5_000 });
const waitUntil = async (targetMs) => {
  const remaining = targetMs - Date.now();
  if (remaining > 0) await delay(remaining);
};

let hasFailure = false;
save();
try {
  for (let index = 0; index < probeOffsetsSeconds.length; index++) {
    const plannedOffsetSeconds = probeOffsetsSeconds[index];
    await waitUntil(scheduleAnchorMs + plannedOffsetSeconds * 1000);
    const probe = {
      index: index + 1,
      plannedOffsetSeconds,
      elapsedSeconds: (Date.now() - reportFinishedMs) / 1000,
      startedAt: new Date().toISOString(),
    };
    const client = freshClient();
    const probeStarted = performance.now();
    try {
      const response = await client.execute('SELECT 1 AS healthy');
      const values = rows(response);
      probe.value = values[0]?.healthy ?? null;
      probe.ok = values.length === 1 && probe.value === 1;
      if (!probe.ok) throw Object.assign(new Error('SELECT 1 returned an unexpected value'), { code: 'VALIDATION_ERROR' });
    } catch (error) {
      hasFailure = true;
      probe.ok = false;
      probe.error = safeError(error);
      result.errors.push({ phase: 'probe', index: probe.index, ...probe.error });
    } finally {
      probe.elapsedMs = performance.now() - probeStarted;
      probe.finishedAt = new Date().toISOString();
      client.close();
    }
    result.probes.push(probe);
    save();
    console.log(JSON.stringify({ probe: probe.index, ok: probe.ok, elapsedSeconds: probe.elapsedSeconds, elapsedMs: probe.elapsedMs }));
  }

  const diagnosticId = `${report.runId}:post-load-probe`;
  const diagnosticWrite = {
    id: diagnosticId,
    runId: report.runId,
    userId: 1,
    createdAt: Math.floor(Date.now() / 1000),
    payloadBytes: Buffer.byteLength(payload, 'ascii'),
    acknowledged: false,
  };
  const writeClient = freshClient();
  try {
    const response = await writeClient.execute(
      'INSERT INTO lbbench_writes(id,run_id,user_id,created_at,payload) VALUES (?,?,?,?,?)',
      [diagnosticId, report.runId, 1, diagnosticWrite.createdAt, payload], false,
    );
    diagnosticWrite.affectedRows = response.affected_row_count;
    diagnosticWrite.acknowledged = response.affected_row_count === 1;
    if (!diagnosticWrite.acknowledged) throw Object.assign(new Error('Diagnostic INSERT acknowledgement did not match one row'), { code: 'VALIDATION_ERROR' });
  } catch (error) {
    hasFailure = true;
    diagnosticWrite.error = safeError(error);
    result.errors.push({ phase: 'diagnostic-write', ...diagnosticWrite.error });
  } finally {
    writeClient.close();
  }
  result.diagnosticWrite = diagnosticWrite;
  save();

  const verificationClient = freshClient();
  try {
    const diagnostic = rows(await verificationClient.execute(
      'SELECT count(*) AS rowCount, max(payload) AS payload FROM lbbench_writes WHERE id=? AND run_id=?',
      [diagnosticId, report.runId],
    ))[0];
    const totals = rows(await verificationClient.execute(`SELECT
      (SELECT count(*) FROM lbbench_writes WHERE run_id=?) AS persistedInserts,
      (SELECT sum(benchmark_counter) FROM lbbench_users) AS updateCounterAfter`, [report.runId]))[0];
    const diagnosticAcknowledged = diagnosticWrite.acknowledged;
    const originalPersisted = totals.persistedInserts;
    const expectedPersisted = acknowledgedInsertRows + (diagnosticAcknowledged ? 1 : 0);
    const baselineCounter = report.verification?.updateCounterAfter;
    let counterDeltaCheck;
    if (Number.isSafeInteger(baselineCounter) && Number.isSafeInteger(report.updateCounterBefore)
      && Number.isSafeInteger(report.accounting?.acknowledgedUpdates)) {
      if (totals.updateCounterAfter === baselineCounter) {
        const actualDelta = totals.updateCounterAfter - report.updateCounterBefore;
        counterDeltaCheck = {
          status: 'checked', actualDelta,
          expectedDelta: report.accounting.acknowledgedUpdates,
          matches: actualDelta === report.accounting.acknowledgedUpdates,
        };
      } else {
        counterDeltaCheck = { status: 'skipped', reason: 'Counter changed since the source report; another writer may have run' };
      }
    } else {
      counterDeltaCheck = { status: 'skipped', reason: 'Source report lacks a complete counter baseline' };
    }
    const verification = {
      diagnostic: {
        rowCount: diagnostic.rowCount,
        payloadBytes: typeof diagnostic.payload === 'string' ? Buffer.byteLength(diagnostic.payload, 'ascii') : null,
        payloadMatches: diagnostic.payload === payload,
        matches: diagnostic.rowCount === 1 && diagnostic.payload === payload,
      },
      originalRun: {
        persistedInserts: originalPersisted,
        acknowledgedInsertRows,
        acknowledgedDiagnosticWrite: diagnosticAcknowledged ? 1 : 0,
        expectedPersisted,
        matchesAcknowledged: originalPersisted === expectedPersisted,
      },
      counterDeltaCheck,
    };
    result.verification = verification;
    if (!verification.diagnostic.matches || !verification.originalRun.matchesAcknowledged
      || counterDeltaCheck.status === 'checked' && !counterDeltaCheck.matches) {
      hasFailure = true;
      const error = { code: 'VERIFICATION_MISMATCH', message: 'One or more post-load verification checks did not match' };
      result.errors.push({ phase: 'verification', ...error });
    }
  } catch (error) {
    hasFailure = true;
    result.errors.push({ phase: 'verification', ...safeError(error) });
  } finally {
    verificationClient.close();
  }
} catch (error) {
  hasFailure = true;
  result.errors.push({ phase: 'post-load', ...safeError(error) });
} finally {
  result.finishedAt = new Date().toISOString();
  save();
  config.authToken = '';
}

if (hasFailure) process.exitCode = 1;
