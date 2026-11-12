# API Reference

The app has three kinds of API:

1. **Client data API** – the `Api` interface in `src/lib/types.ts`. Pages call only this.
2. **HTTP route** – `POST /api/register` (Next.js server).
3. **Database functions** – called through Supabase RPC. See [DATABASE.md](DATABASE.md).

## Result format

Every action that changes data returns the same shape:

```ts
type Result = { ok: boolean; code: string; message?: string };
```

- `ok` – success or failure.
- `code` – machine-readable outcome. The UI translates it with `tr()`
  (see [Result codes](#result-codes)).
- `message` – English text or raw database error, used only when no
  translation exists.

Read operations (`list…`, `search…`) return arrays and return `[]` on error.

---

## 1. Client data API (`api.*`)

Import with `import { api } from "@/lib/api"`. Both `supabaseApi` and `demoApi`
implement every method below.

### Auth (FR-04, FR-07)

| Method | Returns | Description |
|---|---|---|
| `getMe()` | `Me \| null` | Current member with `effective_status` (`Active` / `Expired` / `Suspended`). `null` if not logged in. |
| `register({ name, surname, phone, password, lang })` | `Result` | Validates input, creates the account, then logs in. Codes: `invalid_name`, `invalid_phone`, `weak_password`, `phone_taken`, `saved`. |
| `login(phone, password)` | `Result` | Phone is normalised first (`8 701…` → `+7701…`). Codes: `saved`, `bad_credentials`. |
| `logout()` | `void` | Ends the session. |
| `setLanguage(lang)` | `void` | Saves `kk` / `en` / `ru` on the member's account. |

### Public data

| Method | Returns | Description |
|---|---|---|
| `listBranches()` | `Branch[]` | All branches, sorted by name. |
| `listSessions({ includePast? })` | `SessionRow[]` | Schedule from view `v_sessions`, with `spots_taken`. Future sessions only unless `includePast: true` (admin). |
| `searchTrainers(q)` | `Trainer[]` | Trainers whose name contains `q`. Names only, no contacts. |
| `searchBranches(q)` | `Branch[]` | Branches whose name or address contains `q`. |

### Member

| Method | Returns | Description |
|---|---|---|
| `myBookings(memberId)` | `BookingRow[]` | All bookings of the member, newest first. |
| `searchBookings(q)` | `BookingRow[]` | Matches class, trainer, branch or member name. Members get only their own rows, admins get all. Max 50. |
| `book(sessionId)` | `Result` | Calls `book_session()`. See codes below. |
| `cancel(bookingId, acceptFee = false)` | `Result` | Calls `cancel_booking()`. Pass `acceptFee = true` after the user confirms a late cancellation. |

### Trainer

| Method | Returns | Description |
|---|---|---|
| `trainerRoster()` | `RosterRow[]` | Own sessions (from 12 h ago onward) with attendee names and statuses. |

### Trainer sign-up
| Method | Returns | Notes |
|---|---|---|
| `submitTrainerApplication(input, files)` | `Result` | Logged-in Member only. Uploads 1–5 certificates to Storage, then calls `submit_trainer_application`. Codes: `application_sent`, `application_exists`, `already_trainer`, `certificates_required`, `file_too_large`, `bad_file_type`, `upload_failed`, `invalid_email`. |
| `myTrainerApplication()` | `TrainerApplication \| null` | Latest own application. |
| `listTrainerApplications()` | `TrainerApplication[]` | Admin only; pending first. |
| `certificateUrl(path)` | `string \| null` | Signed link valid for 5 minutes (owner or admin). |
| `reviewTrainerApplication(id, approve, reason?)` | `Result` | Admin only. Codes: `application_approved`, `application_rejected`, `application_not_pending`, `application_not_found`, `already_trainer`. |

### Admin (FR-09)

`entity` is one of `"branches" | "rooms" | "trainers" | "classes" | "class_sessions" | "members"`.
The primary-key column for each entity is in `ENTITY_ID` (`types.ts`).

| Method | Returns | Description |
|---|---|---|
| `adminList(entity)` | `Row[]` | All rows of the table. |
| `adminInsert(entity, row)` | `Result` | `created` or an error code. |
| `adminUpdate(entity, id, row)` | `Result` | `updated`, `forbidden` (no row changed), or an error code. |
| `adminDelete(entity, id)` | `Result` | `deleted`, `in_use` (referenced elsewhere), `forbidden`. |
| `allBookings()` | `BookingRow[]` | Confirmed / attended bookings from 12 h ago onward – for check-in. |
| `listReaders()` | `Reader[]` | NFC readers with their branch. |
| `checkIn(bookingId, readerId)` | `Result` | Calls `check_in_booking()`. |

### Example

```tsx
const { tr } = useT();
const r = await api.book(session.session_id);
showToast(tr(r));                       // "Class is full" / "Сабақта бос орын жоқ" / "Мест нет"
if (r.code === "class_full" || r.code === "already_booked") openAlternatives(session);
```

---

## 2. HTTP route

### `POST /api/register`

Creates a confirmed Supabase Auth user. Runs on the server so the
service-role key stays secret.

**Request body**
```json
{ "name": "Aruzhan", "surname": "Bekova", "phone": "+77011234567", "password": "secret1", "lang": "kk" }
```

**Responses** (always HTTP 200, outcome in the body)

| Body | Meaning |
|---|---|
| `{ "ok": true, "code": "created" }` | Account created. The client then logs in. |
| `{ "ok": false, "code": "invalid_name" \| "invalid_phone" \| "weak_password" }` | Validation failed. |
| `{ "ok": false, "code": "phone_taken" }` | Phone already registered. |
| `{ "ok": false, "code": "rate_limited", "retry_after": 42 }` | Per-minute sign-up limit reached (`signup_rate_status()` / trigger). Try again after `retry_after` seconds. |
| `{ "ok": false, "code": "error", "fallback": true }` | Service-role key not configured. The client falls back to normal `signUp`. |
| `{ "ok": false, "code": "error", "message": "…" }` | Other Supabase error. |

---

## Result codes

Every code has a translation key `code_<code>` in `src/lib/i18n.ts` (kk / en / ru).

### Booking and cancellation
| Code | ok | When |
|---|---|---|
| `booked` | ✓ | Booking confirmed |
| `class_full` | ✗ | No places left (FR-01) |
| `already_booked` | ✗ | Member already holds this session (FR-02) |
| `not_signed_in` | ✗ | Not logged in |
| `session_not_found` | ✗ | Wrong session id |
| `class_started` | ✗ | Start time has passed |
| `membership_suspended` | ✗ | Admin suspended the membership |
| `membership_expired` | ✗ | Membership ends before the class date |
| `cancelled` | ✓ | Cancelled for free |
| `late_cancel_needs_confirm` | ✗ | Less than 3 h left – ask the user, then retry with `acceptFee = true` |
| `cancelled_fee_forfeited` | ✓ | Late cancellation done, fee forfeited (FR-06) |
| `booking_not_found` | ✗ | Not the member's booking, or wrong id |
| `not_cancellable` | ✗ | Status is not `Confirmed` |

### Check-in
| Code | ok | When |
|---|---|---|
| `checked_in` | ✓ | Log inserted, booking `Attended` |
| `admin_only` | ✗ | Caller is not Admin |
| `already_checked_in` | ✗ | Already `Attended` |
| `not_checkinable` | ✗ | Cancelled / No-show |
| `unknown_reader` | ✗ | Reader id not found |
| `wrong_branch_reader` | ✗ | Reader is in another branch than the session |

### Auth and profile
`saved`, `bad_credentials`, `phone_taken`, `invalid_phone`, `invalid_name`, `weak_password`, `bad_language`

### Admin CRUD (from `dbErrorCode()` in `supabaseApi.ts`)
| Code | Source |
|---|---|
| `created`, `updated`, `deleted` | Success |
| `capacity_exceeds_room` | Trigger: session capacity > room size |
| `capacity_below_bookings` | Trigger: capacity < places already booked |
| `room_overlap` / `trainer_overlap` | Postgres `23P01` – exclusion constraint |
| `in_use` | Postgres `23503` – row is referenced by a foreign key |
| `duplicate` | Postgres `23505` – unique constraint |
| `invalid_time` | `end_time <= start_time` |
| `trainer_needs_link` | Role `Trainer` without `trainer_id` |
| `required` | Postgres `23502` – NOT NULL |
| `invalid_value` | Bad format or failed CHECK |
| `forbidden` | Postgres `42501` or RLS blocked the row |
| `cannot_demote_self` | Admin tried to remove own Admin role |
| `cannot_change_login` | Attempt to change `auth_user_id` |
| `error` | Anything else |

## Adding a new action

1. Add the method to the `Api` interface in `types.ts`.
2. Implement it in **both** `supabaseApi.ts` and `demoApi.ts` (TypeScript will fail otherwise).
3. For a rule that must hold under concurrency, write a SQL function in
   `schema.sql` that returns `public.result(ok, code, message)`.
4. Add `code_<code>` to all three dictionaries in `i18n.ts`.

## No-show rule

A booking that is still `Confirmed` when its class has ended becomes `No-show`
and `fee_forfeited = true` (the member neither came nor cancelled).

- Database: `public.mark_no_shows()` (returns how many rows changed). The app
  calls it before every booking list (`myBookings`, `searchBookings`,
  `trainerRoster`, `allBookings`). With pg_cron it can also run on a schedule
  (see `supabase/migration_no_show.sql`).
- Demo mode: the same rule runs every time the store is loaded.
- Check-in is possible while the booking is `Confirmed`, i.e. until the class
  ends; after that the booking is `No-show` and `not_checkinable`.

## Attendance report and manual check-in

- `attendanceReport()` reads `v_attendance_report` (admin only): finished sessions,
  newest first, with `booked`, `attended`, `no_show`. The rate is computed in
  `src/lib/stats.ts` (`attendance / (attended + no_show)`); below 70 % it is shown in red.
- `manualCheckIn(bookingId)` calls `manual_check_in()`: Plan B when the NFC reader
  fails. Admin only, only after the class has started, for `Confirmed` or `No-show`
  bookings. Writes a `check_in_logs` row with `is_manual = true` and no reader, sets
  `Attended` and returns the forfeited fee. Codes: `checked_in_manual`,
  `already_checked_in`, `not_checkinable`, `class_not_started`, `booking_not_found`, `admin_only`.
- My Profile shows the member's own progress: classes attended, missed and the rate.
