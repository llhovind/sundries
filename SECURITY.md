# Security Policy

## Supported versions

This project has not cut a tagged release yet. **`main` is the only supported
branch** — fixes land there, and there is no backporting to older commits.
Self-hosters should track `main`.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Public issues are
visible to everyone, including before a fix exists.

Report privately through GitHub:

**[→ Report a vulnerability](../../security/advisories/new)**

This opens a draft advisory visible only to you and the maintainers.

What helps most, roughly in order:

* The affected endpoint, file, or migration
* What an attacker gains — read another tenant's orders, escalate to a staff
  role, bypass the oversell guard, and so on
* Concrete reproduction steps: a `curl` against a local instance is ideal
* The commit SHA you tested against, and your Postgres major version

You can expect an acknowledgement within **7 days** and an assessment within
**30 days**. This is a solo-maintained project, not a vendor with an on-call
rotation — please size your expectations accordingly. If a report is valid and
you'd like credit, say so and you'll be named in the advisory.

## Scope

**In scope** — anything in this repository, particularly:

* Authentication and session handling (OTP login, refresh-token rotation)
* The permission model: route guards, role/permission checks, privilege escalation
* Tenant/customer data exposure through the API
* SQL injection, and any path that bypasses the database-level integrity rules
  (FIFO costing, reservation math, oversell guards, ledger immutability)
* Payment and webhook handling, including replay or ordering attacks
* The audit trail — anything that lets a privileged action go unrecorded

**Out of scope:**

* **Deployment-layer concerns the application deliberately delegates.** Per-IP
  rate limiting is the reverse proxy's or WAF's job, and TLS termination is the
  deployment's; see §2 of the [README](README.md). A report that the API ships
  no per-IP throttle is a documented design boundary, not a vulnerability.
* **Misconfiguration of a self-hosted instance** — secrets committed to your own
  fork, `COOKIE_SECURE=false` in production, `TRUST_PROXY` left unset behind a
  proxy. Startup config validation catches much of this; the rest is on the
  operator.
* **Untrusted content hosted on a sibling subdomain of the API.** CSRF defence
  here rests on two things: every authenticated route takes its identity from an
  `Authorization: Bearer` header rather than a cookie, and the one cookie that
  exists — the `httpOnly` refresh token, scoped to `/api/v1/auth` — is
  `SameSite=Strict`. `SameSite` is scoped to the registrable domain, not the
  origin, so content served from a sibling subdomain (`blog.example.com` against
  `api.example.com`) counts as same-site and *will* carry that cookie. The worst
  reachable outcome is a forced logout; a forced refresh leaks nothing, because
  the rotated cookie lands in the victim's own browser and the response body is
  unreadable cross-origin. Do not host attacker-influenced content beside the
  API. See [§ CSRF](#csrf) below.
* The `fake` payment provider. It exists for local demos and refuses to start in
  production by design.
* Known development-only dependency advisories (see below).

## Known accepted issues

### CSRF

CodeQL's `js/missing-token-validation` flags `cookieParser()` sitting in front
of state-changing handlers, and the repository carries a dismissal for it. There
is no CSRF token middleware, and that is deliberate — two properties make one
redundant:

* **Only two endpoints read a cookie at all**: `POST /api/v1/auth/refresh` and
  `POST /api/v1/auth/logout`. Every other authenticated route derives identity
  from an `Authorization: Bearer` header. A cross-origin form or image cannot set
  that header, and `fetch` doing so triggers a preflight — which fails, since the
  API mounts no CORS middleware. There is no ambient authority to abuse.
* **The refresh cookie is `SameSite=Strict`**, `httpOnly`, and path-scoped to
  `/api/v1/auth`, so browsers withhold it on cross-site requests entirely,
  including top-level form POSTs.

The residual same-site subdomain case is covered under **Out of scope** above.
Reports that the API "has no CSRF tokens" will be closed against this section; a
report showing a cookie-authenticated *state-changing* route, or a route that
accepts credentials outside the `Authorization` header, is very much in scope.

### Development-dependency advisories

`npm audit` reports advisories against **development** dependencies —
principally a `brace-expansion` denial-of-service reached through `jest`,
`nodemon`, and `@vue/test-utils`. These are knowingly accepted:

* They affect build and test tooling only. **Production dependencies are at zero
  advisories** (`npm audit --omit=dev` in both `backend/` and `frontend/`), and
  none of the affected packages ship in a deployed artifact.
* The only patched `brace-expansion` release changes its CommonJS export from a
  callable function to an object, so pinning it via `overrides` breaks
  `minimatch@3` at runtime and takes the toolchain down with it. The fix has to
  come from those packages upstream.

Please don't file these — but do file anything reachable from a running
deployment.

## Disclosure

Coordinated disclosure. Once a fix is on `main`, the advisory is published with
credit to the reporter. If a report goes unanswered past the windows above,
you're free to disclose publicly.
