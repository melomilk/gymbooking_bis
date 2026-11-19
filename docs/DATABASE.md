# Database

PostgreSQL on Supabase. Source of truth: [`supabase/schema.sql`](../supabase/schema.sql).
Demo data: [`supabase/seed.sql`](../supabase/seed.sql) (2 branches, 3 rooms,
3 trainers, 5 classes, 2 NFC readers, 6 sessions per day for the next 7 days).

## Entity–relationship overview

```
branches 1──M rooms
branches 1──M class_sessions M──1 classes
branches 1──M readers          class_sessions M──1 trainers
rooms    1──M class_sessions   class_sessions M──1 rooms (room must be in the same branch)
trainers 1──0..1 members (a Trainer account is linked to one trainer profile)

members  1──M bookings M──1 class_sessions     (members ↔ sessions is M:N through bookings)
bookings 1──0..1 check_in_logs M──1 readers
```

## Tables

### `branches`
| Column | Type | Rules |
|---|---|---|
| `branch_id` | bigint | PK, identity |
| `branch_name` | varchar(100) | NOT NULL |
| `address` | varchar(255) | NOT NULL |
| `phone_number` | varchar(20) | NOT NULL, UNIQUE |

### `rooms`
| Column | Type | Rules |
|---|---|---|
| `room_id` | bigint | PK, identity |
| `branch_id` | bigint | FK → branches, NOT NULL |
| `room_name` | varchar(50) | NOT NULL, UNIQUE per branch |
| `max_capacity` | int | `> 0` |

`UNIQUE (room_id, branch_id)` exists so `class_sessions` can reference both
columns and a session can never point to a room in another branch.

### `trainers`
| Column | Type | Rules |
|---|---|---|
| `trainer_id` | bigint | PK, identity |
| `trainer_name` | varchar(100) | NOT NULL |
| `phone`, `email` | varchar | optional, visible to admins only |

### `classes`
| Column | Type | Rules |
|---|---|---|
| `class_id` | bigint | PK, identity |
| `class_name` | varchar(50) | NOT NULL, UNIQUE |
| `description` | text | optional |
| `duration_min` | int | `> 0` |

### `members`
| Column | Type | Rules |
|---|---|---|
| `member_id` | bigint | PK, identity |
| `auth_user_id` | uuid | FK → `auth.users`, UNIQUE; cannot be changed from the app |
| `member_name`, `member_surname` | varchar(100) | NOT NULL, not blank |
| `membership_status` | varchar(10) | `Active` / `Suspended` (manual flag) |
| `membership_expiry` | date | NOT NULL; new members get today + 30 days |
| `phone_number` | varchar(20) | NOT NULL, UNIQUE – used for login |
| `role` | varchar(10) | `Member` / `Trainer` / `Admin`, default `Member` |
| `trainer_id` | bigint | FK → trainers, UNIQUE; required when role = `Trainer` |
| `preferred_language` | varchar(2) | `kk` / `en` / `ru`, default `en` |

`Expired` is **not stored**. It is computed in `v_me.effective_status` from
`membership_expiry`, so it can never go stale.

### `class_sessions`
| Column | Type | Rules |
|---|---|---|
| `session_id` | bigint | PK, identity |
| `class_id` | bigint | FK → classes |
| `trainer_id` | bigint | FK → trainers |
| `branch_id`, `room_id` | bigint | composite FK → rooms(room_id, branch_id) |
| `start_time`, `end_time` | timestamptz | `end_time > start_time` |
| `capacity` | int | `> 0`, ≤ room size, ≥ places already booked (trigger) |

Exclusion constraints (need extension `btree_gist`):
- `no_room_overlap` – one room cannot host two sessions at overlapping times.
- `no_trainer_overlap` – one trainer cannot lead two sessions at overlapping times.

Index: `start_time`.

### `bookings`
| Column | Type | Rules |
|---|---|---|
| `booking_id` | bigint | PK, identity |
| `member_id` | bigint | FK → members, NOT NULL |
| `session_id` | bigint | FK → class_sessions, NOT NULL |
| `booking_status` | varchar(10) | `Confirmed` / `Cancelled` / `Attended` / `No-show` |
| `booking_time` | timestamptz | default `now()` |
| `cancelled_at` | timestamptz | set on cancel |
| `fee_forfeited` | boolean | `true` after a late cancellation (FR-06) or a no-show; `false` again when a no-show is excused |
| `excuse_reason` | varchar(10) | `Illness` / `Family` / `Work` / `Other`; set when an admin excused a no-show (migration_excuse_no_show.sql) |
| `excuse_note` | varchar(500) | admin's comment; required for `Other` |
| `excuse_document` | text | path of the PDF medical note in the private `excuse-documents` bucket; required for `Illness` |
| `excused_at` | timestamptz | when the no-show was excused |

