# Working rules

These rules apply to every task in this workspace. `SPEC.md` says WHAT to
build; this file says HOW to work. When they conflict, `SPEC.md` wins.

## Repository layout

Create files only in this layout. Do not add other top-level folders.

```
/                         docker-compose.yml, .env.example, package.json,
                          playwright.config.ts, README.md
docs/                     architecture.md (entity model, endpoint-to-screen map)
backend/                  NestJS app + Dockerfile
  src/main.ts
  src/app.module.ts
  src/common/             error envelope filter, validation pipe, guards,
                          rate limiting, audit interceptor
  src/database/
    migrations/           versioned migrations, each with up and down
    seed/                 deterministic seed (RF-05), idempotent
  src/<module>/           one folder per domain module: auth, appointments,
                          availability, encounters, attachments, admin,
                          audit, health
  test/                   Vitest unit tests (*.spec.ts)
frontend/                 React + Vite SPA + Dockerfile (static build)
  src/api/                API client and error envelope handling
  src/auth/               OAuth PKCE client and token policy
  src/routes/             protected routing per role
  src/screens/            one file per screen, SCR-01 .. SCR-08
  src/components/         shared UI, including loading/error/empty states
e2e/                      Playwright tests, using the data-testid contract
```

## Build order

Work in this order. Do not start a step until the previous one works.

1. `docker-compose.yml` with `db`, `backend`, `frontend`; `.env.example`.
2. Backend skeleton with `GET /health` (EP-20) and the error envelope.
3. Migrations and seed; the backend runs them on start.
4. Authentication and tokens (EP-01..EP-04), then authorization guards.
5. The remaining endpoints, one module at a time.
6. Frontend: auth flow first, then the screens.
7. Playwright tests in `e2e/`.

## How to work

- Work in small steps. After each module, build it and run its tests.
  Never move on with a failing build or failing tests.
- Read a file before changing it. Edit existing files with `search_replace`;
  use `write_file` only for new files or full rewrites of small files.
- Write complete code. No stubs, no `TODO`, no placeholder endpoints, no
  commented-out code.
- Pin dependency versions in `package.json`. Never use `latest`. Add a
  dependency only when the code uses it.
- When a command fails, read its output and fix the cause. Do not repeat the
  same command unchanged.
- Never commit secrets. Configuration comes from environment variables, with
  defaults documented in `.env.example`.

## Commands

- Each `run_command` starts a new shell at the workspace root: `cd` does not
  persist. Chain it in the same command: `cd backend && npm test`.
- Run scripts from files. Inline shell scripts are denied: `bash -c`,
  heredocs (`<<EOF`), `$(...)`, backticks and `<(...)`.
- Recursive or forced `rm` (`rm -rf`) is denied. Delete single files.
- Long-running servers must not block: start the stack with
  `docker compose up -d --build`.

## What to test

Unit tests (Vitest, `backend/test/`), runnable headless with `npm test`:

- Authorization and data isolation per role (RF-09, RF-10): a patient cannot
  read another patient's data; staff cannot read clinical content; a
  professional only reads assigned patients.
- Booking transaction (RF-13): two concurrent bookings of the same slot give
  one 201 and one 409.
- Input validation (RF-12): undeclared fields are rejected with 422.
- Error handling (RF-16): responses never contain stack traces, SQL or paths.
- Tokens (RF-08): expired and revoked tokens are rejected.

End-to-end tests (Playwright, `e2e/`), run with `npx playwright test` from
the repository root against the running stack:

- Login for each role.
- A patient books and cancels an appointment.
- A professional records an encounter.
- A patient views their clinical history.

## Definition of done

The task is done only when all of these pass:

1. `docker compose up -d --build` starts every service.
2. `curl -sf http://localhost:3000/health` returns 200.
3. `cd backend && npm test` passes.
4. `cd frontend && npm run build` succeeds.
