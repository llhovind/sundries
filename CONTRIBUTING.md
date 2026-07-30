# Contributing

Thanks for your interest. This is a solo-maintained project, so a short note up
front about what that means in practice: small, focused pull requests get looked
at; large unsolicited rewrites usually don't. **Open an issue before starting
anything substantial** so we can agree on the shape of it before you spend an
evening on it.

Security problems do **not** go in issues or pull requests — see
[SECURITY.md](SECURITY.md).

## Getting set up

§1 of the [README](README.md#1-local-development) covers prerequisites, the
bundled Compose stack (Postgres + Mailpit), and the demo catalog. The short
version:

```bash
docker compose up -d                 # Postgres :5432, Mailpit :1025/:8025
cd backend  && npm install && cp .env.example .env && npm run setup && npm run seed:demo
cd frontend && npm install
```

## Running the checks

These are exactly what CI runs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
Run them before opening a pull request:

```bash
cd backend  && npm test              # Jest + Supertest against a real Postgres
cd frontend && npx vitest run        # component tests
cd frontend && npm run build         # production build must succeed
cd frontend && npx playwright test   # e2e; boots the API and Vite itself
```

The backend suite talks to the database named in your `.env` and leaves rows
behind — point it at a scratch database, not one whose data you care about.

There is deliberately no linter. Match the style of the file you're editing:
4-space indent, `'use strict'` in backend modules, JSDoc on exported functions.

## Conventions that will come up in review

**Migrations are append-only.** They're plain `.sql` files in
`backend/db/migrations/`, applied in filename order and recorded in
`schema_migrations`. Add `NNN_short_name.sql` with the next number — never edit
a migration that has already been applied, because every existing deployment has
already run it and will not run it again.

**Writes to audited tables go through `withAudit`.** It attaches the actor, IP
and correlation ID to the row. A write that bypasses it is a privileged action
that leaves no trace, which is treated as a bug.

**Test names read `given [context] when [action] then [outcome]`**, and test
behaviour through the public surface — a route, a service contract — rather than
internals. Business logic in services gets unit tests; the
Route→Controller→Service→DB path gets integration tests.

**Logging is structured JSON via `common/logger.js`** and never carries PII.
CLI scripts under `backend/bin/` and `backend/db/` are exempt.

**External I/O is a replaceable adapter.** Mail, payments, search and image
storage each sit behind a registry (`services/*/index.js`) selected by an env
var and validated at startup in `common/config.js`. New integrations follow that
shape rather than being called directly from a controller. Anything new that
reads `process.env` gets documented in `backend/.env.example` and the README's
configuration table.

## Pull requests

* One logical change per PR, with a description of what and why.
* Say how you tested it — including anything you couldn't test.
* Update the README, `docs/API.md` (regenerate with `npm run docs:api`) and
  `.env.example` when your change touches them.

## Licensing

This project is licensed under **AGPL-3.0-or-later**. By contributing you agree
your contribution is licensed under those same terms. Note that §13 obliges
network-deployed modified versions to offer their source to users — if you
deploy a fork, set `STORE_INFO.sourceUrl` in
[`frontend/src/config/content.js`](frontend/src/config/content.js) to point at it.
