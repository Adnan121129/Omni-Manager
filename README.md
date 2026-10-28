# OmniManager

A multi-tenant workspace for agencies, consultants and service businesses: projects and tasks, CRM,
time tracking and approvals, budgets and expenses, proposals and contracts with electronic acceptance,
invoicing with online payments, a branded client portal, and reporting that points at revenue you are
about to lose.

- **Backend:** Django 5.2 + Django REST Framework, PostgreSQL
- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4, Radix-based UI components (shadcn/ui style),
  Lucide icons, React Router, TanStack Query, React Hook Form + Zod, Recharts
- **Tests:** pytest (backend), Vitest + Testing Library (frontend), Playwright (end-to-end)

API reference: [docs/API.md](docs/API.md)

---

## Quick start

Prerequisites: Python 3.12+, Node.js 20.19+ or 22.12+, PostgreSQL 14+, and Pango for PDF rendering
(`apt install libpango-1.0-0 libpangoft2-1.0-0` on Debian/Ubuntu, `brew install pango` on macOS).

```bash
cp .env.example .env            # then set DATABASE_URL, DJANGO_SECRET_KEY and SANDBOX_WEBHOOK_SECRET
make setup                      # Python venv in backend/.venv + pip install + npm ci
make db                         # create the database named in DATABASE_URL (role needs CREATEDB)
make migrate
make seed                       # demo workspaces and accounts (development only)
make dev                        # API on :8000 and the web app on http://localhost:5173
```

Without `make`:

```bash
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
(cd frontend && npm ci)
cd backend && .venv/bin/python scripts/create_db.py && .venv/bin/python manage.py migrate \
  && .venv/bin/python manage.py seed_demo --reset && .venv/bin/python manage.py runserver
cd frontend && npm run dev      # in a second terminal
```

The Vite dev server proxies `/api` to Django, so the app and API share one origin (session cookies and
CSRF work without CORS). Point it elsewhere with `VITE_API_PROXY_TARGET`.

### Demo accounts

`make seed` creates two isolated workspaces with realistic, date-relative data. Every demo account uses
the password printed by the command (default `Demo!2345`, override with `DEMO_PASSWORD`).

| Email | Role |
|---|---|
| olivia@demo.omnimanager.test | Owner of *Northwind Studio* (everything, including billing) |
| marcus@demo.omnimanager.test | Administrator |
| priya@demo.omnimanager.test | Project manager |
| sam@demo.omnimanager.test | Team member (has a running timer) |
| jordan@acme.demo.omnimanager.test | Client portal — Acme Corporation |
| lena@globex.demo.omnimanager.test | Client portal — Globex |
| owner@contoso.demo.omnimanager.test | Owner of *Contoso Labs*, a separate workspace (for isolation checks) |

**Demo vs. production data.** Demo workspaces are flagged `is_demo` (the sidebar says so), demo users use the
reserved `.test` domain, and `seed_demo --reset` only ever deletes flagged demo data. The command refuses to
run when `DJANGO_DEBUG` is off unless you pass `--allow-non-debug`. A fresh workspace created through sign-up
contains no sample records — only default expense categories, labels and two editable contract templates.

### Commands

| Task | Command |
|---|---|
| Install | `make setup` |
| Create database | `make db` |
| Migrate | `make migrate` |
| Seed demo data | `make seed` |
| Run API + web | `make dev` (or `make api` / `make web`) |
| Scheduled jobs | `make jobs` — or run `python manage.py run_jobs` from cron (daily is enough; hourly is fine) |
| Backend tests | `make test-backend` |
| Frontend typecheck + unit tests | `make test-frontend` |
| End-to-end tests | `make e2e` (first time: `cd frontend && npx playwright install chromium`) |
| Production build of the SPA | `make build` → `frontend/dist` |
| Sanity checks | `make check` (Django checks + no missing migrations) |

---

## Features

