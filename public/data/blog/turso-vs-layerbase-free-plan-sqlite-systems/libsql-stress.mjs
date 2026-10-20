import http from 'node:http';
import https from 'node:https';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const DEFAULT_TIMEOUT_MS = 15_000;
const ERROR_SAMPLE_LIMIT = 3;
const ERROR_MESSAGE_LIMIT = 240;

export function loadConfig(provider = 'layerbase') {
  const envKeys = {
    layerbase: ['LIBSQL_URL', 'LIBSQL_AUTH_TOKEN'],
    turso: ['TURSO_URL', 'TURSO_AUTH_TOKEN'],
  };
  const keys = envKeys[provider];
  if (!keys) throw new Error(`Unknown provider "${provider}"; expected layerbase or turso`);

  process.loadEnvFile('.env');
  const [urlKey, tokenKey] = keys;
  const urlValue = process.env[urlKey]?.trim();
  const authToken = process.env[tokenKey]?.trim();
  if (!urlValue) throw new Error(`${urlKey} is required for provider "${provider}"`);
  if (!authToken) throw new Error(`${tokenKey} is required for provider "${provider}"`);

  let url;
  try {
    url = new URL(urlValue.replace(/^libsql:/i, 'https:'));
  } catch {
    throw new Error(`${urlKey} must be a valid libsql:// or https:// URL`);
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new Error(`${urlKey} must resolve to an HTTPS host`);
  }
  url.pathname = '/v2/pipeline';
  url.search = '';
  url.hash = '';
  return { url, authToken, provider };
}

export function encodeValue(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'text', value };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SQL numeric arguments must be finite');
    if (Number.isSafeInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'float', value };
  }
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  throw new TypeError(`Unsupported SQL argument type: ${typeof value}`);
}

function redact(message, token) {
  let safe = String(message ?? 'Unknown error');
  if (token) safe = safe.split(token).join('[redacted]');
  return safe.slice(0, ERROR_MESSAGE_LIMIT);
}

function codedError(code, message, token) {
  const error = new Error(redact(message, token));
  error.code = code;
  return error;
}

function checkHranaErrors(value, token, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value.type === 'error' || (value.error && typeof value.error === 'object')) {
    const detail = value.error ?? value;
    throw codedError(detail.code || 'SQL_ERROR', detail.message || detail.description || 'SQL operation failed', token);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    checkHranaErrors(child, token, seen);
  }
}

export class HranaClient {
  constructor({ url, authToken, maxSockets = 256, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!authToken) throw new TypeError('authToken is required');
    const parsedUrl = url instanceof URL ? new URL(url) : new URL(String(url));
    if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) {
      throw new TypeError('url must be an HTTPS URL with a host');
    }
    parsedUrl.pathname = '/v2/pipeline';
    parsedUrl.search = '';
    parsedUrl.hash = '';
    if (!Number.isInteger(maxSockets) || maxSockets < 1) throw new TypeError('maxSockets must be a positive integer');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');

    this.url = parsedUrl;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
    this.agent = parsedUrl.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets })
      : new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
    this.socketSet = new WeakSet();
    this.stats = { sentBytes: 0, receivedBytes: 0, socketConnections: 0 };
    this.closed = false;
  }

  async execute(sql, args = [], wantRows = true) {
    if (this.closed) throw codedError('CLIENT_CLOSED', 'Client is closed', this.authToken);
    if (typeof sql !== 'string' || sql.length === 0) throw new TypeError('sql must be a non-empty string');
    if (!Array.isArray(args)) throw new TypeError('args must be an array');
    const body = Buffer.from(JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(encodeValue), want_rows: Boolean(wantRows) } },
        { type: 'close' },
      ],
    }));
    this.stats.sentBytes += body.byteLength;

    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks = [];
      let timeout;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result);
      };
      const request = https.request(this.url, {
        method: 'POST',
        agent: this.agent,
        headers: {
          authorization: `Bearer ${this.authToken}`,
          'content-type': 'application/json',
          'content-length': body.byteLength,
        },
      }, (response) => {
        response.on('data', (chunk) => {
          this.stats.receivedBytes += chunk.byteLength;
          chunks.push(chunk);
        });
        response.on('aborted', () => finish(codedError('RESPONSE_ABORTED', 'Response was aborted', this.authToken)));
        response.on('error', (error) => finish(codedError('RESPONSE_ERROR', error.message, this.authToken)));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const text = Buffer.concat(chunks).toString('utf8');
            finish(codedError(`HTTP_${status}`, text || `HTTP ${status}`, this.authToken));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            checkHranaErrors(parsed, this.authToken);
          } catch (error) {
            finish(error.code ? error : codedError('INVALID_RESPONSE', error.message, this.authToken));
            return;
          }
          const first = parsed?.results?.[0];
          const result = first?.response?.result ?? first?.response;
          if (!result || typeof result !== 'object') {
            finish(codedError('INVALID_RESPONSE', 'Response did not contain an execute result', this.authToken));
            return;
          }
          finish(null, result);
        });
      });
      request.on('socket', (socket) => {
        if (!this.socketSet.has(socket)) {
          this.socketSet.add(socket);
          this.stats.socketConnections += 1;
        }
      });
      request.on('error', (error) => {
        finish(codedError(error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'REQUEST_ERROR', error.message, this.authToken));
      });
      timeout = setTimeout(() => {
        const error = codedError('TIMEOUT', `Request exceeded ${this.timeoutMs}ms`, this.authToken);
        request.destroy(error);
        finish(error);
      }, this.timeoutMs);
      request.end(body);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.agent.destroy();
  }
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function latencySummary(values) {
  let maxMs = null;
  for (const value of values) maxMs = maxMs === null ? value : Math.max(maxMs, value);
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs,
  };
}

