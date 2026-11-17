# Test Report - Gym Booking System (PulseGym)

## 1. Scope

Automated tests for the application's business logic (the "backend" of this project). The app has no separate server: all rules live in `src/lib/demoApi.ts` (demo mode) and are mirrored in `supabase/schema.sql` (Supabase mode). The tests run against `demoApi.ts`, which implements the same `Api` interface and rules, so no database or network is needed.

**Tools:** Vitest + V8 coverage, Node.js 22. `localStorage` is replaced by an in-memory store (`tests/setup.ts`); every test starts from a fresh seeded database.

**Run:** `npm install` then `npm test` (or `npm run test:report` for coverage + JSON report).

## 2. Summary

| Run | Total | Passed | Failed |
|---|---|---|---|
| 1. First run (20 tests) | 20 | 19 | 1 (TC-20, BUG-01) |
| 2. After fixing BUG-01 (+ TC-21) | 21 | 21 | 0 |

## 3. Test cases

| ID | Area | Steps | Expected result | Run 1 | Run 2 |
|---|---|---|---|---|---|
| TC-01 | Registration | Register with valid name, phone `8 701 111 22 33`, password | `created`; user logged in as Member; phone normalised to `+77011112233` | PASS | PASS |
| TC-02 | Registration | Register with name `Ar1zhan` (digit) | `invalid_name` | PASS | PASS |
| TC-03 | Registration | Register with phone `12345` | `invalid_phone` | PASS | PASS |
| TC-04 | Registration | Register with 5-char password | `weak_password` | PASS | PASS |
| TC-05 | Registration | Register with an already used phone (other format) | `phone_taken` | PASS | PASS |
| TC-06 | Login | Wrong password, then correct password | `bad_credentials`, then `saved` + `getMe()` returns the member | PASS | PASS |
| TC-07 | Booking | Book a session while logged out | `not_signed_in` | PASS | PASS |
| TC-08 | Booking | Member books a future session | `booked`; `spots_taken` +1; booking status `Confirmed` | PASS | PASS |
| TC-09 | Booking | Book the same session twice | `already_booked` | PASS | PASS |
| TC-10 | Booking | Book a session with capacity 1 by two members | 2nd member gets `class_full`; `spots_taken` stays 1 | PASS | PASS |
| TC-11 | Booking | Admin suspends member, member books | `membership_suspended` | PASS | PASS |
| TC-12 | Booking | Admin sets expiry to yesterday, member books | `membership_expired`; `effective_status = Expired` | PASS | PASS |
| TC-13 | Cancelling | Cancel a booking more than 3 h before start | `cancelled`; `fee_forfeited = false` | PASS | PASS |
| TC-14 | Cancelling | Cancel a booking 1 h before start, without and with confirmation | `late_cancel_needs_confirm` (status unchanged), then `cancelled_fee_forfeited`; `fee_forfeited = true` | PASS | PASS |
| TC-15 | Cancelling | Cancel, then book the same session again | Seat is released; re-booking gives `booked`; one booking row | PASS | PASS |
| TC-16 | Access control | Member calls admin-only functions | `forbidden` / `admin_only` / empty lists | PASS | PASS |
| TC-17 | Admin rules | Create session overlapping in the same room; create session with capacity 999 | `room_overlap`; `capacity_exceeds_room` | PASS | PASS |
| TC-18 | Admin rules | Delete branch that still has rooms/sessions | `in_use`; branch still exists | PASS | PASS |
| TC-19 | Check-in | Check in with reader of the wrong branch, then correct reader, then again | `wrong_branch_reader`; `checked_in` (status `Attended`); `already_checked_in` | PASS | PASS |
| TC-20 | Roles | Admin gives a member the `Receptionist` role | `updated` | FAIL | PASS |
| TC-21 | Roles | Receptionist lists bookings and readers, checks a booking in; then tries admin actions | Front-desk functions work; `adminInsert` = `forbidden`, `adminList`/`attendanceReport` empty | - | PASS |

## 4. Coverage after the fix (files under test)

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `demoApi.ts` | 54.5% | 46.8% | 55.0% | 61.1% |
| `validate.ts` | 29.0% | 28.2% | 25.0% | 36.8% |
| `stats.ts` | 0% | 0% | 0% | 0% |
| **All** | **52.6%** | **44.4%** | **52.8%** | **59.2%** |

Not covered: trainer sign-up/applications, trainer roster, manual check-in, attendance report and some admin CRUD branches (see Next steps).

## 5. Defects found

### BUG-01 - Receptionist role is not supported by the backend (TC-20, FAIL in run 1) - FIXED

- **Severity:** High (the role is selectable in the admin panel and the `/receptionist` page exists, but nobody could ever become a Receptionist).
- **Cause 1 (roles):** `validate()` in `src/lib/demoApi.ts` allowed only `Member`, `Trainer`, `Admin`; `supabase/schema.sql` had `check (role in ('Member', 'Trainer', 'Admin'))`, and the column was `varchar(10)` while `Receptionist` has 12 characters (`value too long for type character varying(10)`).
- **Cause 2 (permissions):** `allBookings()`, `listReaders()`, `checkIn()`, `manualCheckIn()` (SQL: `v_bookings`, `v_readers`, `check_in_booking()`, `manual_check_in()`) checked only for Admin, so the reception page would be empty and check-in would return `admin_only`.
- **Cause 3 (navigation):** the header had no link to `/receptionist`.
- **Fix:** added `Receptionist` to the allowed roles; new helper `isStaff` (demo) / `is_staff()` (SQL) = Admin or Receptionist, used only for the four front-desk functions; header link for Receptionist; `role` column widened to `varchar(20)`; new `supabase/migration_receptionist.sql` for databases created from the old `schema.sql`. Everything else (admin panel, attendance report, member data) stays Admin only.
- **Verification:** TC-20 and new TC-21 pass. The SQL was also run on PostgreSQL 16 (with a stub of the Supabase `auth` schema): migration applied on top of the old schema, and a fresh install of the new `schema.sql`. A Receptionist can read `v_bookings` / `v_readers` and check in; cannot read `members`, `v_attendance_report` or change branches; a plain Member and an Admin behave as before.

## 6. Limitations

- Tests cover `demoApi.ts`; RLS policies in a real Supabase project and the `/api/register` route (rate limit) were not executed. The SQL for the Receptionist change was checked on local PostgreSQL only.
- Frontend tests are not included in this report.
- Time-dependent rules (3-hour cancellation window) are tested by creating sessions at fixed offsets from the current time.