**Workspaces, team and permissions.** Sign-up creates a workspace; users can belong to several and switch
between them. Roles: owner, admin, project manager, member, client. Invitations by email (hashed, expiring
tokens), deactivation, per-person capacity, working days, bill and cost rates, and a separate “can manage
billing” grant. All permissions are enforced by the API; the UI only mirrors them.

**CRM and clients.** Leads with a pipeline, interaction log with follow-ups, duplicate detection and conversion
to clients (interactions carry over). Client records with overview, outstanding balance, timeline, archive/restore.

**Projects and tasks.** Time & materials, fixed-price and monthly retainer projects; members; milestones;
deliverables with client approval; tasks and subtasks with priorities, labels, estimates, due dates and
blocking dependencies (cycles rejected), shown as a list or a drag-and-drop Kanban board; a task drawer
with comments, files and time; calendar; command search (⌘K).

**Project health and budgets.** Fee and hour budgets (monthly for retainers), estimated expenses, alerts at
75/90/100 % sent once per threshold, an explainable health score (each signal is listed), estimated margin
from cost rates, and an estimate-at-completion projection labelled as an estimate.

**Scope change requests.** Draft → sent to the client → approved/rejected in the portal (or recorded by the
manager) → applied, which adds the hours, fee and deadline to the project budget exactly once.

**Time tracking.** One global timer per user with server timestamps (start, pause, resume, stop, discard,
switch); manual entries in `1:30`, `1.5h` or `90m`; day/week/month views; weekly timesheet grid.
Draft → submitted → approved/rejected (reason required, no self-approval except owners); approved time is
locked and can only be reopened with an audited reason, never once invoiced.

**Expenses.** Internal cost vs. chargeable amount (markup shown), receipts, categories, approval, and
budget impact.

**Invoicing.** Invoices from approved billable time, approved chargeable expenses and completed milestones,
grouped by task, person, project or entry. Each source record is linked to the invoice line that billed it
(enforced by database constraints), so work can never be invoiced twice; deleting a draft or voiding an invoice
releases it. Manual invoices, sequential numbering per workspace, discounts and tax, PDF, email delivery,
offline payments, payment reversal, credit notes, overdue tracking, and recurring invoices (weekly to yearly,
catch-up safe, optional auto-send). All money uses `Decimal` with half-up rounding; currencies are never mixed.

**Online payments.** Hosted checkout with server-side verification and idempotent, signature-verified
webhooks. Ships with a local sandbox provider and a Stripe provider (see *Integrations*).

**Documents and e-signature.** Templates with placeholders, pricing tables, scope and terms; sending freezes a
version and its SHA-256 hash; the client reviews and signs in the portal (drawn or typed signature, explicit
consent, name, IP, user agent, time and the exact version hash are recorded) or declines with a reason;
expiry dates; revisions invalidate unsigned versions; a hash-chained audit trail that detects tampering;
signed PDFs.

**Client portal.** Branded with the workspace colour/logo: an approvals queue (deliverables, change requests,
signatures, payments), project progress and milestones, shared files and uploads, conversations, documents,
invoices with online payment and payment history. Clients only ever see their own company's shared records.

**Reports and the Revenue Leak Radar.** Profitability by project and client, utilisation by person, time by
week, receivables aging, CSV exports. The radar lists approved-but-uninvoiced time and expenses, uninvoiced
completed milestones, billable time waiting for approval for more than five days, completed tasks without tracked time, budget
and retainer overruns, estimate overruns, and overdue or partially paid invoices — each with the records
behind it and a one-click next step (for example *Create invoice draft*).

**Notifications and activity.** In-app notifications with per-event email preferences (de-duplicated),
activity feeds per project and client, and comments with client-visible sharing.

**Interface.** Light theme with a dark navy sidebar and indigo accent, a full dark theme, responsive layouts
down to phone width, keyboard-accessible components, and loading, empty and error states throughout.

---

## Architecture

