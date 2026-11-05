# Architecture

PulseGym is a single Next.js application. There is no separate backend server:
the browser talks to Supabase (PostgreSQL + Auth) directly, and all business
rules that must never be broken (capacity, double booking, roles) are enforced
**inside the database**. The only server-side code in Next.js is the
registration route.

```
┌──────────────────────────── Browser ────────────────────────────┐
│  Pages (src/app)          Components (src/components)           │
│  /  /login  /profile      Header · Modal · Toast · CrudSection  │
│  /search /trainer /admin  Providers (language + auth context)   │
│                │                                                 │
│                ▼                                                 │
│   src/lib/api.ts  ──  chooses one implementation of `Api`        │
│        │                                   │                     │
│        ▼                                   ▼                     │
│   supabaseApi.ts                      demoApi.ts                 │
│   (real database)                     (localStorage, same rules) │
└────────┼─────────────────────────────────────────────────────────┘
         │ HTTPS (supabase-js)            ▲
         ▼                                │ POST /api/register
┌──────────── Supabase ────────────┐   ┌──┴───── Next.js server ─────┐
│ Auth (bcrypt passwords)          │◄──│ src/app/api/register/route.ts│
│ Tables + RLS policies            │   │ uses SUPABASE_SERVICE_ROLE_KEY│
│ Views  v_sessions, v_bookings …  │   └──────────────────────────────┘
│ Functions book_session() …       │
└──────────────────────────────────┘
```

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| Pages | `src/app/**/page.tsx` | UI for one screen. Call `api.*`, show results with `tr()` |
| Shared UI | `src/components/*` | Header with language switcher and search, modal dialogs, toasts, generic admin table |
| State | `src/components/Providers.tsx` | `useT()` – current language and translation; `useAuth()` – logged-in member; `useRequireRole()` – page guard |
| Data access | `src/lib/api.ts`, `supabaseApi.ts`, `demoApi.ts` | One interface (`Api` in `types.ts`), two implementations |
| Helpers | `src/lib/validate.ts`, `format.ts`, `i18n.ts` | Phone/name validation, Almaty-time date formatting, kk/en/ru dictionaries |
| Database | `supabase/schema.sql`, `seed.sql` | Tables, constraints, RLS, views, business functions, demo data |

## Two run modes

`src/lib/api.ts` checks the environment variables once:

```ts
export const api: Api = isSupabaseConfigured ? supabaseApi : demoApi;
```

- **Supabase mode** – `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set.
- **Demo mode** – they are empty. `demoApi.ts` keeps all data in the browser
  (`localStorage` key `gym-demo-v2`) and re-implements the same rules as
  `schema.sql`. Useful for the exam demo when the network is unreliable.

Pages never know which mode is active (except for the demo banner), because
both objects implement the same `Api` interface.

## Pages and roles

| Route | File | Who can open it | What it does |
|---|---|---|---|
| `/` | `app/page.tsx` | Everyone (booking needs login) | Schedule with filters by branch, class, day; Book button; alternatives dialog (FR-03) |
| `/login` | `app/login/page.tsx` | Everyone | Log in / register by phone (FR-04) |
| `/profile` | `app/profile/page.tsx` | Logged-in member | Membership status, upcoming bookings, history, cancel (FR-05, FR-06) |
| `/search?q=` | `app/search/page.tsx` | Everyone (bookings only when logged in) | Trainers, branches, bookings (FR-08) |
| `/trainer` | `app/trainer/page.tsx` | Trainer | Roster of own classes (FR-10) |
| `/admin` | `app/admin/page.tsx` | Admin | CRUD for sessions, classes, trainers, branches, rooms, members; NFC check-in (FR-09) |

Role checks happen twice: `useRequireRole()` redirects in the browser, and the
database refuses the same actions through RLS policies and `is_admin()` checks.
The browser check is for convenience only; the database check is the real one.

## Main flows

### Booking a class (FR-01, FR-02, FR-03)
1. Member clicks **Book** on `/` → `api.book(sessionId)`.
2. `supabaseApi.book` calls the database function `book_session(p_session_id)`.
3. The function locks the session row (`SELECT … FOR UPDATE`), checks login,
   start time, membership, existing booking and seat count, then inserts.
4. It returns `{ ok, code, message }`. The page shows `tr(result)` in the
   current language.
5. If `code` is `class_full` or `already_booked`, the page opens a dialog
   with up to 3 other sessions of the same class that still have places.

### Cancelling (FR-06)
1. `/profile` → `api.cancel(bookingId)`.
2. If the class starts in less than 3 hours, the database returns
   `late_cancel_needs_confirm`. The page shows a warning.
3. On confirmation → `api.cancel(bookingId, true)`; the booking becomes
   `Cancelled` with `fee_forfeited = true`.

### Registration (FR-04)
1. `/login` → `api.register(...)` validates name, phone, password in the browser.
2. It posts to `/api/register`, which creates a confirmed Supabase Auth user
   with the service-role key. The key never leaves the server.
3. A database trigger (`handle_new_user`) creates the `members` row from the
   user metadata.
4. The client logs the member in automatically.

Supabase Auth requires an email, so a phone `+77011234567` is stored as
`77011234567@phone.pulsegym.app` (`phoneToAuthEmail` in `validate.ts`).

### Check-in (multi-step transaction)
Admin panel → `api.checkIn(bookingId, readerId)` → `check_in_booking()`:
insert into `check_in_logs` **and** set the booking to `Attended`. Both steps
are in one function, so they succeed or roll back together.

## Localisation (FR-07, NFR-04)

- `src/lib/i18n.ts` holds three dictionaries. `en` defines the keys; `kk` and
  `ru` are typed `Record<Key, string>`, so `npm run build` fails if a string
  is missing.
- The database and API never return translated text. They return a **code**
  (`class_full`), and `tr()` in `Providers.tsx` looks up `code_class_full`.
- The chosen language is saved in `localStorage` (`gym-lang`) and, for
  logged-in members, in `members.preferred_language`.
- All dates are shown in `Asia/Almaty` time (`format.ts`). Kazakh month and day
  names are formatted manually because many browsers lack Kazakh locale data.

## Security notes

- Passwords: bcrypt in Supabase Auth; salted PBKDF2 in demo mode.
- The anon key is public by design; what it can do is limited by RLS and grants.
- The service-role key is used only in `app/api/register/route.ts`.
- Search input is cleaned by `cleanQuery()` so it cannot inject PostgREST filter syntax.
- Views `v_*` run with owner rights and filter rows by `auth.uid()` / role themselves.