`UNIQUE (member_id, session_id)` – FR-02. Re-booking after a cancellation
re-uses the same row. Index: `session_id`.

### `readers`
| Column | Type | Rules |
|---|---|---|
| `reader_id` | varchar(20) | PK, e.g. `NFC-DT-01` |
| `branch_id` | bigint | FK → branches |
| `check_in_method` | varchar(10) | default `NFC` |
| `location_note` | varchar(100) | optional |

### `check_in_logs`
| Column | Type | Rules |
|---|---|---|
| `check_in_id` | bigint | PK, identity |
| `booking_id` | bigint | FK → bookings, UNIQUE (one check-in per booking) |
| `check_in_time` | timestamptz | default `now()` |
| `reader_id` | varchar(20) | FK → readers; empty only for a manual check-in |
| `is_manual` | boolean | default `false`; `true` when an admin marked it by hand (NFC failed). `CHECK (is_manual OR reader_id IS NOT NULL)` |

## Views

- `v_attendance_report` (admin only): per session `booked`, `attended`, `no_show`. Attendance rate = attended / (attended + no_show); cancelled bookings don't count.

Views run with the owner's rights and filter rows themselves.

| View | Who can read | Contents |
|---|---|---|
| `v_sessions` | everyone | Schedule with class, trainer, branch, room names and `spots_taken` (non-cancelled bookings). No contacts or member data. |
| `v_trainers` | everyone | `trainer_id`, `trainer_name` only |
| `v_me` | logged in | Own member row + `effective_status` |
| `v_bookings` | logged in | Bookings joined with session details. Members: own rows. Admins: all rows. |
| `v_trainer_roster` | Trainer | Own sessions with attendee names and statuses |
| `v_readers` | Admin | Readers with branch name |

## Functions

All business functions are `SECURITY DEFINER`, run as one transaction and
return `jsonb` built by `public.result(ok, code, message)`.

### `book_session(p_session_id bigint) → jsonb`
FR-01, FR-02, NFR-01.
1. Find the caller's member row → else `not_signed_in`.
2. `SELECT … FOR UPDATE` on the session – concurrent bookings for the same
   session wait here, so two people cannot take the last place.
3. Reject if started (`class_started`), suspended (`membership_suspended`), or
   membership ends before the class date (`membership_expired`).
4. Reject if an active booking exists (`already_booked`).
5. Count non-cancelled bookings; if `>= capacity` → `class_full`.
6. Insert, or re-activate an old cancelled row → `booked`.

### `cancel_booking(p_booking_id bigint, p_accept_fee boolean = false) → jsonb`
FR-06.
- Only the owner can cancel, only `Confirmed` bookings, only before the start.
- Less than 3 hours before start and `p_accept_fee = false` → `late_cancel_needs_confirm` (nothing changes).
- Otherwise sets `Cancelled`, `cancelled_at = now()`, `fee_forfeited` = late? →
  `cancelled` or `cancelled_fee_forfeited`. The place is freed in both cases.

### `check_in_booking(p_booking_id bigint, p_reader_id text) → jsonb`
Admin only. Checks status and that the reader belongs to the session's branch,
then inserts into `check_in_logs` and sets the booking to `Attended`. If either
step fails, both are rolled back.

### `set_my_language(p_lang text) → jsonb`
Saves `kk` / `en` / `ru` for the caller.

### Helpers
- `my_role()` – caller's role or `Anonymous`.
- `is_admin()` – `my_role() = 'Admin'`. Used by RLS policies and views.

## Triggers

| Trigger | Table | Purpose |
|---|---|---|
| `trg_session_capacity` | class_sessions (before insert/update) | `capacity_exceeds_room`, `capacity_below_bookings` |
| `trg_protect_admin` | members (before update) | `cannot_demote_self`, `cannot_change_login` |
| `on_auth_user_created` | auth.users (after insert) | Creates the `members` row from registration metadata |

## Row Level Security

RLS is enabled on every table.

| Table | Anonymous / Member | Admin |
|---|---|---|
| branches | read | full CRUD |
| rooms, trainers, classes, class_sessions | via views only | full CRUD |
| members | own row via `v_me` | read, update |
| bookings | via `v_bookings` and functions only | via `v_bookings` and functions |
| readers | – | read |
| check_in_logs | – | via `check_in_booking()` |

Members never write to `bookings` directly – only through `book_session()` and
`cancel_booking()`. This guarantees every booking passes the capacity and
duplicate checks.

## Setup

```text
Supabase → SQL Editor
1. Run supabase/schema.sql   (once, on an empty project)
2. Run supabase/seed.sql     (once)
3. Register in the app, then:
   update public.members set role = 'Admin' where phone_number = '+77011234567';
```


## Trainer sign-up (`migration_trainer_signup.sql`)

