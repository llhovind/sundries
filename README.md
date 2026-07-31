# Sundries

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

A self-hosted ecommerce platform for physical goods: Express + PostgreSQL backend (plain SQL,
no ORM) and a Vue 3 frontend. It makes no assumptions about what you sell — single items,
items with option variants (color, quality, size), and goods cut to length (feet/yards/meters)
are all first-class, over multi-warehouse FIFO-costed inventory, reservations at checkout, and
an immutable inventory/payments audit trail.

Domain-agnostic in what it sells, opinionated in how it holds together. The same codebase
scales **down** to a single-maker shop doing a few orders a week and **up** to multi-instance
cloud deployments — the difference is configuration, not code.

![The Sundries storefront showing the demo catalog: a unit good, a good with option
variants, and a cut-to-length good priced per foot](docs/images/sundries-screenshot.png)

<sub>The storefront after `npm run seed:demo` (§1) — the three products are the three
selling models: plain unit good, option-variant matrix, and goods sold by the foot.</sub>

---

## Architecture at a glance

```
                    ┌─────────────────────── DMZ ────────────────────────┐
 Internet ── LB/443 ─▶ API instances (Node/Express, stateless, N ≥ 1)     │
                    │      │ SQL                  │ search    │ SMTP/SES  │
                    │      ▼                      ▼           ▼           │
                    │  PostgreSQL            OpenSearch    Mail relay     │
                    │  (primary [+replicas])  (optional)                  │
                    └─────────────────────────────────────────────────────┘
```

* **Only the API is web-facing.** DB, search, and mail live behind it.
* **Integrity lives in the database**: balance maintenance, FIFO costing,
  reservation math, oversell guards, and ledger immutability are triggers,
  functions, and CHECK constraints — safe under any number of API instances.
* **The queue is built in**: background work runs on Postgres via pg-boss —
  durable, retried and cron-scheduled, with no Redis or RabbitMQ to operate.
  Like mail, search, payments and image storage it sits behind a port
  (`QUEUE_PROVIDER`, §5), so the transport is replaceable without touching
  domain code.
* **Layering**: routes → controllers → services (domain logic) → models (all SQL).
* `inventory_transactions` and `payment_events` are append-only; corrections are
  reversing entries. `audit_log` records privileged changes.

---

## Application surface

**Storefront** (`/shop`): catalog with option variants and measured (cut-to-length)
goods, cart, member + guest checkout, promotions, order history with per-line
return requests. Login is passwordless — emailed one-time codes with a
brute-force lockout — and sessions use rotating refresh tokens: reuse of a
retired token revokes the whole token family.

**Staff UI**: a permission-filtered sidebar (staff see only the links their
roles can use) grouped as **Sales** (Orders, Returns, Customers), **Catalog**
(Products, Categories, Promotions), **Inventory** (Stock, Transfers,
Purchasing), **Admin** (Users, Roles, Settings, Audit Log), plus **Reports**:

* **Inventory** — multi-warehouse stock with FIFO cost layers; transfers move
  stock through an in-transit `transport` warehouse; purchase orders receive
  at line level and write costed IN ledger rows (vendors are created from the
  Purchasing screen). Received stock fills backorders and sends back-in-stock
  notifications automatically (1-minute job).
* **Orders** — fulfillment with capture-on-first-ship and partial shipments,
  refunds (cumulative-guarded), and an RMA queue with a configurable return
  window (`returns.window_days`) and suggested-refund prefill.
* **Admin** — user management (staff filters, multi-role grants), a roles &
  permissions editor (guarded by `roles:manage`; `admin`/`customer` roles are
  locked), and store settings (§5). Endpoint permissions live in
  `backend/config/routePermissions.js`, a code-only map validated against the
  live router and the `permissions` table at boot — an unguarded endpoint or
  unknown permission code fails startup. The audit log viewer (`audit:read`)
  reads the immutable `audit_log` written by database triggers, with the acting
  user, IP and correlation id on every row.
