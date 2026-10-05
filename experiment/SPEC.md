# Medical Appointments & Clinical History — Fixed Specification

This document is the fixed input every generator run receives. It is
identical across all runs and configurations. It fixes the technology
stack, the functional requirements (RF-01..RF-27), the endpoint catalog
(EP-01..EP-20), the screens (SCR-01..SCR-08) and the deterministic seed.

The system: outpatient medical appointment scheduling and clinical
history registry, with four roles — patient, healthcare professional,
administrative staff, system administrator.

## Roles

| Role | Scope |
| --- | --- |
| `patient` | Own appointments and own clinical history only |
| `professional` | Agenda; clinical history of patients with an assigned appointment |
| `staff` | Scheduling data; never clinical content |
| `admin` | Users, roles, availability, audit log |

## Fixed technology stack

Non-negotiable. A run that deviates from this stack fails acceptance.

- Database: PostgreSQL 16, schema created only by versioned migrations (no ORM sync).
- Backend: TypeScript, NestJS, REST API.
- Frontend: TypeScript, React, single-page application.
- Tests: Vitest (unit), Playwright (end-to-end).
- Execution: Docker Compose, fully local, one command to operate.

Single language across all layers by design: one SonarQube profile and
one Semgrep ruleset apply to the whole system.

## Data layer (RF-01 .. RF-06)

**RF-01 — Entities.** Relational schema with: `usuario`, `rol`,
`paciente`, `profesional`, `disponibilidad`, `cita`, `encuentro`,
`adjunto`, `auditoria`.

**RF-02 — Migrations.** Versioned and reversible. The schema is never
created by ORM synchronization. Every migration has an up and a down.

**RF-03 — Declared integrity.** Constraints exist in the database, not
only in application code:

- Foreign keys on every relationship.
- NOT NULL on every required column.
- Partial unique index on `(profesional_id, franja_inicio)` for
  appointments not in state `cancelled` (one active booking per slot).
- CHECK constraint on `cita.estado IN ('scheduled','attended','cancelled','no_show')`.
- CHECK constraint on `encounter.version > 0`.

**RF-04 — Indexes.** On every column used for filtering or ordering in
the endpoint catalog (dates, professional, patient, estado).

**RF-05 — Deterministic seed.** Same users, roles, professionals and
availability in every run:

- Users (password via `SEED_PASSWORD`, default `Seed!Passw0rd`):
  `admin@seed.local` (admin), `staff@seed.local` (staff),
  `paciente1@seed.local` .. `paciente3@seed.local` (patients),
  `gomez@seed.local`, `lopez@seed.local` (professionals).
- Availability: weekdays 08:00–16:00, 30-minute slots, for the 14 days
  following deployment; `lopez` has no slots on Fridays.

**RF-06 — Append-only clinical data.** `encuentro` and `auditoria`
admit no physical delete and no destructive update. Every correction
inserts a new `encuentro` row with `version = previous + 1` referencing
the replaced row.

## Backend (RF-07 .. RF-17)

**RF-07 — Authentication.** OAuth 2.0 authorization code flow with
PKCE (S256). No other flow is accepted.

**RF-08 — Tokens.** Issue, refresh and revoke with explicit expiry:
access 15 min, refresh 8 h. Revocation is immediate (token unusable
after the call).

**RF-09 — Authorization.** Role- and scope-based, verified on the
server on every operation. Route guards plus per-resource ownership
checks; never only in the UI.

**RF-10 — Data isolation.**

- A patient reads only their own history and appointments.
- A professional reads only the history of patients with an assigned
  appointment (past or future).
- Staff reads scheduling data; any clinical content request is denied.
- Enforcement happens in queries and guards, not by hiding UI.

**RF-11 — Endpoint catalog.** Every endpoint below is implemented
exactly as specified. Validation schema rejects undeclared fields
(RF-12). All responses use a consistent error envelope
`{ "error": { "code", "message" } }`.

| ID | Verb & path | Caller | Request | Success / errors |
| --- | --- | --- | --- | --- |
| EP-01 | GET `/auth/authorize` | any | query: `client_id`, `redirect_uri`, `code_challenge`, `state` | 302 login/consent screen |
| EP-02 | POST `/auth/token` | any | code + `code_verifier` | 200 tokens / 400 bad verifier / 401 invalid code |
| EP-03 | POST `/auth/token/refresh` | any | refresh token | 200 tokens / 401 expired or revoked |
| EP-04 | POST `/auth/revoke` | any | token | 204 / 401 |
| EP-05 | GET `/me/appointments` | patient | — | 200 list / 401 |
| EP-06 | GET `/availability` | patient | query: `professionalId`, `from`, `to` | 200 slots / 422 invalid range |
| EP-07 | POST `/appointments` | patient | `{ professionalId, slotStart }` | 201 / 409 slot taken / 422 invalid |
| EP-08 | DELETE `/appointments/:id` | patient (own) | — | 204 / 403 not own / 404 |
| EP-09 | GET `/agenda` | professional | query: `from`, `to` | 200 grouped by day / 401 |
| EP-10 | GET `/appointments/:id` | patient (own) or assigned professional | — | 200 / 403 / 404 |
| EP-11 | POST `/appointments/:id/encounter` | assigned professional | `{ notes, diagnosis }` | 201 encounter / 403 not assigned / 404 |
| EP-12 | GET `/patients/:id/clinical-history` | patient (self) or assigned professional | — | 200 chronology / 403 |
| EP-13 | POST `/encounters/:id/attachments` | author professional | multipart file | 201 / 413 too large / 415 bad type / 422 |
| EP-14 | GET `/attachments/:id` | author or owning patient | — | 200 stream / 403 / 404 |
| EP-15 | GET `/admin/users` | admin | query: page | 200 paginated / 403 |
| EP-16 | POST `/admin/users` | admin | `{ email, roles }` | 201 / 409 exists / 422 |
| EP-17 | PATCH `/admin/users/:id/roles` | admin | `{ roles }` | 200 / 422 unknown role |
| EP-18 | PUT `/admin/professionals/:id/availability` | admin | `{ slots: [{ start, end }] }` | 200 replaces set / 422 overlap |
| EP-19 | GET `/admin/audit` | admin | query: `actor`, `action`, `from`, `to` | 200 paginated / 403 |
| EP-20 | GET `/health` | any | — | 200 `{ status: "ok" }` |

