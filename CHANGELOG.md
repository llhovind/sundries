# Changelog

Notable changes to Sundries. Versions follow [semantic versioning](https://semver.org/),
with the 0.x caveat that a **minor** bump is where breaking changes land until 1.0.

`sundries-api` and `sundries-ui` are versioned in lockstep — they deploy as one
unit, and a release number that means two different things for the two halves
would be worse than useless.

## [0.2.0] — 2026-07-31

### ⚠️ Upgrading from 0.1.0 requires manual steps

**This release cannot be deployed by restarting.** Two operator actions are
required, in this order:

1. **Node 22.12+ is now the floor** (was 20.19+). pg-boss v12 is ESM-only and
   requires it. `engine-strict` is now on, so `npm ci` refuses to install on an
   older Node rather than failing later at runtime.
2. **The pg-boss queue schema must be dropped and recreated.** pg-boss v10 owns
   schema version 24, v12 migrates only from 25 up, and no released version
   bridges the two — there is no in-place upgrade path. The API will refuse to
   start against the old schema.

   Drain the queue first: stop the API and any `npm run worker` instances,
   confirm nothing is left in `created`/`active`/`retry`, then drop the schema.
   It is recreated automatically on next start. **Anything still queued at that
   point is discarded.** Full procedure, including the drain query:
   [README §4](README.md#4-backup--recovery).

   The `pgboss` schema holds queue state only — no catalog, order, or ledger
   data is affected. Recurring work (reservation sweep, backorders, search
   indexing) needs no rescue: schedules are reinstalled at startup.

Fresh installs are unaffected and need none of the above.

### Added

- **Queue port** (`backend/services/queue/`) — background job transport now
  sits behind a port with two adapters, following the same ports-and-adapters
  shape as the mail, search, payments, and image registries. `services/jobs.js`
  keeps the domain side (which queues exist, what they do, how often) and no
  longer constructs a queue client directly.
- `QUEUE_PROVIDER` config: `pgboss` (default — durable, retried, scheduled) or
  `inline`, which runs enqueued work on the caller's stack and no scheduled
  work at all. Validated at startup; an unknown value fails the boot.
- `npm run test:queue` — pg-boss adapter contract tests (enqueue, worker
  pickup, exactly-once delivery, retry-on-throw) on `node:test`. Separate from
  Jest because Jest's runtime rewrites dynamic `import()` to `require()` and so
  cannot load an ESM-only package at all. Wired into CI.

### Changed

- pg-boss 10.4.2 → 12.26.3. `PgBoss` is now a named export.
- Jest suites run on the `inline` queue adapter, making a job's effects visible
  on the next line instead of after a poll interval. Backend suite time dropped
  from ~30s to ~5s.

## [0.1.0]

Initial development version — everything prior to the changelog. Storefront and
staff admin, catalog with variants and images, cart and checkout with payment
and mail adapters, inventory with reservations and multi-warehouse transfers,
purchasing, RMAs, shipments, RBAC with a permissions editor, audit trail,
reporting with scheduled runs, and GDPR request handling.