* **Reports** — each report is one self-contained file in
  `backend/controllers/reports/` (metadata + params + columns + SQL),
  discovered at boot; access is per category permission
  (`reports:sales|finance|inventory|purchasing`). Reports run immediately or
  as stored runs (detached subprocess via `bin/reportRunner.js`, JSONB
  snapshot, CSV download, completion email), and can declare a cron schedule.
  Adding a report is one file; a broken report file is logged and skipped,
  never crashes the API.

GDPR/CCPA request intake exists (`POST /api/v1/compliance/requests`), but
processing is deliberately semi-manual — see the flagged stub notes in
`backend/services/complianceService.js`.

**API reference**: [`docs/API.md`](docs/API.md) lists every endpoint with the
permission each requires. It is *generated* (`cd backend && npm run docs:api`)
from `backend/config/routePermissions.js` — the same map the server validates
against its live router at boot — so it lists exactly what the API serves, with
the codes the guards actually enforce.

---

## 1. Local development

### Prerequisites

* Node.js 22.12+ — pg-boss v12 is ESM-only and requires it, and the frontend's
  Vite 8 toolchain wants the same floor
* PostgreSQL 13+ (16 recommended — the version CI tests against) and somewhere
  for mail to land. Login is
  passwordless, so the very **first** sign-in needs a working mailbox. Both come
  up together with the bundled Compose file — nothing else to install:

  ```bash
  docker compose up -d      # Postgres on :5432, Mailpit on :1025 (SMTP) + :8025 (web UI)
  ```

  The matching `backend/.env` lines are `DB_USER=postgres`, `DB_PASSWORD=dev`,
  `DB_NAME=store`, `DB_SSL=false`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`; read
  the OTP codes at http://localhost:8025. `docker compose down -v` wipes the
  database volume when you want a clean slate.

  Prefer your own Postgres / SMTP? Point `DB_*` / `SMTP_*` at them instead — nothing
  requires Compose. (The `.env.example` default of `DB_USER=store_web` assumes a
  database where you have already created a dedicated app role — see §2.)

### Setup

```bash
# Backend
cd backend
npm install
cp .env.example .env         # then edit: DB_*, JWT secrets, SMTP_*, ADMIN_EMAIL
npm run setup                # = npm run migrate (schema + seeds) + node db/bootstrap.js (initial admin)
npm run seed:demo            # optional: sample catalog with stock (see below)
npm run dev                  # API on http://localhost:3000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                  # UI on http://localhost:5173, proxies /api to :3000
```

Sign in at http://localhost:5173/login as `ADMIN_EMAIL`: enter the address, then the
one-time code that arrives in Mailpit.

Notes:

* For a local DB set `DB_SSL=false`. Auth is passwordless: the initial admin
  (`ADMIN_EMAIL`) logs in by requesting an emailed one-time code, so SMTP settings must
  point at something real — for development, [Mailpit](https://github.com/axllent/mailpit)
  or a Gmail app password both work.
* Migrations are ordinary `.sql` files in `backend/db/migrations/`, applied in filename
  order and tracked in `schema_migrations`. A fresh database is fully constructed and
  seeded (roles/permissions, units of measure, MAIN + TRANSIT warehouses, shipping rules)
  by `npm run migrate`. `npm run migrate` creates the database itself if the configured
  user has `CREATEDB`.

### Optional: the demo catalog

`npm run setup` leaves you with a correct but **empty** store — no products, so the
storefront and the checkout demo below have nothing to sell. `npm run seed:demo`
fills it in:

* three products covering the three selling models — a plain unit good, a unit good
  with a Color × Size option matrix, and a cut-to-length good sold by the foot
* opening stock received into `MAIN` at **two different unit costs** for several
  variants, so FIFO costing is visible in the ledger and the COGS report rather than
  being a claim in a README
* one out-of-stock variant, so the backorder / notify-me path is reachable
* a demo vendor, so purchase orders can be raised immediately

It is idempotent (a marker in `products.attributes`), refuses to run with
`NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`, and writes through the models
rather than raw SQL — the demo rows are built exactly the way the app builds real
ones. Contents live in `backend/db/demoCatalog.js`; remove them with
`DELETE FROM products WHERE attributes ? 'demo_seed';`.

To build a catalog by hand instead: sign in as the admin and use **Catalog → Products**
(product → options → variants), then receive stock in **Inventory → Stock** or via a
purchase order in **Inventory → Purchasing** (which is also where vendors are created).

### Demo: checkout with the fake payment provider

`PAYMENT_PROVIDER=fake` (the default) swaps Stripe for a local simulator that
drives the exact same webhook pipeline as production — no keys, no network.
With the API running and a catalog in place (`npm run seed:demo`, or your own
products — `curl -s localhost:3000/api/v1/products` to find a real `variant_no`):

```bash
# 1. Guest places an order (creates an implicit customer account)
#    variant_no 1 is the demo seed's cast-iron skillet.
curl -s -X POST localhost:3000/api/v1/checkout/guest -H 'Content-Type: application/json' -d '{
  "email":"demo@example.com", "name":"Demo Guest",
  "shipTo":{"address":"1 Demo St","city":"Springfield","state":"IL","zip":"62701","country":"US"},
  "items":[{"variant_no":1,"qty":2}]}'
