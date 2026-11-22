# CLAUDE.md — PulseGym (gym booking system)

## Purpose
University team project (KBTU, Basics of Information Systems). A web app for booking
group fitness classes across several gym branches. Members register by phone, browse
the schedule and book places. The system enforces capacity, membership and cancellation
rules. Roles: Member, Trainer, Receptionist, Admin. UI in Kazakh, English and Russian.
Keep solutions simple and suitable for a course project. Avoid over-engineering.

## Architecture
- **Next.js 16 (App Router) + React 19 + TypeScript (strict)**. No separate backend server.
- **Supabase** (PostgreSQL + Auth + PostgREST) is the real backend. Business rules live in
  SQL functions (`book_session`, `cancel_booking`, `check_in_booking`, ...) and Row Level
  Security in `supabase/schema.sql`.
- **Two API implementations of one interface** (`Api` in `src/lib/types.ts`):
  - `src/lib/supabaseApi.ts`: calls Supabase (real mode)
  - `src/lib/demoApi.ts`: the same rules in TypeScript, data in localStorage (demo mode)
  - `src/lib/api.ts` picks one: Supabase if `NEXT_PUBLIC_SUPABASE_*` env vars are set, otherwise demo.
- Server-only code: `src/app/api/register/route.ts`, `src/app/api/reset-password/route.ts`
  (these use the service-role key, which must never reach the browser).

### Repository map
| Path | Contents |
|---|---|
| `src/app/` | Pages: `/` (schedule), `login`, `verify`, `reset`, `profile`, `search`, `trainer`, `receptionist`, `admin`; `api/` routes |
| `src/components/` | `Header`, `Providers` (auth + language), `Modal`, `Toast`, `CrudSection`, `TrainerFields` |
| `src/lib/` | `types.ts`, `api.ts`, `demoApi.ts`, `supabaseApi.ts`, `validate.ts`, `format.ts`, `stats.ts`, `i18n.ts`, `useSessionState.ts` |
| `supabase/` | `schema.sql`, `seed.sql`, `migration_*.sql` |
| `tests/` | `setup.ts` (in-memory localStorage), `backend/gym.test.ts`, `backend/helpers.ts` |
| `docs/` | `API.md`, `ARCHITECTURE.md`, `DATABASE.md` |

## Setup
- Node.js 20+. Install with `npm ci` (uses the exact versions in `package-lock.json`).
- No env file is needed: without Supabase variables the app runs in **demo mode**.
  Demo accounts are listed in `README.md`.
- Supabase mode: copy `.env.example` to `.env.local` and fill it in yourself.
  **Never** read, print, commit or paste the contents of `.env.local` / `.env`.

## Safe commands
| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:3000 |
| `npx tsc --noEmit` | Type check (no output = no errors) |
| `npm test` | Run all Vitest tests (demo mode, no network/database) |
| `npx vitest run -t "TC-10"` | Run one test by name |
| `npx vitest run --coverage` | Tests with a coverage report |
| `npm run build` | Production build into `.next/` (local only, also type-checks) |
| `npm start` | Serve the local build |

There is no lint script or ESLint config yet. Don't add one without asking.

## Not allowed without explicit approval from the user
- **Secrets:** don't read or output `.env*.local`, `.env`, service-role keys or tokens. Don't hardcode keys.
- **Deployments:** don't push to `main` (every push to `main` deploys to Vercel automatically),
  run `vercel` commands, or change Vercel/Supabase project settings.
- **Destructive actions:** no `rm -rf`, `git reset --hard`, `git push --force`, `git clean`,
  deleting migrations, or running SQL against a real Supabase database (`drop`, `truncate`, `delete`, ...).
- **Dependencies:** no `npm install <pkg>`, `npm update`, `npm audit fix`, or edits to
  `package.json` / `package-lock.json` unless the user has reviewed and approved the change.
- Work on a feature branch (`feature/...` or `bugfix/...`) and open a pull request. Commit only when asked.

## Coding conventions
- TypeScript strict mode. Use the `@/` import alias for `src/`. 2-space indent, double quotes, semicolons.
- Pages that use state or the API are client components (`"use client"`).
- API functions return `Result` (`{ ok, code, message? }`) with snake_case result codes
  (`booked`, `class_full`, `already_booked`, ...). Don't throw for expected business errors.
- **Every result code and every UI string must exist in `src/lib/i18n.ts` in `en`, `kk` and `ru`.**
  `en` defines the keys, and the build fails if a translation is missing.
- **Business rule changes must be made in both places:** `src/lib/demoApi.ts` **and** the SQL
  (`supabase/schema.sql` plus a new `supabase/migration_<name>.sql` for existing databases).
  Never edit an old migration. Add a new one.
- Security rules belong in the database (RLS / SQL functions). Hiding something in the UI is not enough.
- Validation helpers go in `src/lib/validate.ts`; date/time and rule constants go in `src/lib/format.ts`.
- Keep comments short and explain *why*. Reference requirement IDs (FR-xx / NFR-xx) where relevant.
- Plain CSS in `src/app/globals.css`. No new UI or CSS libraries.

## Test expectations
- Before saying a change is finished, run `npx tsc --noEmit`, then `npm test`, then `npm run build`. All must pass.
- Tests run against `demoApi` only. Each test starts from a freshly seeded store (`tests/setup.ts`).
- Every new or changed business rule needs a test in `tests/backend/gym.test.ts`:
  - continue the numbering (next ID after the last `TC-xx`);
  - check the result `code`, not only `ok`;
  - use the helpers in `tests/backend/helpers.ts`.
- For time-based rules, create sessions at offsets from now (`H`, `DAY`) or use `vi.useFakeTimers()`.
  Don't depend on seed dates.
- SQL/RLS changes are not covered by automated tests. Say so, and describe what should be checked manually.
- Don't delete or weaken existing tests to make them pass.
- Update `TEST_REPORT.md` when tests are added or results change.