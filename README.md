# Online Store

A generic online store: Express + PostgreSQL backend (plain SQL, no ORM) and a Vue 3 frontend.
Supports single items, items with option variants (color, quality, size), and goods sold by
length (feet/yards/meters), with multi-warehouse FIFO-costed inventory, reservations at
checkout, and an immutable inventory/payments audit trail.

The same codebase scales **down** to a single-maker shop doing a few orders a week and **up**
to multi-instance cloud deployments. The difference is configuration, not code.

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
Purchasing), **Admin** (Users, Roles, Settings), plus **Reports**:

* **Inventory** — multi-warehouse stock with FIFO cost layers; transfers move
  stock through an in-transit `transport` warehouse; purchase orders receive
  at line level and write costed IN ledger rows. Received stock fills
  backorders and sends back-in-stock notifications automatically (1-minute job).
* **Orders** — fulfillment with capture-on-first-ship and partial shipments,
  refunds (cumulative-guarded), and an RMA queue with a configurable return
  window (`returns.window_days`) and suggested-refund prefill.
* **Admin** — user management (staff filters, multi-role grants), a roles &
  permissions editor (guarded by `roles:manage`; `admin`/`customer` roles are
  locked), and store settings (§5). Endpoint permissions live in
  `backend/config/routePermissions.js`, a code-only map validated against the
  live router and the `permissions` table at boot — an unguarded endpoint or
  unknown permission code fails startup.
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

---

## 1. Local development

### Prerequisites

* Node.js 20+ (the job-queue dependency, pg-boss v10, requires it)
* A reachable PostgreSQL 13+ (15 recommended). Not bundled — point at any host you have,
  or run one with Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15`

### Setup

```bash
# Backend
cd backend
npm install
cp .env.example .env         # then edit: DB_*, JWT secrets, SMTP_*, ADMIN_EMAIL
npm run setup                # = npm run migrate (schema + seeds) + node db/bootstrap.js (initial admin)
npm run dev                  # API on http://localhost:3000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                  # UI on http://localhost:5173, proxies /api to :3000
```

Notes:

* For a local DB set `DB_SSL=false`. Auth is passwordless: the initial admin
  (`ADMIN_EMAIL`) logs in by requesting an emailed one-time code, so SMTP settings must
  point at something real — for development, [Mailpit](https://github.com/axllent/mailpit)
  or a Gmail app password both work.
* Migrations are ordinary `.sql` files in `backend/db/migrations/`, applied in filename
  order and tracked in `schema_migrations`. A fresh database is fully constructed and
  seeded (roles/permissions, units of measure, MAIN + TRANSIT warehouses, shipping rules)
  by `npm run migrate`.

### Demo: checkout with the fake payment provider

`PAYMENT_PROVIDER=fake` (the default) swaps Stripe for a local simulator that
drives the exact same webhook pipeline as production — no keys, no network.
With the API running:

```bash
# 1. Guest places an order (creates an implicit customer account)
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
cd backend && npm test
```

The suites are integration-style: they exercise the real DB triggers, reservation
functions, and the full route→controller→service path, so they need a **disposable**
database: create one, run `npm run migrate` against it, point `.env` at it. Ledger
rows are append-only by design; recreate the test DB rather than trying to clean it.
(Mail is forced to the `noop` adapter during tests.)

---

## 2. Small data center / on-prem (single shop)

Target: one app server + one DB server (or even one box), ~98% uptime, minimal moving parts.

**Topology**

* `web1`: Node API under systemd, nginx in front for TLS + static frontend files
* `db1`: PostgreSQL 15; only reachable from `web1` (firewall / private VLAN)
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
   WorkingDirectory=/opt/online-store/backend
   ExecStart=/usr/bin/node ./bin/www
   Restart=always
   User=store
   EnvironmentFile=/opt/online-store/backend/.env
   [Install]
   WantedBy=multi-user.target
   ```

5. Cron: only the backup needs external scheduling — background jobs
   (reservation sweeper, backorder fulfillment + back-in-stock notifications,
   search indexing, emails, fraud screening, scheduled reports, daily sales
   rollup, partition and refresh-token maintenance) run inside the API
   process via pg-boss by default:

   ```cron
   # nightly logical backup at 02:15 (see §4)
   15 2 * * * /opt/online-store/backend/db/backup.sh >> /var/log/store-backup.log 2>&1
   ```

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
| Images | Object storage (S3) + CDN instead of the local `uploads/` directory — required as soon as there are 2 API instances |
| Backups | RDS automated backups + snapshots for PITR, **plus** periodic `db/backup.sh` archives to S3 as a provider-independent escape hatch |
| Secrets | Inject env vars from your secret manager; never bake them into images |

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
