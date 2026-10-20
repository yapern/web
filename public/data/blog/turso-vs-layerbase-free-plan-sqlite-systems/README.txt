Turso vs Layerbase free-plan SQLite benchmark evidence

The account owner confirmed that both tested databases were on their providers'
Free plans. Account tiers are not embedded in the raw measurement files.

This directory contains a sanitized copy of the benchmark runner and nine
reports: six original reports plus the October 20 Layerbase full retest, focused
write attempt, and post-load probe report. Database endpoints are replaced
recursively with [database-host], and credentials are omitted. Measurements,
run IDs, timestamps, workload settings, and verification results are retained.
Insert counts are scoped to each report's run_id; update counts are checked by
counter delta because updates do not carry a run_id.

The Layerbase retest source worktree was at commit 6f0aacc. The new Layerbase
reports and primary Turso report use the same schema SHA-256
43537bf04c8a42aeaeaa4e223a8e4c0c2ba1b369cfacd6d4326c8281f0e632b6 and runtime:
Node.js 22.22.2, macOS arm64, 16 logical CPUs. Both used the same Hrana v2 JSON
over HTTPS/1.1 transport, with pooled TCP/TLS connections, one SQL statement
and stream close per request, and no retries. Platform-side connection pooling
was not recorded and remains unknown. The original Turso reports do not record
a source commit.

Figure 1 reads the new Layerbase full report
2026-10-20T18-14-10-474Z-6290593e.json and the original Turso report
2026-10-20T04-17-22-531Z-11303e64.json. It includes clean eight-second ramp
stages only: zero measurement errors, zero warmup errors, no stop reason, and
at least eight elapsed seconds. Layerbase's clean concurrency-128 single-write
stage is included; its concurrency-128 point-read ramp is omitted because the
warmup had 40 ECONNRESET errors. The two panels use independent y axes starting
at zero. The curves show tested stages, not mathematical capacity limits.

Figure 2 and its desktop and mobile images are unchanged. They use the original
Turso report's clean 20-second confirmations: single inserts at concurrency 64
reached 55.09 SQL requests/s and 55.09 rows/s; batches at concurrency 16
reached 41.69 SQL requests/s and 4168.66 rows/s (100 rows per statement).

Table provenance: all Layerbase entries use the new full report
2026-10-20T18-14-10-474Z-6290593e.json. The Turso point-read confirmation at
192 workers (2266.3472 requests/s) comes from original report
2026-10-20T04-26-20-390Z-e75c79e0.json; the other five Turso entries use
original report 2026-10-20T04-17-22-531Z-11303e64.json.

The Layerbase full run's clean 20-second confirmations were:

Workload                              Concurrency   SQL requests/s   Rows/s
Point lookup                                32             74.37        —
Indexed join (20 rows)                     128            127.61        —
Single-row INSERT                          128            116.76    116.76
Single-row UPDATE                          128            118.67    118.67
80% reads / 20% inserts                     32            109.47     21.87
100-row atomic INSERT batch                  4             25.27   2526.66

All six confirmations completed with zero errors, including warmup. Rates use
the elapsed time including in-flight drain; warmup traffic is excluded. These
are the best clean confirmations from the tested stages, not maxima that include
errors. In the full run, the 128-worker point-read warmup stopped after 40
REQUEST_ERROR/ECONNRESET failures. The batch-insert ramp at concurrency 16 had
29 SQLITE_BUSY errors; its clean confirmation was at concurrency 4. Other full
run ramp stages and warmups had no errors.

The later focused single-insert run requested a 20-second stage at concurrency
128, followed by a planned 60-second confirmation. Its warmup hit an error storm:
96 REQUEST_ERROR/ECONNRESET errors and 51 acknowledged inserts. Measurement and
the planned confirmation were skipped, so this run has no throughput result.
The separate post-load report records ten sequential SELECT 1 probes at
35-second intervals after the focused report finished, plus one diagnostic
insert and persistence checks. Probe 1 received ECONNRESET and probes 2–10
passed at 35.059 through 315.059 seconds; the helper exited nonzero because one
probe failed. The diagnostic INSERT was acknowledged; verification found 52
focused-run rows (51 benchmark inserts plus one diagnostic), the exact 256-byte
payload, and an unchanged counter of 7,139. Details are in
2026-10-20T18-21-29-045Z-10224f69-post-load.json.

Persistence checks for the full run matched 150,850 acknowledged inserts and
7,139 acknowledged updates. It reported zero invalid payloads, zero foreign
key violations, and SQLite quick_check=ok. The focused report matched its 51
acknowledged inserts, with the counter still at 7,139. Both runs used --reuse,
so prior rows remained in the database; counts above are scoped to each run ID.

The provider response in layerbase-response-2026-10-20.txt is vendor-supplied,
not an independent test result. It reports 45 vendor test runs with up to 128
concurrent writers and zero stalls/lost writes. No patch, server build ID, or
public upstream issue was supplied with that response.

To regenerate charts from this flat directory, install Python and matplotlib,
then run:
  python plot.py

In the Yapern repository, publish regenerated charts with:
  python plot.py --output-dir ../../../images/blog/turso-vs-layerbase-free-plan-sqlite-systems

To rerun from this directory, prepare a local .env with the provider
credentials. The completed focused run prints its result path. Pass the new
focused report to post-load.mjs, replacing the placeholder with that path:
  node run.mjs --provider=layerbase --reuse --max-concurrency=128
  node run.mjs --provider=layerbase --reuse --max-concurrency=128 --concurrency=128 --duration=20 --confirmation=60 --families=single_insert
  node post-load.mjs results/NEW_FOCUSED_RUN_ID.json

The first command runs the bounded full workload on populated tables. The
second repeats the focused 128-writer attempt. The third runs the bounded
post-load probes and diagnostic write against that new completed report. The
runner defaults to 8-second ramps and 20-second confirmations; the focused
command sets its attempted measurement and confirmation durations explicitly.

The evidence archive contains all nine reports, this README, the provider
response, summary, post-load helper, runner, transport implementation, schema,
plot source, and LICENSE. It excludes credentials and rendered images.
