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
* The `fake` payment provider. It exists for local demos and refuses to start in
  production by design.
* Known development-only dependency advisories (see below).

## Known accepted issues

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
