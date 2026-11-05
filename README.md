# PulseGym: Gym Booking System (MVP)

Next.js (App Router) + Supabase (Postgres + Auth). Deploys to Vercel.
Without Supabase keys it runs in **demo mode** (data saved in the browser), so you can try it immediately.

## Documentation
- [Architecture](docs/ARCHITECTURE.md) – layers, pages and roles, main flows, localisation, security
- [API reference](docs/API.md) – every `api.*` method, `POST /api/register`, all result codes
- [Database](docs/DATABASE.md) – tables, constraints, views, functions, triggers, RLS

## Project structure
```
src/app/            pages: / (schedule), /login, /profile, /search, /trainer, /admin
src/app/api/        server route: register
src/components/     Header, Modal, Toast, CrudSection, Providers (language + auth)
src/lib/            api.ts (mode switch), supabaseApi.ts, demoApi.ts, types.ts,
                    i18n.ts (kk/en/ru), validate.ts, format.ts
supabase/           schema.sql, seed.sql
docs/               technical documentation
```

## Requirements coverage (practice_10)

| Req | How it is implemented | Where |
|---|---|---|
| **FR-01** Reject when full | `book_session()` locks the session row, counts non-cancelled bookings, returns **"Class is full"**. Admin sets capacity in the admin panel. | `schema.sql`, `/` |
| **FR-02** No double booking | `UNIQUE (member_id, session_id)` + check in `book_session()` → **"You have already booked this class"** | `schema.sql` |
| **FR-03** Offer alternatives | On full / already booked, a dialog lists up to 3 upcoming sessions of the same class with free places, each with a **Book** button | `src/app/page.tsx` |
| **FR-04** Register / log in | Name + phone + password. Phone is normalised (`8 701…` → `+7701…`). Wrong password → **"Incorrect phone number or password"**. After registering the member is logged in and sent to the main page. | `/login`, `/api/register` |
| **FR-05** My Profile | Name, phone, membership status (Active / Expired / Suspended), expiry date, upcoming bookings, history | `/profile` |
| **FR-06** Cancellation rule | Free until 3 h before start. Later: warning + confirmation, booking marked `fee_forfeited`. The place is freed either way. | `cancel_booking()`, `/profile` |
| **FR-07** kk / en / ru | Language switcher in the header. Saved in the browser (survives reload) and on the account (`members.preferred_language`, applied at next login). All messages, including database errors, are translated. | `src/lib/i18n.ts` |
| **FR-08** Search | Search bar in the header: trainers (with upcoming sessions), branches, bookings. Members see only their own bookings, admins see all. No match → **"No results found"**. | `/search`, `v_bookings` |
| **FR-09** Admin panel | Create / view / update / delete sessions, class types, trainers, branches, rooms; manage members (role, status, expiry); NFC check-in | `/admin` |
| **FR-10** Roles | `members.role` = Member / Trainer / Admin. Pages redirect other roles to the main page; the database enforces the same rules (RLS policies, role checks in functions). Trainers see attendee names for their own classes only. | `useRequireRole`, `schema.sql` |
| **NFR-01** Never overbook | Row lock in `book_session()`; admin cannot set capacity above the room size or below places already booked | `schema.sql` |
| **NFR-02** Speed | Booking is one database call; indexes on `bookings.session_id`, `class_sessions.start_time`. Not load-tested. | |
| **NFR-03** Security | Supabase Auth stores passwords as bcrypt hashes (demo mode: salted PBKDF2). Admin data and actions are blocked in the database for non-admins. | |
| **NFR-04** Localisation | Kazakh and Russian dictionaries are typed against English, so the build fails if any UI string is missing | `i18n.ts` |

Class names, descriptions, branch and room names are **data**, shown as the admin typed them (not translated).

## Run locally
```bash
npm install
npm run dev          # http://localhost:3000 (demo mode)
```
Demo accounts (demo mode only): Admin `+7 700 000 0001` / `admin123`, Trainer `+7 700 000 0002` / `trainer123`. Register any phone to act as a member.

## Connect Supabase
1. Create a project at supabase.com.
2. SQL Editor: run `supabase/schema.sql`, then `supabase/seed.sql` (each once, on an empty project).
3. Project Settings → API: copy the Project URL, the anon / publishable key and the **service_role** key.
4. Copy `.env.example` to `.env.local` and fill in all three. The service_role key is used only by the server route `/api/register` and is never sent to the browser.
   - Without the service_role key, registration falls back to a normal sign-up. Then turn **Authentication → Providers → Email → Confirm email** OFF, otherwise new members can't log in.
5. `npm run dev`, register with your phone number, then make yourself admin (SQL Editor):
   ```sql
   update public.members set role = 'Admin' where phone_number = '+77011234567';
   ```
   After that, give other people Admin / Trainer roles in **Admin panel → Members** (a Trainer must be linked to a trainer profile).

**How phone login works:** Supabase Auth needs an email, so each phone is mapped to an internal address like `77011234567@phone.pulsegym.app` that never receives mail. If Supabase rejects that domain, set `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` to a domain you control. Password reset by SMS is not included.

## Deploy to Vercel
1. Push this folder to a GitHub repo.
2. vercel.com → Add New → Project → import the repo (framework: Next.js).
3. Settings → Environment Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Deploy.

## Corrections made to the earlier spec (Task 09)
| Issue in the doc | What the MVP does |
|---|---|
| "Five tables", but the fixes add TRAINERS, CLASSES, READERS, ROOMS | 9 tables: members, branches, rooms, trainers, classes, class_sessions, bookings, readers, check_in_logs |
| Member name is `fullname`, `full_name`, or `member_name` + `member_surname` | `member_name` + `member_surname` |
| CLASS_SESSIONS shows no FK, but `branch_id` is one | FKs to branches, classes, trainers, rooms |
| Problem 4 says duplicates aren't prevented, but the rules table already has `UNIQUE(member_id, session_id)` | Kept; re-booking after a cancel re-activates the cancelled row |
| `membership_status = 'Expired'` goes stale | Only `Active` / `Suspended` stored; Expired is computed from `membership_expiry` |
| `branch_id` and `room_id` on a session could disagree | Composite FK `(room_id, branch_id)` → rooms |
| Room / trainer double-booking (Problem 5) | Exclusion constraints reject overlapping sessions |
| `check_in_method` depends on the reader | Moved to READERS (linked to a branch); a reader can only check in sessions of its branch |
| Front-desk role vs. FR-10's three roles | Check-in is done by the Admin role |
| `phone_number` optional, but FR-04 logs in by phone | `phone_number NOT NULL UNIQUE` |

## Design notes
- The `v_*` views run with the owner's rights and filter rows themselves (by `auth.uid()` / role). Supabase's linter may flag them as "security definer views"; that is intentional here.
- Booking fee: there are no payments in the MVP. A late cancellation is recorded as `fee_forfeited = true` for billing to use later.

## Not in the MVP
- Payments, SMS verification / password reset, automatic No-show marking, real NFC hardware
- New members get 30 days of membership (`handle_new_user` in `schema.sql`); change to your rule