```
backend/
  config/              settings (environment-driven), URLs
  apps/accounts/       users, workspaces (Organization), memberships, roles, invitations, auth API
  apps/core/           tenancy base model, permissions, errors, activity, notifications, comments,
                       files, email, PDF helpers, management commands (seed_demo, run_jobs)
  apps/crm/            clients, leads, interactions
  apps/projects/       projects, members, milestones, deliverables, tasks, dependencies,
                       change requests, metrics (budget/health), access rules
  apps/timetracking/   timer, time entries, timesheets, approvals
  apps/finance/        expenses, invoices, lines, payments, credit notes, recurring invoices,
                       payment providers (payments/), PDFs
  apps/documents/      templates, documents, versions, signatures, hash-chained events, e-sign boundary
  apps/portal/         client portal API (client-safe serialisation only)
  apps/reports/        dashboard, reports, CSV export, Revenue Leak Radar, workload, calendar, search
  scripts/             create_db.py, e2e_server.py
  templates/           email (text) and PDF (HTML) templates
  tests/               pytest suite
frontend/
  src/components/      ui/ (design system), common/ (states, status badges, collaboration), layout/
  src/features/        reusable feature modules (tasks, projects, time, clients)
  src/pages/           workspace screens
  src/portal/          client portal
  src/hooks/, src/lib/ session, timer, data hooks, API client, formatting
  e2e/                 Playwright workflows
docs/API.md            API reference
```

**Tenancy.** Every business record carries an `organization` foreign key. The active workspace lives in the
session and is re-validated against an active membership on every request; querysets are always filtered by
it. Foreign keys submitted by clients are resolved only within the active workspace (and, for project-scoped
data, only within projects the user may see), so an ID from another tenant behaves exactly like one that
does not exist. Client contacts are additionally scoped to their own client record and to items explicitly
shared with the portal.

**Integrity.** Business rules live in service modules (`services.py`, `invoicing.py`, …) and run inside
database transactions with row locks where races matter (timer start, approvals, invoice generation and
numbering, payments, signing). Database constraints back the important invariants: one running timer per user,
unique invoice numbers and idempotency keys per workspace, unique webhook events and provider payment
references, one recurring run per period, and invoice links only on approved billable work.

**Frontend.** A single-page app with route-level code splitting. Server state goes through TanStack Query with
targeted invalidation; forms use React Hook Form with Zod schemas, and server field errors are mapped back to
fields. The timer is computed from server time (clock-skew corrected) so it stays correct across tabs and
devices. `localStorage` is used only for UI preferences such as the theme.

---

## Integrations

