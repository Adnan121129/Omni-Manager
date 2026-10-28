# OmniManager API reference

Base path: `/api/`. All request and response bodies are JSON unless noted (file uploads use
`multipart/form-data`; PDFs, CSVs and downloads return files).

## Conventions

**Authentication.** Session cookies (`om_session`). Call `GET /api/auth/csrf/` once to receive the
`om_csrftoken` cookie, then send its value as the `X-CSRFToken` header on every `POST`, `PUT`,
`PATCH` and `DELETE`. The React app does this automatically.

**Workspace (tenant).** Every request runs in the user's *active workspace*, stored in the session and
re-validated against an active membership on each request. Switch with `POST /api/auth/switch-workspace/`.
Records from another workspace are indistinguishable from records that do not exist (`404`, or a
`400` field error when a foreign ID is submitted).

**Roles.** `owner`, `admin`, `project_manager`, `member`, `client`. In the tables below:

| Tag | Who |
|---|---|
| *any* | any active member of the workspace (including clients) |
| *staff* | owner, admin, project manager, member |
| *manager* | owner, admin, project manager (project managers can read projects they manage or belong to, but manage and approve only the projects they lead) |
| *admin* | owner, admin |
| *billing* | owner, or an admin with “can manage billing” (on by default) |
| *client* | portal contact (role `client`), limited to their own company |

**Financial visibility.** Rates, costs, margins, budgets, milestone amounts and change-request budget snapshots are
only included for users who can manage the project; project health shows others the budget signal without fee
percentages. Member rates and the workspace default rate are shown only to managers and billing users. Invoice and
payment data — including receivables in reports and invoice/payment entries in activity feeds — is for billing users
only, and activity metadata keeps money figures only for viewers who manage the entry's project. An admin promoted
or invited by someone without billing access does not get billing access.

**Pagination.** Most list endpoints return
`{"results": [...], "count", "page", "page_size", "total_pages"}`. Use `?page=` and `?page_size=` (max 200).
Most lists accept `?search=` and `?ordering=` (prefix `-` for descending). Short, bounded lists return a plain
JSON array instead: leads, the lead pipeline, labels, milestones, deliverables, project members, expense categories,
contract templates, comments, files, activity, client timelines, calendar events, notification preferences,
recurring-invoice history and all `/portal/*` lists.

**Errors.** Every error uses one envelope:

```json
{"error": {"code": "validation_error", "message": "Please correct the highlighted fields.", "fields": {"title": ["This field is required."]}}}
```

Some business-rule errors add a `details` object with context — e.g. `timer_running` (the running entry) and
`open_work` (what still blocks completing a project).

| Status | Meaning |
|---|---|
| 400 | Validation error or business rule (`code` explains, e.g. `nothing_to_invoice`, `invalid_status`) |
| 403 | `not_authenticated` when signed out; otherwise not allowed (including rules such as `self_approval`) |
| 404 | Not found **or** belongs to another workspace/client |
| 409 | Conflict, e.g. `timer_running`, `version_mismatch`, `already_generated`, `open_work` |
| 429 | Rate limited (auth, password reset, payments, webhooks) |
| 503 | Payment provider not configured (`provider_not_configured`, from checkout and webhook endpoints) |

**Money.** Amounts are decimal strings with two places (`"1250.00"`) plus a `currency`. Totals across
currencies are never summed; aggregate fields are lists of `{"currency", "amount"}`.

**Idempotency.** `POST /time-entries/` accepts `client_request_id`; `POST /timer/start/` accepts
`request_id`; `POST /invoices/generate/` accepts `idempotency_key` (or an `Idempotency-Key` header).
Repeating the same key returns the original record instead of creating another.

---

