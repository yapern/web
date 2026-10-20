Turso vs Layerbase free plan SQLite benchmark evidence

The account owner confirmed that both tested databases were on their providers' Free plans. Account tiers are not embedded in the raw measurement files.

This directory contains a sanitized copy of the benchmark runner and six original reports. All report endpoint origins and database hostnames are replaced recursively with [database-host]. Measurements, run IDs, timestamps, workload settings, and verification results are preserved. No credentials are included.

Figure source: plot.py reads only the two named complete reports below. Re-run from this directory with Python and matplotlib installed: python plot.py
Images are written to a local figures/ directory by default. In the Yapern repository, regenerate the published images with: python plot.py --output-dir ../../../images/blog/turso-vs-layerbase-free-plan-sqlite-systems

Primary Layerbase report: 2026-10-20T04-03-40-647Z-4ae9e466.json
Primary Turso report: 2026-10-20T04-17-22-531Z-11303e64.json
The other four reports are retained as run history, including incomplete/aborted runs; they are not used to build either figure.

Figure 1 includes only ramp stages with requestedDurationSeconds=8, confirmation=false, zero timed errors, zero warmup errors, no stop reason, and elapsedSeconds >= 8. Warmup is excluded from throughput. Layerbase concurrency 128 is omitted because its run had errors; omission does not mean zero throughput. The two panels use independent y axes, each starting at zero.

Figure 2 uses the 20-second zero-error confirmation stages from the primary Turso report. Single inserts: concurrency 64, 55.0904 SQL requests/s and 55.0904 rows/s. Batches: concurrency 16, 41.6866 SQL requests/s and 4168.6649 rows/s (100 rows per statement). Rates divide acknowledged rows or successful requests by elapsed time including drain.

Image files are served from /images/blog/turso-vs-layerbase-free-plan-sqlite-systems/:
  read-versus-write-plateau.png and read-versus-write-plateau-mobile.png
  batch-vs-single.png and batch-vs-single-mobile.png

Suggested alt text:
  Figure 1: Two line charts compare successful SQL requests per second by
  concurrency. Turso point reads rise from 13.28 at one worker to 1505.88 at
  128. Turso single inserts stay near 50 per second from 32 to 128 workers;
  Layerbase reaches 125.07 at 64. Layerbase's 128-worker ramp is omitted
  because that run had errors.
  Figure 2: Two horizontal bar charts compare Turso single-row inserts with
  100-row batch inserts. Batching lowers SQL request throughput from 55.09 to
  41.69 requests per second while raising inserted-row throughput from 55.09
  to 4168.66 rows per second.

The Layerbase report predates the later circuit-breaker/provider-argument updates. The copied source snapshot reflects the runner used for the later Turso runs, including those updates. To reproduce, create a local .env with LIBSQL_URL and LIBSQL_AUTH_TOKEN for Layerbase, or TURSO_URL and TURSO_AUTH_TOKEN for Turso, then run `node run.mjs --provider=layerbase` or `node run.mjs --provider=turso`. Use `--seed-only` to prepare the shared schema/data and `--reuse` for later runs. Each provider has its own database and data.

The benchmark uses a single remote client and warmed data. It does not control server CPU placement, noisy neighbors, region placement, or provider-side scheduling. These reports measure this client and workload, not a universal database-engine maximum.