**RF-12 — Input validation.** Schema validation at the boundary for
every endpoint; undeclared fields are rejected with 422, never ignored.

**RF-13 — Transactional booking.** EP-07 runs inside a transaction with
concurrency control (row-level lock or serializable retry). Two
concurrent bookings for the same slot never both succeed: one gets 201,
the other 409.

**RF-14 — Rate limiting.** Auth endpoints: 5 req/min per IP. Booking
(EP-07): 10 req/min per user. Exceeded: 429 with `Retry-After`.

**RF-15 — Audit log.** Every write operation and every read of clinical
content records: actor id, action, resource type and id, timestamp.
Append-only (RF-06).

**RF-16 — Error handling.** No stack traces, SQL, or file system paths
in any error response, at any severity.

**RF-17 — Attachments.** Allowed types: PDF, JPEG, PNG. Max 5 MB per
file. Server-side filename sanitization. Storage outside any publicly
served directory; downloads only through EP-14 with permission checks.

## Frontend (RF-18 .. RF-24)

**RF-18 — OAuth client.** Full authorization-code + PKCE flow from the
SPA, including the redirect-back screen handling `code` and `state`.

**RF-19 — Screens.** Exactly these eight:

| ID | Screen |
| --- | --- |
| SCR-01 | Login and authorization return |
| SCR-02 | Patient portal: own appointments |
| SCR-03 | Availability search and booking |
| SCR-04 | Professional agenda, day and week views |
| SCR-05 | Appointment detail and encounter recording |
| SCR-06 | Patient clinical history: chronology with attachments |
| SCR-07 | Administration: availability, users, roles |
| SCR-08 | Audit log query |

**RF-20 — Protected routing.** Routes and visible composition depend on
the active session's role. Unauthenticated access to any SCR-02..08
redirects to SCR-01.

**RF-21 — Form validation.** Client-side validation plus display of
server error envelopes; client validation never replaces the server's.

**RF-22 — Safe rendering.** Clinical notes are free text; render without
ever injecting unsanitized HTML.

**RF-23 — Token policy.** Declared storage and refresh policy matching
RF-08 (access 15 min, proactive refresh, logout calls EP-04).

**RF-24 — View states.** Every API-consuming view has explicit loading,
error and empty states.

## Transversal (RF-25 .. RF-27)

**RF-25 — Test coverage.** Automated tests covering at minimum the
authorization logic (RF-09/RF-10) and the booking transaction (RF-13).
Unit (Vitest) plus the suite must be runnable headless.

**RF-26 — No secrets in the repository.** All configuration via
environment variables; no credentials, keys or tokens committed.

**RF-27 — One-command operation.** `docker compose up` (plus `.env`)
leaves the full system operational: database migrated and seeded,
backend and frontend reachable, Playwright suite executable against the
running stack. No manual steps.

## Delivery contract

- `docker compose up` starts: `db` (PostgreSQL 16), `backend` (NestJS),
  `frontend` (React SPA served statically), reachable at declared ports.
- Migrations and seed run automatically on backend start, idempotently.
- `SEED_PASSWORD` (default `Seed!Passw0rd`) seeds all users from RF-05.
- The Playwright suite runs with `npx playwright test` from the repo
  root against the running stack.
- Fixed local ports: PostgreSQL 5432, backend http://localhost:3000,
  frontend http://localhost:8080.
- Database defaults for local compose: `POSTGRES_USER=medapp`,
  `POSTGRES_PASSWORD=medapp`, `POSTGRES_DB=medapp`.
- The backend-served OAuth authorization login form (EP-01) uses
  `input[name="email"]`, `input[name="password"]` and a submit button
  (standard HTML form) so the flow is automatable end-to-end.

## Testability contract

The SPA exposes these stable `data-testid` attributes (the E2E suite
depends on them; they are part of the fixed spec like the stack):

- Auth (SCR-01): `login-email`, `login-password`, `login-submit`
- Navigation (visible per role, RF-20): `nav-bookings`, `nav-search`,
  `nav-agenda`, `nav-history`, `nav-admin`, `nav-audit`
- Availability search (SCR-03): `search-professional`, `search-from`,
  `search-to`, `search-submit`
- Booking: `slot-item` (one per available slot, with
  `data-slot-start` attribute), `book-submit`
- Appointments list: `appointment-item` (with `data-appointment-id`)
- Cancel: `cancel-appointment`
- Encounter (SCR-05): `encounter-notes`, `encounter-diagnosis`,
  `encounter-submit`
- History (SCR-06): `history-timeline`
- States (RF-24): `loading-indicator`, `error-banner`, `empty-state`