function safeOperationCounts(value) {
  const counts = {};
  for (const key of ['readQueries', 'writeQueries', 'rowsWritten', 'rowsReturned']) {
    const count = Number(value?.[key] ?? 0);
    counts[key] = Number.isFinite(count) && count > 0 ? count : 0;
  }
  return counts;
}

async function runPhase({ client, concurrency, durationSeconds, operation, context, shouldStop }) {
  const startedAt = performance.now();
  const deadline = startedAt + durationSeconds * 1000;
  const metrics = {
    requestedDurationSeconds: durationSeconds,
    successes: 0,
    errors: 0,
    readQueries: 0,
    writeQueries: 0,
    rowsWritten: 0,
    rowsReturned: 0,
    latencyMs: [],
    readLatencyMs: [],
    writeLatencyMs: [],
    errorCodes: {},
    errorSamples: [],
    stopReason: null,
  };
  let cancelled = false;
  const noteStop = (reason) => {
    if (!cancelled) {
      cancelled = true;
      metrics.stopReason = reason;
    }
  };
  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    let iteration = 0;
    while (!cancelled && performance.now() < deadline) {
      if (shouldStop?.()) {
        noteStop('budget');
        break;
      }
      const opStarted = performance.now();
      try {
        const result = await operation(workerId, iteration, context);
        const latency = performance.now() - opStarted;
        metrics.successes += 1;
        metrics.latencyMs.push(latency);
        const counts = safeOperationCounts(result);
        for (const [key, value] of Object.entries(counts)) metrics[key] += value;
        if (counts.writeQueries > 0) metrics.writeLatencyMs.push(latency);
        if (counts.readQueries > 0) metrics.readLatencyMs.push(latency);
      } catch (error) {
        const latency = performance.now() - opStarted;
        metrics.errors += 1;
        metrics.latencyMs.push(latency);
        const code = String(error?.code || 'ERROR');
        metrics.errorCodes[code] = (metrics.errorCodes[code] || 0) + 1;
        if (metrics.errorSamples.length < ERROR_SAMPLE_LIMIT) {
          metrics.errorSamples.push({ code, message: redact(error?.message, client.authToken) });
        }
      }
      iteration += 1;
      const completed = metrics.successes + metrics.errors;
      if (completed >= 20 && metrics.errors >= 10 && metrics.errors / completed > 0.2) {
        noteStop('error_storm');
      }
      if (shouldStop?.()) noteStop('budget');
    }
  });
  await Promise.all(workers);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const attempted = metrics.successes + metrics.errors;
  return {
    ...metrics,
    latencyMs: latencySummary(metrics.latencyMs),
    readLatencyMs: latencySummary(metrics.readLatencyMs),
    writeLatencyMs: latencySummary(metrics.writeLatencyMs),
    attempted,
    errorRate: attempted ? metrics.errors / attempted : 0,
    elapsedSeconds,
    successfulRequestsPerSecond: elapsedSeconds ? metrics.successes / elapsedSeconds : 0,
    errorCodes: metrics.errorCodes,
    errorSamples: metrics.errorSamples,
  };
}

export async function runStage({
  client,
  name,
  concurrency,
  durationSeconds = 10,
  warmupSeconds = 2,
  operation,
  context = {},
  shouldStop,
}) {
  if (!client || typeof client.execute !== 'function') throw new TypeError('client must provide execute()');
  if (typeof name !== 'string' || !name) throw new TypeError('name must be a non-empty string');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) throw new TypeError('durationSeconds must be at least 1');
  if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0) throw new TypeError('warmupSeconds must be non-negative');
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');

  const warmup = warmupSeconds > 0
    ? await runPhase({ client, concurrency, durationSeconds: warmupSeconds, operation, context, shouldStop })
    : null;
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const cpuBefore = process.cpuUsage();
  const phase = warmup?.stopReason
    ? { ...await runPhase({ client, concurrency, durationSeconds, operation, context, shouldStop: () => true }),
      stopReason: `warmup_${warmup.stopReason}` }
    : await runPhase({ client, concurrency, durationSeconds, operation, context, shouldStop });
  const cpu = process.cpuUsage(cpuBefore);
  eventLoop.disable();
  const result = {
    name,
    concurrency,
    warmup,
    ...phase,
    eventLoopDelayMs: {
      mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null,
      p99: Number.isFinite(eventLoop.percentile(99)) ? eventLoop.percentile(99) / 1e6 : null,
      max: Number.isFinite(eventLoop.max) ? eventLoop.max / 1e6 : null,
    },
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
  };
  console.log(JSON.stringify({
    stage: name,
    concurrency,
    successes: result.successes,
    errors: result.errors,
    rps: Number(result.successfulRequestsPerSecond.toFixed(2)),
    p95Ms: result.latencyMs.p95Ms === null ? null : Number(result.latencyMs.p95Ms.toFixed(2)),
    stopReason: result.stopReason,
  }));
  return result;
}