| Integration | Default (works offline) | Production option |
|---|---|---|
| Payments | **Sandbox** simulator: a hosted checkout page at `/pay/sandbox/<session>` with test cards; it signs a webhook with `SANDBOX_WEBHOOK_SECRET` and delivers it through the same verification and processing code a real provider uses | **Stripe** Checkout: set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and point a Stripe webhook (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`) at `/api/payments/webhooks/stripe/` |
| Email | File backend: messages are written to `backend/var/mail/` | SMTP via the `EMAIL_*` variables |
| E-signature | Built-in simple electronic signature with consent capture and hash-chained audit trail | `ESignProvider` boundary in `apps/documents/esign.py` for a dedicated provider |
| PDFs | WeasyPrint (local) | same |
| Files | Private local storage (`backend/var/media`), served only through permission-checked endpoints | another Django storage backend via `FILE_STORAGE_BACKEND` (install its package, e.g. django-storages, and add its settings to `config/settings.py`) |
| Scheduled jobs | `python manage.py run_jobs` (cron) or `run_jobs --loop 300` | same, or your scheduler of choice |

The payment and e-signature integrations report whether they are configured (`GET /api/payments/provider/`,
the settings page and the portal pay panel); when they are not, the UI says so instead of offering a button
that cannot work. The Stripe provider is covered by tests that mock Stripe's API and verify Stripe webhook
signatures; try it against your own Stripe test-mode account before going live.

---

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Backend (pytest) | `make test-backend` | Auth and CSRF, workspace and client isolation, roles, timer races and idempotency, approvals, budgets, invoicing (no double billing, rounding, numbering, voids, credit notes), payments (signature verification, replayed webhooks, partial payments, reversals, Stripe with mocks), recurring catch-up, documents (placeholders, sanitisation, signing, tampering detection, expiry), portal, reports and radar. One test runs in autocommit mode, like the real server, to catch locking outside transactions |
| Frontend (Vitest) | `make test-frontend` | Formatting and money/date helpers, duration parsing, timer maths with clock skew, API client errors and CSRF, route guards and role-based navigation, login validation, portal payment validation and checkout verification, client decision dialogs, status badges |
| End-to-end (Playwright) | `make e2e` | 1) task → time → approval → invoice → portal → declined then successful sandbox payment → balance verified; 2) contract → send → client signs (drawn) → audit chain verified; 3) budget → time + chargeable expense → 75 %/100 % warnings and notifications → radar flags unbilled work → invoice draft from the radar → radar updated; 4) workspace isolation and 5) client isolation through the UI and API |

The end-to-end suite never touches your development database. Playwright starts the API through
`backend/scripts/e2e_server.py` (port 8001), which creates `<your database>_e2e` (or `E2E_DATABASE_URL`), migrates
and reseeds it and generates a fresh webhook secret, and starts Vite on port 5174 (override with `E2E_API_PORT` /
`E2E_WEB_PORT`). Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium binary instead of
`npx playwright install`.

Current suite size: 136 backend tests, 54 frontend unit tests and 5 end-to-end workflows.

---

## Security notes

- No credentials in the repository: secrets come from the environment (`.env` is git-ignored). With
  `DJANGO_DEBUG=false` the app refuses to start without `DJANGO_SECRET_KEY`.
- Session authentication with CSRF protection on every unsafe request (including login and sign-up); secure,
  HTTP-only session cookies and HSTS/SSL redirect options in production.
- Financial data is role-scoped on the server: rates, budgets, margins and milestone fees only reach people who
  manage the project; invoices, payments and receivables only reach billing users (including what activity feeds,
  dashboards and reports reveal); only a project's manager can publish files or comments to the client portal.
  `backend/tests/test_role_exposure.py` and `test_isolation.py` pin these rules down.
- Rate limits on authentication, password reset, payments and webhooks.
- Uploads are validated by extension, content signature and size, stored outside any public path and served
  with `Content-Disposition` and `nosniff`.
- Markdown and user HTML are sanitised (nh3); CSV exports neutralise spreadsheet formulas; emails are plain text.
- Logs redact passwords, secrets, tokens, API keys, authorization headers and card numbers. Only the last four digits of sandbox test cards
  are stored; real card data never reaches the server.

---

## Known limitations

- **E-signature** is a simple electronic signature with an auditable trail, not a qualified/advanced signature
  (eIDAS QES, etc.). Use the `ESignProvider` boundary to plug in a dedicated provider where that is required.
- **Stripe** is implemented and tested with mocks, but untested against a live Stripe account here. Refunds
  are recorded as payment reversals in OmniManager; they are not pushed to the provider.
- **Background work** runs from a management command (cron), not a queue; emails are sent synchronously after
  the transaction commits.
- **Notifications** update by polling (every 45 s); there is no websocket push.
- **Rate limiting and caching** use Django's in-process cache by default; configure a shared cache (e.g.
  Redis) when running several processes.
- **Taxes** are a single rate per invoice; no tax-inclusive pricing, multi-rate or regional tax engines.
- **Currencies** are kept separate everywhere; there is no exchange-rate conversion or consolidated
  reporting across currencies.
- **Files** use local storage by default; object storage needs a storage backend configured.
- **No back-office admin UI**: the Django admin is intentionally not enabled; workspace data is managed through
  the app and API (and `manage.py shell` for operators).
- **Authentication** is email and password only — no SSO, social login or two-factor authentication yet.
- **Localisation**: the interface is English-only; dates and amounts follow the browser locale and the
  user's or workspace's time zone.
- **Deployment** is intentionally not included: no containers or hosting configuration. Serve Django with a
  WSGI server behind HTTPS and the built SPA (`frontend/dist`) from the same origin, routing `/api` to Django.
