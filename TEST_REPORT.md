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
| 3. "Right now in the club" added (+ TC-33…TC-36), whole suite | 56 | 56 | 0 |
| 4. Membership renewal added (+ TC-37…TC-38), whole suite | 58 | 58 | 0 |
| 5. "Going with a friend" added (+ TC-39…TC-45), whole suite | 65 | 65 | 0 |

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

### "Right now in the club" (run 3)

| ID | Area | Steps | Expected result | Result |
|---|---|---|---|---|
| TC-33 | Club presence | Reception marks a new member as arrived; the member checks the widget, then makes the profile public | `visit_started`; counted in `present`; private → not in `people`; logged out → no names; after `profile_public_on` shown as `Test U.` / `TU` / 1 visit | PASS |
| TC-34 | Club presence | Member tries to mark a visit; reception: unknown branch, admin account, second arrival, search, "left" twice; suspended and expired member | `staff_only`, `branch_not_found`, `member_not_found`, `already_in_club`, found by name and phone, `visit_ended` then `visit_not_open`, `visit_membership_suspended`, `visit_membership_expired` | PASS |
| TC-35 | Club load | `clubLoad()` / `loadSegments()` at the thresholds; seeded branches; time moved 3 h forward | 40 % → medium, 75 % → high; Downtown 12/30 medium, Riverside 2/40 low; after 3 h nobody counted and a new arrival is accepted | PASS |
| TC-36 | Public profile | Read Aruzhan's profile logged out / logged in; new member private → public → private; toggle when logged out | `null` when logged out or private; visits 4, classes 10, favourite Yoga, in Downtown now; `profile_public_off`; `not_signed_in` | PASS |

### Membership renewal (run 4)

| ID | Area | Steps | Expected result | Result |
|---|---|---|---|---|
| TC-37 | Membership renewal | Active member renews for 3 months; admin expires membership; member renews for 1 month (month-end clamping) then 6 months | Active extends from current `membership_expiry`; expired starts from today (`2026-01-31` + 1 mo → `2026-02-28`, leap year `2028-02-29`) and restores `effective_status = Active` | PASS |
| TC-38 | Membership renewal guards | Call `renewMembership` while logged out, as Admin, as Receptionist, with invalid plan (`2`), and as Suspended member | `not_signed_in`, `staff_cannot_renew`, `invalid_plan`, `membership_suspended` (expiry unchanged) | PASS |

SQL (`migration_club_presence.sql`) was applied to PostgreSQL 16 with a stub of the Supabase `auth` schema on top of `schema.sql` and checked by hand: all result codes above, public/private names in `club_now()` for a member and for a logged-out user, `public_profile()` of a private member is `null`, a visit older than 3 h stops counting and is closed on the next arrival. RLS and grants in a real Supabase project were not executed.

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

### Going with a friend (run 5) — `tests/backend/buddy.test.ts`

| ID | Area | Steps | Expected result | Result |
|---|---|---|---|---|
| TC-39 | Invite | Book a class (capacity 2), invite with bad phone / own phone / staff phone / foreign booking, then a friend (`8 701 …` format), then a second friend; a third member books | `invalid_phone`, `buddy_self`, `buddy_staff`, `booking_not_found`; `buddy_invited` with `expires_at` ≈ now + 2 h; `buddy_already_invited`; `spots_taken` = 2; third member gets `class_full` | PASS |
| TC-40 | Accept | Another member tries to see / accept the invitation; the friend accepts twice | Not visible, `invite_not_found`; `buddy_accepted` then `invite_not_pending`; friend's booking `Confirmed`; `spots_taken` stays 2; inviter sees `Accepted` + friend's short name | PASS |
| TC-41 | Accept | Invite a number with no account; that person registers and accepts | Invitation appears as `received`; `buddy_accepted` | PASS |
| TC-42 | Expiry | Hold makes the class full, someone joins the waitlist; time moves 2 h forward | Hold ends: waitlisted member is booked; friend sees `Expired`, accept → `invite_not_pending`; inviting again → `class_full` | PASS |
| TC-43 | Release | Class in 40 min: hold ends at the start. Decline, re-invite, withdraw twice, re-invite, inviter cancels | `expires_at` = start; place freed each time (`spots_taken` back to 1, then 0); `buddy_withdrawn` then `invite_not_pending`; invitation `Cancelled` | PASS |
| TC-44 | Bonus | Inviter and friend checked in by NFC (one after the other), a third member alone | No bonus after the first check-in; after both: `buddy_bonus` +15 once each (balance and level 25); member who came alone has 10 | PASS |
| TC-45 | Limits | Friend already booked; same number invited by two members; 4 holds at once; logged out | `buddy_already_booked`, `buddy_friend_invited`, 4th hold `buddy_limit`, `not_signed_in` | PASS |

SQL (`supabase/migration_buddy_invite.sql`) is not covered by Vitest. It was run on PostgreSQL 16 with all
earlier migrations applied and checked with a scenario script: hold counted in `v_sessions`, `book_session`
refuses the held place, decline → waitlisted member booked by `promote_waitlist`, accept → booking, NFC
check-in of both → `buddy_bonus` +15 each (not after only one), expiry by time + `expire_buddy_invites()`,
inviter cancels → invitation `Cancelled`, `anon` and `authenticated` can't read `buddy_invites` directly.
Running the migration twice is harmless; the rollback file restores the previous function and view
definitions exactly (compared with `pg_get_functiondef`).