# → note content.order.payment.intent_ref in the response

# 2. Simulate the shopper completing payment (the provider "webhook")
curl -s -X POST localhost:3000/api/v1/payments/fake/confirm \
  -H 'Content-Type: application/json' \
  -d '{"intent_ref":"fpi_...","outcome":"authorized"}'   # or "failed" / "cancelled"
```

The order transitions `pending_payment → paid`, reservations are consumed, and
FIFO-costed OUT rows land in the ledger. Reservations not confirmed within 15
minutes are released by the sweeper (`PaymentsService.sweepExpired()`, cron §2).
The fake provider refuses to run with `NODE_ENV=production` unless
`ALLOW_FAKE_PAYMENTS=true`. To use real Stripe: `npm install stripe`, set
`PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
point a Stripe webhook at `POST /api/v1/payments/webhook/stripe`.

### Tests

```bash
cd backend  && npm test              # Jest — API + DB integration suites
cd backend  && npm run test:queue    # node:test — pg-boss queue adapter contract
cd frontend && npm run test:unit     # Vitest — component and config units
cd frontend && npx playwright test   # Playwright — end-to-end, boots API + Vite itself
```

All four run in CI on every push and pull request (`.github/workflows/ci.yml`).

`test:queue` is separate because pg-boss is ESM-only and Jest's runtime rewrites
dynamic `import()` to `require()`, so it cannot load the package at all. The Jest
suites therefore run on the `inline` queue adapter (work executes on the caller's
stack), and the real transport — enqueue, worker pickup, retry-on-throw — is
covered on `node:test`, which loads ESM natively. Both drive the same port, so
neither is testing a mock of the other.

The backend suites are integration-style: they exercise the real DB triggers, reservation
functions, and the full route→controller→service path, so they need a **disposable**
database: create one, run `npm run migrate` against it, point `.env` at it. Ledger
rows are append-only by design; recreate the test DB rather than trying to clean it.
(Mail is forced to the `noop` adapter during tests.) The e2e run needs a migrated
database too — `playwright.config.js` starts both servers against whatever `.env` says.

---

## 2. Small data center / on-prem (single shop)

Target: one app server + one DB server (or even one box), ~98% uptime, minimal moving parts.

**Topology**

* `web1`: Node API under systemd, nginx in front for TLS + static frontend files
* `db1`: PostgreSQL 16; only reachable from `web1` (firewall / private VLAN)
* Both in a DMZ; only nginx :443 is exposed