### `trainer_applications`
| Column | Type | Rules |
|---|---|---|
| `application_id` | bigint | PK, identity |
| `member_id` | bigint | FK → members (cascade) |
| `email` | varchar(150) | NOT NULL, email format |
| `specialization` | varchar(200) | NOT NULL |
| `experience_years` | int | 0–60 |
| `bio` | text | optional, ≤ 2000 chars |
| `certificates` | jsonb | array of `{path, name}`, 1–5 items, every `path` in the applicant's own Storage folder |
| `status` | varchar(10) | `Pending` / `Approved` / `Rejected` |
| `reject_reason`, `reviewed_at`, `reviewed_by`, `trainer_id` | | filled by the admin's decision |

A partial unique index allows one open (`Pending` or `Approved`) application per member;
after a rejection a new one may be sent. RLS is on and table privileges are revoked:
members read their own rows through `v_trainer_applications` (admins see all), and write only
through `submit_trainer_application(...)`. `review_trainer_application(id, approve, reason)` is
admin-only; approve inserts a `trainers` row and sets `members.role = 'Trainer'`, `trainer_id`.

Certificates live in the private Storage bucket `trainer-certificates` (5 MB, PDF/JPG/PNG) under
`<auth uid>/…`. Policies: a user may upload only into their own folder; read access is the owner or an admin.


## Sign-up rate limit (`migration_signup_rate_limit.sql`)

- `signup_rate_limit` — one settings row: `enabled`, `max_per_minute` (default 150).
- `signup_events` — one timestamp per created account (no personal data); rows older than 1 h are
  deleted by the trigger.
- `enforce_signup_rate_limit()` — `BEFORE INSERT` trigger on `auth.users`. Takes a transaction advisory
  lock, counts events of the last 60 s and raises `signup_rate_limited` at the limit; otherwise logs an
  event. A sign-up that fails later (e.g. duplicate phone) rolls its event back.
- `signup_rate_status()` → `{"allowed": bool, "retry_after": seconds}`; callable by `anon`, used by the
  app before creating an account. Both tables are closed to `anon` / `authenticated`.


## Pulse points and rewards (`migration_points_rewards.sql`)

- `points_ledger` — append-only; balance = `sum(delta)`. Reasons: `attended` (+10), `streak_bonus` (+20 every 4th week
  in a row), `review` (+5), `no_show` (−5), `no_show_reversed` (+5), `review_removed` (−5), `redeem` (−cost),
  `redeem_refund` (+cost). Unique per (booking, reason) and per (member, week) for streak bonuses, so nothing is counted twice.
- Trigger `trg_points_on_booking_status` (AFTER UPDATE OF booking_status on `bookings`) writes the visit entries, so
  `check_in_booking`, `manual_check_in`, `mark_no_shows` and `excuse_no_show` are unchanged.
- `rewards` — catalog (`kind`: free_class, late_cancel_pass, membership_days, merch; `cost`; `stock` null = unlimited;
  `extend_days`; `active`). Admin edits it in the admin panel (RLS like the other catalog tables).
- `reward_redemptions` — one exchange: `code` (PG-XXXXXX), `status` Active / Used / Cancelled.
- Trigger `trg_use_late_cancel_pass` (BEFORE UPDATE) turns `fee_forfeited` off on a late cancellation when the member
  has an active pass and marks the pass Used.
- Functions: `my_points()`, `points_leaderboard(limit)`, `redeem_reward(id)` (locks the member row, so parallel
  exchanges can't spend the same points), `use_redemption(id)` (staff), `cancel_redemption(id)` (owner or staff, refund).
- Views: `v_my_points_history` (own), `v_redemptions` (own; staff see all).

## Waitlist (`migration_waitlist.sql`)

- `waitlist` — `status` Waiting / Promoted / Left / Expired, `promoted_auto`, `status_reason`
  (membership, time_conflict, session_cancelled). One Waiting entry per member and class.
- `promote_waitlist(session)` locks the session row (like `book_session`) and books people in queue order while there
  are free places; a member whose membership doesn't cover the date or who has another class at that time is skipped.
- Deferred constraint triggers call it at the end of the transaction when a booking is cancelled or the capacity is
  raised (deferred, so `cancel_session` — which cancels the bookings before marking the class — doesn't promote anyone
  into a cancelled class; the queue is expired instead).
- `join_waitlist(session)` / `leave_waitlist(session)`; the queue closes 3 hours before the start; at most 5 classes at a time.
- Views: `v_waitlist_counts` (public), `v_my_waitlist` (own, with the place in the queue).

## Reviews (`migration_reviews.sql`)

- `class_reviews` — one per booking; rating 1–5, comment ≤ 500.
- `submit_review(booking, rating, comment)`: only the member's own `Attended` booking, from the end of the class for 14
  days; editable; the first review gives +5 points (once per class). `delete_review(id)`: admin, takes the 5 points back.
- Views: `v_trainer_ratings` (public average), `v_my_reviews`, `v_reviews` (trainer: own classes without names; admin: all with names).