## Auth & account

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/auth/csrf/` | public | Sets the CSRF cookie |
| POST | `/auth/signup/` | public | `{full_name, email, password, organization_name, currency?, timezone?}` → session; creates a workspace with you as owner |
| POST | `/auth/login/` | public | `{email, password}` → session payload |
| POST | `/auth/logout/` | signed in | |
| GET / PATCH | `/auth/me/` | signed in | Session payload: `{user, workspaces, membership, organization, permissions}`; PATCH `{full_name, timezone}` |
| POST | `/auth/change-password/` | signed in | `{current_password, new_password}` |
| POST | `/auth/password-reset/` | public | `{email}`; always 200 (no account enumeration) |
| POST | `/auth/password-reset/confirm/` | public | `{uid, token, password}` |
| POST | `/auth/switch-workspace/` | signed in | `{organization_id}` |
| POST | `/auth/workspaces/` | signed in | `{name}` creates another workspace |
| GET / POST | `/auth/invitations/<token>/` | public | Inspect / accept an invitation `{full_name?, password?}` |

## Workspace & team

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / PATCH | `/workspace/` | staff / admin | Name, branding, currency, timezone, invoice numbering, tax, payment terms, partial payments |
| GET / POST / DELETE | `/workspace/logo/` | any / admin | Image upload (`file`) |
| GET / PUT | `/workspace/notification-preferences/` | any | List of `{kind, label, in_app, email}` |
| GET | `/team/members/` | staff | `?role=`, `?status=` |
| GET / PUT / PATCH | `/team/members/<id>/` | staff / admin | Role, title, capacity, working days, bill/cost rates, billing access (a client contact's company is set by the invitation) |
| POST | `/team/members/<id>/deactivate/`, `/reactivate/` | admin | The last owner cannot be removed; only owners deactivate or reactivate owners; a reactivation by someone without billing access does not restore billing access |
| GET / POST | `/team/invitations/` | admin (managers may invite `client` contacts) | `{email, role, client?}` (client required for role `client`); `?pending=1` |
| POST | `/team/invitations/<id>/revoke/` | admin | |
| GET | `/team/workload/` | manager | Capacity vs. tracked and estimated hours per person for the week containing `?start=` (default: this week); project managers see the people on projects they lead |

## Notifications, activity, comments, files, search

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/notifications/` | any | Includes `unread_count`; `?unread=1` |
| GET | `/notifications/<id>/` | any | Own notifications only |
| POST | `/notifications/<id>/read/`, `/notifications/read-all/` | any | |
| GET | `/activity/` | staff | `?project=`, `?client=`, `?target_type=&target_id=`, `?limit=` (max 100) |
| GET / POST | `/comments/?target=type:id` | staff | `{target, body, client_visible}`; targets: project, task, milestone, deliverable, changerequest, client, lead, document, expense. Documents follow the document scope (admins; PMs for their own documents and projects they lead). Only the project's manager may post `client_visible: true` |
| DELETE | `/comments/<id>/` | author or admin | |
| GET / POST | `/files/?target=type:id` | staff | Upload `multipart`: `target`, `file` (type-checked by content, size-limited), optional `client_visible` (the record's project manager only) |
| PATCH | `/files/<id>/` | the record's project manager (or admin) | `{client_visible}` shares a file with the client portal |
| DELETE | `/files/<id>/` | uploader, or whoever manages the record (project manager, admin; managers for client/lead files) | |
| GET | `/files/<id>/download/` | staff | Access is re-checked against the parent record |
| GET | `/search/?q=` | staff | Projects, tasks, clients, leads, documents, invoices you can see |
| GET | `/calendar/?start=&end=` | staff | Task due dates, milestones, deadlines, invoice due dates |

## CRM

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST | `/clients/` | manager | `?status=active|inactive|archived` |
| GET / PATCH / DELETE | `/clients/<id>/` | manager | Delete is refused when the client has projects, invoices or documents — archive instead |
| GET | `/clients/<id>/overview/` | manager | Projects, outstanding balance, contacts, recent activity |
| GET | `/clients/<id>/timeline/` | manager | Merged interactions, comments and activity |
| POST | `/clients/<id>/archive/`, `/restore/` | manager | |
| GET / POST | `/leads/` | manager | `?stage=` |
| GET | `/leads/pipeline/` | manager | Leads grouped by stage with values per currency |
| GET | `/leads/<id>/duplicate-check/` | manager | Existing clients with the same name or email |
| POST | `/leads/<id>/convert/` | manager | `{client?}` converts to a new or existing client; moves interactions |
| GET / POST / PATCH / DELETE | `/interactions/` | manager | Calls, meetings, emails, notes with optional follow-up |

## Projects & work

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / POST | `/projects/` | staff / manager | `?status=open|...`, `?client=`, `?manager=`, `?type=`; includes progress, health and (for managers) budget |
| GET / PATCH / DELETE | `/projects/<id>/` | staff / manager / admin | A project's client cannot be changed after creation. Projects with time, expenses or invoices cannot be deleted — complete or cancel them |
| GET / POST | `/projects/<id>/members/` | staff / manager | POST `{user, role?}` |
| DELETE | `/projects/<id>/members/<user_id>/` | manager | |
| GET | `/projects/<id>/health/` | staff | Explainable signals behind the health score (budget details for managers only) |
| POST | `/projects/<id>/complete/` | manager | With open tasks, milestones or pending deliverables it returns `409 open_work` listing them in `error.details` (the same data as `completion_blockers` on the project detail); `{force: true, reason}` closes anyway |
| POST | `/projects/<id>/reopen/` | manager | |
| GET / POST | `/tasks/` | staff | `?project=`, `?assignee=me|none|<id>`, `?status=open|...`, `?priority=`, `?label=`, `?milestone=`, `?due=overdue|...`, `?all=1` (unpaginated, for the board). An assignee must already be on the project (owners and admins always qualify) unless the project's manager assigns them; this also applies when a task moves to another project |
| GET / PATCH / DELETE | `/tasks/<id>/` | staff | Status changes respect dependencies; position is a float for drag-and-drop ordering |
| POST | `/tasks/<id>/dependencies/` | staff | `{blocked_by}`; cycles are rejected |
| DELETE | `/tasks/<id>/dependencies/<blocked_by_id>/` | staff | |
| CRUD | `/labels/` | staff / manager (read / write) | |
| CRUD | `/milestones/` | staff / manager (read / write) | `amount` makes a completed milestone invoiceable |
| POST | `/milestones/<id>/complete/`, `/reopen/` | manager | Invoiced milestones cannot be reopened |
| CRUD | `/deliverables/` | staff (project members) | |
| POST | `/deliverables/<id>/submit/`, `/withdraw/` | staff (project members) | Sends to / withdraws from client approval |
| CRUD | `/change-requests/` | staff (project members) | Drafts: `{project, title, description, estimated_hours, estimated_cost, revised_deadline}` |
| POST | `/change-requests/<id>/send/`, `/withdraw/` | manager | |
| POST | `/change-requests/<id>/record-decision/` | manager | `{decision: approved|rejected, comment}` for decisions received outside the portal |
| POST | `/change-requests/<id>/apply/` | manager | Adds the approved hours/cost/deadline to the project budget (once) |

## Time tracking & approvals

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/timer/` | staff | `{entry, server_now}` (`entry` is null when no timer runs) — compute elapsed time from `server_now`. Start, pause, resume and discard return the same shape; stop adds `stopped`/`discarded` |
| POST | `/timer/start/` | staff | `{project, task?, description?, billable?, request_id?, switch?}`; `409 timer_running` unless `switch: true` |
| POST | `/timer/pause/`, `/resume/`, `/stop/`, `/discard/` | staff | Server timestamps; a zero-length stop is discarded |
| PATCH | `/timer/current/` | staff | `{project?, task?, description?, billable?}` |
| GET / POST | `/time-entries/` | staff | `?scope=mine|team`, `?from=&to=`, `?status=`, `?project=`, `?user=`; list includes `totals`. Manual entry: `{project, task?, date, duration_seconds | started_at+ended_at, description?, billable?, client_request_id?}` |
| GET / PATCH / DELETE | `/time-entries/<id>/` | owner of entry | Only draft or rejected entries can change |
| POST | `/time-entries/submit/` | staff | `{ids}` or `{start, end}` → draft/rejected entries become `submitted` |
| POST | `/time-entries/<id>/reopen/` | manager | `{reason}` reopens approved time (audited; refused once invoiced) |
| GET | `/timesheets/week/?start=&user=` | staff | Week grid per project/task/day |
| GET | `/approvals/time/` | manager | `?status=submitted`, filters; `summary` grouped by person, project, client, task |
| POST | `/approvals/time/approve/` | manager | `{ids}`; you cannot approve your own time (owners excepted) |
| POST | `/approvals/time/reject/` | manager | `{ids, reason}` (reason required) |

## Expenses

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/expense-categories/` | staff | CRUD for admins |
| GET / POST | `/expenses/` | staff | `?scope=mine|team` (team: managers), `?status=`, `?project=`, `?billable=`; multipart with optional `receipt`. `amount` = internal cost; `billable` + `billable_amount` = chargeable to the client |
| GET | `/expenses/<id>/` | owner or manager | |
| PATCH / DELETE | `/expenses/<id>/` | owner of expense | Draft/rejected only |
| POST | `/expenses/<id>/submit/` | owner | |
| POST | `/expenses/<id>/approve/`, `/reject/` | manager | Reject needs `{reason}` |
| POST | `/expenses/<id>/reopen/` | manager | `{reason}`; refused once invoiced |
| GET | `/expenses/<id>/receipt/` | owner or manager | `?inline=1` to view |

## Invoices & payments

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/invoices/` | billing | `?status=` (incl. `overdue`), `?client=`, `?project=`, `?from=&to=`; includes `summary` per currency |
| POST | `/invoices/` | billing | Manual invoice: `{client, currency, lines: [{description, quantity, unit?, unit_price}], due_date?, notes?}` |
| GET | `/invoices/unbilled/?client=&from=&to=` | billing | Approved, uninvoiced billable time/expenses and completed milestones per project |
| POST | `/invoices/generate/` | billing | `{client, projects, include_time, include_expenses, milestones, date_from?, date_to?, grouping: task|person|project|entry, due_date?, notes?, idempotency_key?}` → draft. Each source record is linked to its invoice line, so it can never be billed twice |
| GET / PATCH / DELETE | `/invoices/<id>/` | billing | Includes lines, payments, credit notes. Edit/delete drafts only; deleting releases linked work |
| POST | `/invoices/<id>/lines/` | billing | Add a service line to a draft |
| PATCH / DELETE | `/invoices/<id>/lines/<line_id>/` | billing | Draft only; deleting a work line releases its time/expenses |
| POST | `/invoices/<id>/send/` | billing | `{send_email, recipients?, message?}`; allocates the number, locks the invoice, publishes it to the portal, emails the PDF |
| POST | `/invoices/<id>/void/` | billing | `{reason}`; refused when payments exist (reverse them first); releases linked work |
| POST | `/invoices/<id>/payments/` | billing | Record an offline payment `{amount, method: bank_transfer|cash|check|other, received_on? (YYYY-MM-DD), reference?, note?}` |
| POST | `/invoices/<id>/credit-notes/` | billing | `{amount, reason}` |
| GET | `/invoices/<id>/pdf/` | billing | |
| GET | `/payments/` | billing | |
| POST | `/payments/<id>/reverse/` | billing | `{reason}`; restores the balance |
| GET | `/payments/provider/` | staff | Active provider, test mode, configured or not |
| CRUD | `/recurring-invoices/` | billing | `{client, project?, name, frequency: weekly|monthly|quarterly|yearly, start_date, end_date?, currency, line_items, tax_rate, payment_terms_days, auto_send}` |
| GET | `/recurring-invoices/<id>/preview/` | billing | The next invoice as it would be generated |
| POST | `/recurring-invoices/<id>/generate-next/` | billing | Generate the due period now (`409 already_generated` if done) |
| GET | `/recurring-invoices/<id>/history/` | billing | Generated periods |

### Online payment flow

1. Client: `POST /portal/invoices/<id>/checkout/ {amount?}` → `{checkout_id, checkout_url}` (full balance by default;
   partial amounts only if the workspace allows them). Redirect the browser to `checkout_url`.
2. The provider (Stripe Checkout, or the local sandbox page `/pay/sandbox/<session>`) collects payment and returns to
   `/portal/invoices/<id>?checkout=<checkout_id>`.
3. The provider sends a signed webhook to `POST /payments/webhooks/<provider>/`. The signature is verified, the event
   is stored once (`provider` + `event_id` unique) and the payment is applied once (`provider` + `reference` unique).
4. The return page calls `GET /portal/checkouts/<checkout_id>/`, which **re-verifies the session with the provider**
   (it never trusts the redirect URL) and returns `{status, outcome, failure_reason, invoice}`.

| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/payments/webhooks/stripe/` | provider | `Stripe-Signature` header (STRIPE_WEBHOOK_SECRET) |
| POST | `/payments/webhooks/sandbox/` | provider | `X-Sandbox-Signature: t=<unix>,v1=<hmac-sha256>` (SANDBOX_WEBHOOK_SECRET), 5-minute tolerance |
| GET / POST | `/payments/sandbox/<session_id>/` | public (unguessable id) | Sandbox only. GET checkout details; POST `{card_number}` or `{action: "cancel"}`. Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` declined, `4000 0000 0000 9995` insufficient funds |

## Documents & e-signature

| Method | Path | Access | Notes |
|---|---|---|---|
| CRUD | `/contract-templates/` | manager | Markdown body with placeholders such as `{{client.name}}`, `{{project.name}}`, `{{project.deadline}}`, `{{pricing_table}}`, `{{total}}`, `{{scope}}`, `{{payment_terms}}`, `{{milestones}}`, `{{expires_at}}` |
| GET / POST | `/documents/` | manager | `{kind, title, client, project?, template?, body?, scope?, pricing_items?, payment_terms?, expires_at?}` |
| GET / PATCH / DELETE | `/documents/<id>/` | manager | Detail adds `versions`, `signatures`, `events`, `audit: {valid, broken_at}`, `portal_contacts`. Project managers can only attach a document to projects they manage |
| GET | `/documents/<id>/preview/` | manager | Rendered, sanitised HTML |
| POST | `/documents/<id>/send/` | manager | `{signer?}` freezes a version with a SHA-256 content hash and shares it in the portal |
| POST | `/documents/<id>/revise/` | manager | Back to draft; the unsigned sent version can no longer be signed |
| GET | `/documents/<id>/pdf/` | manager | Includes the signature certificate when signed |

Audit events (`created`, `sent`, `viewed`, `signed`, `declined`, `revised`, `expired`) form a hash chain: each event
stores the previous event's hash, so any edit or deletion is detected by `audit.valid = false`.

## Client portal (`role = client`)

| Method | Path | Notes |
|---|---|---|
| GET | `/portal/summary/` | Approval queue (documents to sign, deliverables, change requests, invoices to pay), outstanding balance per currency, project progress, shared activity |
| GET | `/portal/projects/`, `/portal/projects/<id>/` | Shared projects only; milestones, deliverables, change requests, shared files, activity |
| POST | `/portal/projects/<id>/files/` | Upload a file to the team |
| POST | `/portal/deliverables/<id>/approve/`, `/request-changes/` | `{comment}` (required when requesting changes) |
| POST | `/portal/change-requests/<id>/approve/`, `/reject/` | `{comment?}` |
| GET / POST | `/portal/comments/?target=type:id` | Client-visible conversation on a project, deliverable, change request or document |
| GET | `/portal/files/<id>/download/` | |
| GET | `/portal/documents/`, `/portal/documents/<id>/` | Viewing records a `viewed` audit event. Detail includes `html`, `version`, `content_hash`, `consent_text` |
| POST | `/portal/documents/<id>/sign/` | `{version, content_hash, signer_name, signer_title?, method: drawn|typed, signature_image? (PNG data URL), consent: true}`; `409 version_mismatch` if the document changed while open |
| POST | `/portal/documents/<id>/decline/` | `{reason}` |
| GET | `/portal/documents/<id>/pdf/` | |
| GET | `/portal/invoices/`, `/portal/invoices/<id>/`, `/portal/invoices/<id>/pdf/` | Sent invoices only |
| POST | `/portal/invoices/<id>/checkout/` | See the payment flow above |
| GET | `/portal/checkouts/<id>/` | Server-side verification of a checkout |
| GET | `/portal/payments/` | Payment history |

## Dashboard, reports & Revenue Leak Radar

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/dashboard/` | staff | Role-aware: everyone gets `my_work`, `projects`, `activity`; managers add `time`, `approvals`, `clients`, `team`; billing users add `finance` and `chart` |
| GET | `/reports/overview/?from=&to=` | manager | Project managers see the projects they lead; filters `project`, `client`, `user` narrow that scope and never widen it. Profitability per project/client, utilisation per person, time by week; receivables (collected, outstanding, aging) for billing users only |
| GET | `/reports/export/<name>/` | manager | CSV: `projects`, `clients`, `team`, `expenses`, `time`, `aging` (formula-injection safe); same `from`, `to`, `project`, `client`, `user` filters; `aging` needs billing access |
| GET | `/revenue-leak/` | manager | Alerts: unbilled approved time, unbilled expenses, uninvoiced completed milestones, billable time awaiting approval for more than 5 days, done tasks without time, budget and retainer overruns, estimate overruns, overdue and partially paid invoices. Each alert lists the records behind it, the amount and a suggested action |