> **Per-IP rate limiting is the deployment's job.** The API rate-limits OTP
> requests per account and login attempts per code, but deliberately ships no
> per-IP throttling — implement it at the reverse proxy or WAF in front of the
> API (e.g. nginx `limit_req` on `/api/v1/auth/*`, or AWS WAF rate-based rules
> on a cloud deployment) so one client cannot spray OTP email across many
> addresses or hammer `/register`.

> **Security headers ship in the app.** The API applies [`helmet`](https://helmetjs.github.io/)
> globally (CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and it strips
> `X-Powered-By`). Defaults assume nginx serves the SPA and proxies `/api` +
> `/images` from the **same origin** — if you split the frontend onto a different
> origin, relax helmet's CSP / Cross-Origin-Resource-Policy in `backend/app.js`
> accordingly. HSTS only takes effect over HTTPS, so terminate TLS at nginx.

**Install checklist**

1. PostgreSQL on `db1`: create the database and an app user (see grants below).
2. On `web1`: clone the repo, `npm ci` in `backend/`, build the frontend
   (`cd frontend && npm run build`) and let nginx serve `frontend/dist/`.
3. `backend/.env`: production values, `DB_SSL=true` (or `no-verify` for self-signed),
   `NODE_ENV=production`, `COOKIE_SECURE=true`.
4. `npm run setup` once, then run the API under systemd:

   ```ini
   # /etc/systemd/system/store-api.service
   [Unit]
   Description=Store API
   After=network.target
   [Service]
   WorkingDirectory=/opt/sundries/backend
   ExecStart=/usr/bin/node ./bin/www
   Restart=always
   User=store
   EnvironmentFile=/opt/sundries/backend/.env
   [Install]
   WantedBy=multi-user.target
   ```

5. Cron: only the backup needs external scheduling — background jobs
   (reservation sweeper, backorder fulfillment + back-in-stock notifications,
   search indexing, emails, fraud screening, scheduled reports, daily sales
   rollup, partition and refresh-token maintenance) run inside the API
   process, queued and scheduled on the database you already have. There is
   no broker to install here:

   ```cron
   # nightly logical backup at 02:15 (see §4)
   15 2 * * * /opt/sundries/backend/db/backup.sh >> /var/log/store-backup.log 2>&1
   ```

> **Catalog images are on local disk here** (`IMAGE_PROVIDER` unset →
> `backend/uploads/`, served by the API at `/images`). Two consequences for this
> tier: the directory must live on persistent storage (not a container layer), and
> **`db/backup.sh` does not cover it** — back `uploads/` up alongside the database
> (e.g. `rsync`/`tar` in the same nightly cron), or DB rows will outlive the files
> they point at. More than one API instance requires the S3 store instead (§3).

**Defense-in-depth grants** (recommended): the ledgers are already trigger-protected,
but you can additionally revoke destructive rights from the app user:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON inventory_transactions, payment_events, audit_log FROM store_web;
GRANT  UPDATE (processed_at, _payment_no) ON payment_events TO store_web;
```

**Scale-down settings**: leave `inventory.partition_months = -1` (app_settings) — all
ledger rows live in the default partition, which behaves exactly like a plain table.
Search runs on the built-in Postgres adapter; no OpenSearch server needed.

---

## 3. Cloud deployment (scale-up framework)

Target: multi-instance API, managed Postgres (RDS or similar), realistic 99.95–99.99%
availability with Multi-AZ.

| Concern | Approach |
|---|---|
| API | 2+ stateless instances (containers or VMs) behind an ALB/NLB; health check `GET /`; deploy rolling |
| Database | RDS PostgreSQL Multi-AZ; `DB_SSL=true`; app instances in private subnets |
| Connections | PgBouncer (transaction pooling) between API fleet and Postgres once instances × `DB_POOL_MAX` approaches the DB's `max_connections` |
| Reads | Route heavy catalog/report reads to a read replica (introduce a second pool in `common/db.js` when needed) |
| Ledger growth | Set `inventory.partition_months` (e.g. `3`) and schedule `SELECT fn_ensure_inventory_partitions(3);` monthly — **enable this from day one on high-volume shops**; carving partitions after rows exist in the default partition requires manual data movement |
| Background jobs | Set `JOBS_INLINE=false` on the API fleet; run `npm run worker` on 1–2 dedicated instances (pg-boss coordinates via Postgres — sweeper, backorders, search indexing, emails, fraud screening, scheduled reports, partition/token maintenance) |
| Search | OpenSearch on its own server/managed domain (`SEARCH_PROVIDER=opensearch`, `npm i @opensearch-project/opensearch`); catalog changes flow through the `search_outbox` table so index updates survive OpenSearch downtime |
| Email | SES adapter (`MAIL_PROVIDER=ses`, `npm i @aws-sdk/client-sesv2`); keep SMTP for small installs |
| Images | `IMAGE_PROVIDER=s3` + CDN instead of the local `uploads/` directory — **required as soon as there are 2 API instances** (see below) |
| Backups | RDS automated backups + snapshots for PITR, **plus** periodic `db/backup.sh` archives to S3 as a provider-independent escape hatch |
| Secrets | Inject env vars from your secret manager; never bake them into images |

### Catalog images on S3

`primary_image` stores an opaque key (`<product_no>/<filename>`), never a URL, and
every storage adapter derives the *same* key — so switching stores is configuration
plus a file copy, never a data migration.

1. **Bucket**: Block Public Access **on**, versioning **on** (this is also the images'
   backup), a lifecycle rule expiring noncurrent versions after ~30 days.
2. **CDN**: CloudFront with the bucket as an origin via Origin Access Control, and a
   `/images/*` behaviour pointing at it — `S3_PREFIX` defaults to `images` so public
   path and bucket key line up with no rewrite rule. The API is then never in the
   image *read* path.
3. **IAM** for the API's task/instance role — write-only, since the CDN does the reading:

   ```json
   { "Effect": "Allow",
     "Action": ["s3:PutObject", "s3:DeleteObject"],
     "Resource": "arn:aws:s3:::my-store-images/images/*" }
   ```

4. **Install and configure**: `npm install @aws-sdk/client-s3`, then

   ```bash
   IMAGE_PROVIDER=s3
   S3_BUCKET=my-store-images
   S3_PREFIX=images                                  # optional, this is the default
   IMAGE_PUBLIC_BASE_URL=https://cdn.example.com/images
   ```

   `IMAGE_PUBLIC_BASE_URL` is required with `s3` (startup fails without it) and is
   what a key is joined onto to form a public URL. If your CDN routes `/images/*`
   itself the API never uses it; if it doesn't, the API answers `/images/<key>` with
   a cacheable 302 there, so images work either way rather than 404ing silently.

5. **Migrate existing files, then cut over** — the copy is idempotent and touches no
   database rows, so `uploads/` stays intact as a rollback path:

   ```bash
   node bin/migrateImagesToS3.js --dry-run   # counts and validates, uploads nothing
   node bin/migrateImagesToS3.js             # then flip IMAGE_PROVIDER and restart
   ```

**Sizing intuition**: 500k orders/day ≈ 6/sec sustained. With balances/costing as single
indexed row updates (no ledger scans on the read path), a mid-size RDS instance handles
this; the design goal is that nothing in the hot path grows with history.

---

## 4. Backup & recovery

Simple, provider-independent, restore-tested:

* **Backup**: `backend/db/backup.sh` — compressed `pg_dump` custom-format archive to
  `BACKUP_DIR`, pruning archives older than `BACKUP_RETENTION_DAYS` (`.env`). Schedule
  daily (or hourly for busier shops) via cron/scheduler. Safe while the app is live.
* **Restore**: `backend/db/restore.sh <archive> [target_db]` — drops and recreates the
  target database, restores, prints sanity counts. Stop the API (or restore into a
  side-by-side DB and switch `DB_NAME`) during restore.
* **Drill it**: restore last night's archive into a scratch database on a schedule and
  run the sanity queries — an unrestored backup is a hope, not a plan.
* On RDS, treat native automated backups as primary (point-in-time recovery) and these
  archives as the portable fallback.
* **Images have no built-in backup — this is a DevOps addition, not a code one.**
  Nothing in this repo backs up the files served at `/images`: `db/backup.sh` dumps
  the database only, and the image storage adapters (`uploads/`, S3) write files but
  never copy them anywhere. Covering them is a deployment-level task you must add:
  on the local store, include `backend/uploads/` in your file backup (e.g. `rsync`
  or `tar` in the same nightly cron as the DB dump, with matching retention); on the
  S3 store, bucket versioning plus the noncurrent-version lifecycle rule (§3) is the
  equivalent, and cross-region replication if the bucket itself is a single point of
  failure. Until that exists, image loss is unrecoverable — the database keeps the
  `primary_image` keys, so a restore yields rows pointing at files that no longer
  exist and a catalog full of broken images.

### Upgrading: pg-boss 10 → 12 requires resetting the queue schema

**This one is not a restart-and-go.** pg-boss v10 owns schema version 24; v12
migrates only from 25 and up, and no published release contains a 24 → 25 step
(v11.0's migration table is empty, v11.1 starts at 25). There is therefore no
in-place upgrade path, and pg-boss will refuse to start against a v10 schema:

```
Cannot migrate pg-boss schema from version 24: the oldest supported starting
version is 25. Upgrade to a schema at or above that version using an older
pg-boss release first.
```

The `pgboss` schema holds only queue state — never catalog, order, or ledger
data — so recreating it is safe for the shop, but **anything still queued is
discarded**. Drain first:

```bash
# 1. Stop everything that enqueues or works: API instances and `npm run worker`.
# 2. Confirm nothing is left in flight — expect zero rows.
psql "$DATABASE_URL" -c \
  "SELECT state, count(*) FROM pgboss.job WHERE state IN ('created','active','retry') GROUP BY state;"
# 3. Drop the queue schema. It is recreated automatically on next start.
psql "$DATABASE_URL" -c "DROP SCHEMA pgboss CASCADE;"
# 4. Deploy, then start the API (or worker) as usual.
```

If step 2 shows rows, let the workers finish before proceeding — those are
unsent emails, unscreened orders and unswept reservations. Recurring work
(sweeper, backorders, indexing) needs no rescue: schedules are reinstalled at
startup and the next tick picks the work back up.

---

## 5. Configuration reference

Environment (`backend/.env`, validated at startup — see `common/config.js`;
unknown provider names or missing provider credentials fail the boot with every
problem reported at once):

| Variable | Purpose |
|---|---|
| `DB_HOST/PORT/USER/PASSWORD/NAME` | PostgreSQL connection |
| `DB_SSL` | `true` (verify certs — production), `no-verify` (self-signed), `false` (local) |
| `DB_POOL_MAX` | Pool size per API instance (default 10) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Token signing (32+ random chars each) |
| `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES` | Access-token lifetime (default `15m`) / refresh sliding window in days (default 7) |
| `MAIL_PROVIDER` | `smtp` (default) / `ses` / `noop`; `SMTP_*` only required for smtp, SES needs `SES_FROM` or `SMTP_FROM` |
| `SMTP_*` | Mail relay for OTP login codes and notifications |
| `PAYMENT_PROVIDER` | `fake` (default — refused in production without `ALLOW_FAKE_PAYMENTS=true`) / `stripe` (requires `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`) |
| `SEARCH_PROVIDER` | `postgres` (default) / `opensearch` (with `OPENSEARCH_URL`, `OPENSEARCH_INDEX`) |
| `JOBS_INLINE` | `false` moves background jobs off the API onto `npm run worker` instances |
| `QUEUE_PROVIDER` | `pgboss` (default — Postgres-backed, durable, retried, scheduled) / `inline` (runs enqueued work on the caller's stack and no scheduled work at all) |
| `IMAGE_PROVIDER` | `local` (default — `backend/uploads/`, single instance only) / `s3` (requires `S3_BUCKET` + `IMAGE_PUBLIC_BASE_URL`, and `npm i @aws-sdk/client-s3`) |
| `S3_PREFIX`, `IMAGE_PUBLIC_BASE_URL` | Bucket sub-path for images (default `images`) and the public base a stored key is joined onto to form its URL |
| `ADMIN_EMAIL`, `ADMIN_USERNAME` | Initial admin created by `db/bootstrap.js` (OTP login, no password) |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | Used by `db/backup.sh` |
| `COOKIE_SECURE`, `NODE_ENV`, `PORT` | Runtime behavior |
| `TRUST_PROXY` | Express `trust proxy` for the reverse-proxy tiers below — sets how `req.ip` (logs + audit rows) and `req.protocol` read `X-Forwarded-*`. Unset = trust nobody (direct-to-internet single instance). Set to the **number of proxies in front** (e.g. `1` for one nginx/ALB — preferred, prevents client `X-Forwarded-For` spoofing), or a trusted IP/CIDR list or preset (`loopback`), or `true` (trusts the whole chain — insecure, avoid). |

Store-tunable settings live in the `app_settings` table, editable in the admin
UI at `/admin/settings` (guarded by `settings:manage` — values only, keys are
code-defined): `reservations.ttl_minutes` (default 15), `returns.window_days`
(default 30, ≤ 0 disables the window), `inventory.partition_months` (−1 = off),
`checkout.guest_enabled`, `shipping.free_threshold`, `mail.provider`,
`search.provider`, `tax.provider`, `store.name`, `store.currency`. The same UI
manages shipping rules, weight-surcharge bands, tax rates, and warehouses
(create/edit/soft-disable — no deletes).

---

## 6. Operational invariants (what the database enforces)

* `inventory_balances.qty_on_hand − qty_reserved ≥ 0` — overselling is a constraint
  violation, not a bug report.
* Every `inventory_transactions` insert updates balances and FIFO cost layers in the
  same transaction, via triggers — no writer can skip it.
* Issues are stamped with their blended FIFO `unit_cost` at insert time; COGS for any
  period is `SUM(qty × unit_cost)` over OUT rows. Remnant write-offs (`ADJ`,
  `reason_code='remnant'`) are costed the same way and appear in shrinkage.
* `inventory_transactions`, `payment_events` (except processing marks), and `audit_log`
  reject UPDATE/DELETE at the trigger level. Corrections are new rows.
* In-transit stock is a real balance in a `transport`-type warehouse, moved by
  `stock_transfers` documents (carrier, manifest, billing per transfer).

---

## 7. Contributing & security

Setup, the checks CI runs, and the conventions that come up in review (append-only
migrations, audited writes, adapter boundaries) are in
[CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before starting anything large.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
Do not open a public issue.

Deployment-side security is covered where it belongs: per-IP rate limiting in §2,
TLS and `TRUST_PROXY` in §2–§3, and secret handling in §5.

---

## 8. License

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

Use it, run a shop on it, modify it. The one obligation that matters in practice:
**if you run a modified version as a network service, you must offer your users its
source.** Section 13 makes running it for the public equivalent to distributing it —
this is deliberate, so improvements made by shops running this code stay available to
the shops that come after.

To discharge that offer, set `STORE_INFO.sourceUrl` in
[`frontend/src/config/content.js`](frontend/src/config/content.js) to your repository
or a source archive; the storefront footer then links to it. Left empty, the footer
renders a plain credit and makes no offer — correct for an unmodified private trial,
not for a public deployment of modified code.
