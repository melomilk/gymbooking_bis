// Demo mode: same rules as supabase/schema.sql, data kept in this browser
// (localStorage). Used automatically when the Supabase env vars are not set.
// Passwords are stored as salted PBKDF2 hashes even here (NFR-03).
import type {
  Api, Branch, BookingRow, ClassType, Entity, Me, MemberRow, Reader, Result, Room, RosterRow, Row, SessionRow, Trainer,
} from "./types";
import { ENTITY_ID } from "./types";
import { cleanQuery, MIN_PASSWORD, normalizePhone, validName } from "./validate";
import { FREE_CANCEL_MS } from "./format";

const KEY = "gym-demo-v2";
const TZ_OFFSET_H = 5; // Asia/Almaty

type DMember = MemberRow & { pw_salt: string; pw_hash: string };
type DSession = { session_id: number; class_id: number; trainer_id: number; branch_id: number; room_id: number; start_time: string; end_time: string; capacity: number };
type DBooking = { booking_id: number; member_id: number; session_id: number; booking_status: BookingRow["booking_status"]; booking_time: string; cancelled_at: string | null; fee_forfeited: boolean };
type DReader = { reader_id: string; branch_id: number; check_in_method: string };
type Store = {
  branches: Branch[]; rooms: Room[]; trainers: Trainer[]; classes: ClassType[];
  members: DMember[]; sessions: DSession[]; bookings: DBooking[]; readers: DReader[];
  checkIns: { check_in_id: number; booking_id: number; reader_id: string; check_in_time: string }[];
  current: number | null; seq: Record<string, number>;
};

export const DEMO_ACCOUNTS = [
  { role: "Admin", phone: "+7 700 000 0001", password: "admin123" },
  { role: "Trainer", phone: "+7 700 000 0002", password: "trainer123" },
] as const;

// ---------- helpers ----------
const ok = (code: string): Result => ({ ok: true, code });
const no = (code: string): Result => ({ ok: false, code });
const nowIso = () => new Date().toISOString();
const todayYmd = () => new Date(Date.now() + TZ_OFFSET_H * 3600_000).toISOString().slice(0, 10);
const almatyYmd = (iso: string) => new Date(new Date(iso).getTime() + TZ_OFFSET_H * 3600_000).toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

async function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g)!.map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, keyMat, 256);
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { salt: hex(salt), hash: hex(new Uint8Array(bits)) };
}

// ---------- seed ----------
async function seed(): Promise<Store> {
  const st: Store = {
    branches: [
      { branch_id: 1, branch_name: "Downtown", address: "12 Abay Ave, Almaty", phone_number: "+77270000001" },
      { branch_id: 2, branch_name: "Riverside", address: "85 Dostyk Ave, Almaty", phone_number: "+77270000002" },
    ],
    rooms: [
      { room_id: 1, branch_id: 1, room_name: "Studio A", max_capacity: 25 },
      { room_id: 2, branch_id: 1, room_name: "Studio B", max_capacity: 15 },
      { room_id: 3, branch_id: 2, room_name: "Main Hall", max_capacity: 30 },
    ],
    trainers: [
      { trainer_id: 1, trainer_name: "Aigerim S.", phone: "+77010000011", email: "aigerim@pulsegym.example" },
      { trainer_id: 2, trainer_name: "Daniyar K.", phone: "+77010000012", email: "daniyar@pulsegym.example" },
      { trainer_id: 3, trainer_name: "Elena P.", phone: "+77010000013", email: "elena@pulsegym.example" },
    ],
    classes: [
      { class_id: 1, class_name: "Yoga", description: "Slow flow focused on flexibility, balance and breathing.", duration_min: 60 },
      { class_id: 2, class_name: "Pilates", description: "Core strength and posture, low impact.", duration_min: 55 },
      { class_id: 3, class_name: "HIIT", description: "High-intensity intervals. Bring water and a towel.", duration_min: 45 },
      { class_id: 4, class_name: "Spinning", description: "Indoor cycling set to music, all levels.", duration_min: 45 },
      { class_id: 5, class_name: "Zumba", description: "Dance-based cardio workout.", duration_min: 60 },
    ],
    members: [], sessions: [], bookings: [], checkIns: [],
    readers: [
      { reader_id: "NFC-DT-01", branch_id: 1, check_in_method: "NFC" },
      { reader_id: "NFC-RS-01", branch_id: 2, check_in_method: "NFC" },
    ],
    current: null,
    seq: { branches: 2, rooms: 3, trainers: 3, classes: 5, members: 0, class_sessions: 0, bookings: 0, checkIns: 0 },
  };
  const slots: [number, number, number, number, string, number, number][] = [
    [1, 1, 1, 1, "10:00", 60, 20], [2, 2, 1, 1, "18:00", 55, 15], [3, 3, 1, 2, "12:00", 45, 12],
    [4, 3, 1, 2, "19:00", 45, 10], [5, 2, 2, 3, "09:00", 60, 25], [1, 1, 2, 3, "17:30", 60, 25],
  ];
  const base = todayYmd();
  for (let d = 1; d <= 7; d++) {
    const day = new Date(Date.parse(base + "T00:00:00Z") + d * 86400_000).toISOString().slice(0, 10);
    for (const [c, t, b, r, hm, mins, cap] of slots) {
      const start = new Date(`${day}T${hm}:00+05:00`).getTime();
      st.sessions.push({ session_id: ++st.seq.class_sessions, class_id: c, trainer_id: t, branch_id: b, room_id: r,
        start_time: new Date(start).toISOString(), end_time: new Date(start + mins * 60_000).toISOString(), capacity: cap });
    }
  }
  const accounts: [string, string, string, string, MemberRow["role"], number | null][] = [
    ["Dana", "Admin", "+77000000001", "admin123", "Admin", null],
    ["Aigerim", "Sadykova", "+77000000002", "trainer123", "Trainer", 1],
  ];
  for (const [n, s, p, pw, role, tid] of accounts) {
    const h = await hashPassword(pw);
    st.members.push({ member_id: ++st.seq.members, member_name: n, member_surname: s, phone_number: p, membership_status: "Active",
      membership_expiry: plusDays(365), role, trainer_id: tid, preferred_language: "en", pw_salt: h.salt, pw_hash: h.hash });
  }
  return st;
}

let seeding: Promise<Store> | null = null;
async function load(): Promise<Store> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch { /* storage unavailable */ }
  if (!seeding) seeding = seed().then((s) => { save(s); return s; });
  const s = await seeding;
  seeding = null;
  return JSON.parse(JSON.stringify(s)) as Store;
}
function save(s: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

// ---------- "views" ----------
const me = (st: Store) => st.members.find((m) => m.member_id === st.current) ?? null;
const isAdmin = (st: Store) => me(st)?.role === "Admin";
const taken = (st: Store, sessionId: number) =>
  st.bookings.filter((b) => b.session_id === sessionId && b.booking_status !== "Cancelled").length;

function vSession(st: Store, s: DSession): SessionRow {
  const c = st.classes.find((x) => x.class_id === s.class_id)!;
  return {
    session_id: s.session_id, class_id: s.class_id, class_name: c.class_name, description: c.description, duration_min: c.duration_min,
    trainer_id: s.trainer_id, trainer_name: st.trainers.find((x) => x.trainer_id === s.trainer_id)!.trainer_name,
    branch_id: s.branch_id, branch_name: st.branches.find((x) => x.branch_id === s.branch_id)!.branch_name,
    room_id: s.room_id, room_name: st.rooms.find((x) => x.room_id === s.room_id)!.room_name,
    start_time: s.start_time, end_time: s.end_time, capacity: s.capacity, spots_taken: taken(st, s.session_id),
  };
}

function vBooking(st: Store, b: DBooking): BookingRow {
  const s = vSession(st, st.sessions.find((x) => x.session_id === b.session_id)!);
  const m = st.members.find((x) => x.member_id === b.member_id)!;
  return {
    booking_id: b.booking_id, member_id: b.member_id, session_id: b.session_id, booking_status: b.booking_status,
    booking_time: b.booking_time, cancelled_at: b.cancelled_at, fee_forfeited: b.fee_forfeited,
    member_fullname: `${m.member_name} ${m.member_surname}`, class_name: s.class_name, trainer_id: s.trainer_id,
    trainer_name: s.trainer_name, branch_id: s.branch_id, branch_name: s.branch_name, room_name: s.room_name,
    start_time: s.start_time, end_time: s.end_time,
  };
}

/** v_bookings: own rows for members, all rows for admins */
function visibleBookings(st: Store): BookingRow[] {
  const m = me(st);
  if (!m) return [];
  return st.bookings.filter((b) => m.role === "Admin" || b.member_id === m.member_id).map((b) => vBooking(st, b));
}

const includes = (hay: string, q: string) => hay.toLocaleLowerCase().includes(q.toLocaleLowerCase());
const overlaps = (a: DSession, b: { start_time: string; end_time: string }) =>
  new Date(a.start_time) < new Date(b.end_time) && new Date(b.start_time) < new Date(a.end_time);

// ---------- admin validation (mirrors the DB constraints) ----------
function validate(st: Store, entity: Entity, row: Row, id: number | null): string | null {
  const others = <T extends Row>(list: T[]) => list.filter((x) => x[ENTITY_ID[entity]] !== id);
  switch (entity) {
    case "branches":
      if (!str(row.branch_name) || !str(row.address) || !str(row.phone_number)) return "required";
      if (others(st.branches).some((b) => b.phone_number === str(row.phone_number))) return "duplicate";
      return null;
    case "rooms": {
      if (!str(row.room_name) || !(num(row.max_capacity) > 0) || !st.branches.some((b) => b.branch_id === num(row.branch_id))) return "required";
      if (others(st.rooms).some((r) => r.branch_id === num(row.branch_id) && r.room_name === str(row.room_name))) return "duplicate";
      if (id !== null && st.sessions.some((s) => s.room_id === id && s.capacity > num(row.max_capacity))) return "capacity_exceeds_room";
      return null;
    }
    case "trainers":
      return str(row.trainer_name) ? null : "required";
    case "classes":
      if (!str(row.class_name) || !(num(row.duration_min) > 0)) return "required";
      if (others(st.classes).some((c) => c.class_name === str(row.class_name))) return "duplicate";
      return null;
    case "class_sessions": {
      const room = st.rooms.find((r) => r.room_id === num(row.room_id));
      if (!room || !st.classes.some((c) => c.class_id === num(row.class_id)) || !st.trainers.some((t) => t.trainer_id === num(row.trainer_id))
        || !row.start_time || !row.end_time || !(num(row.capacity) > 0)) return "required";
      if (room.branch_id !== num(row.branch_id)) return "invalid_value";
      const cand = { start_time: String(row.start_time), end_time: String(row.end_time) };
      if (new Date(cand.end_time) <= new Date(cand.start_time)) return "invalid_time";
      if (num(row.capacity) > room.max_capacity) return "capacity_exceeds_room";
      if (id !== null && num(row.capacity) < taken(st, id)) return "capacity_below_bookings";
      const rest = st.sessions.filter((s) => s.session_id !== id);
      if (rest.some((s) => s.room_id === room.room_id && overlaps(s, cand))) return "room_overlap";
      if (rest.some((s) => s.trainer_id === num(row.trainer_id) && overlaps(s, cand))) return "trainer_overlap";
      return null;
    }
    case "members": {
      const target = st.members.find((m) => m.member_id === id);
      if (!target) return "forbidden";
      const role = str(row.role ?? target.role);
      const tid = row.trainer_id === undefined ? target.trainer_id : row.trainer_id === null || row.trainer_id === "" ? null : num(row.trainer_id);
      if (!["Member", "Trainer", "Admin"].includes(role)) return "invalid_value";
      if (role === "Trainer" && tid === null) return "trainer_needs_link";
      if (tid !== null && st.members.some((m) => m.member_id !== id && m.trainer_id === tid)) return "duplicate";
      if (target.member_id === st.current && target.role === "Admin" && role !== "Admin") return "cannot_demote_self";
      if (row.membership_status && !["Active", "Suspended"].includes(str(row.membership_status))) return "invalid_value";
      return null;
    }
  }
}

function inUse(st: Store, entity: Entity, id: number): boolean {
  switch (entity) {
    case "branches": return st.rooms.some((r) => r.branch_id === id) || st.sessions.some((s) => s.branch_id === id) || st.readers.some((r) => r.branch_id === id);
    case "rooms": return st.sessions.some((s) => s.room_id === id);
    case "trainers": return st.sessions.some((s) => s.trainer_id === id) || st.members.some((m) => m.trainer_id === id);
    case "classes": return st.sessions.some((s) => s.class_id === id);
    case "class_sessions": return st.bookings.some((b) => b.session_id === id);
    case "members": return true;
  }
}

const NUMERIC = new Set(["branch_id", "room_id", "trainer_id", "class_id", "max_capacity", "duration_min", "capacity"]);
function coerce(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = NUMERIC.has(k) ? (v === null || v === "" ? null : Number(v)) : typeof v === "string" ? v.trim() : v;
  }
  return out;
}

function tableOf(st: Store, entity: Entity): Row[] {
  return (entity === "class_sessions" ? st.sessions : st[entity]) as unknown as Row[];
}

// ---------- API ----------
export const demoApi: Api = {
  mode: "demo",

  async getMe() {
    const st = await load();
    const m = me(st);
    if (!m) return null;
    const eff: Me["effective_status"] = m.membership_status === "Suspended" ? "Suspended" : m.membership_expiry < todayYmd() ? "Expired" : "Active";
    return {
      member_id: m.member_id, member_name: m.member_name, member_surname: m.member_surname, membership_expiry: m.membership_expiry,
      phone_number: m.phone_number, role: m.role, trainer_id: m.trainer_id, preferred_language: m.preferred_language, effective_status: eff,
    };
  },

  async register({ name, surname, phone, password, lang }) {
    const p = normalizePhone(phone);
    if (!validName(name) || !validName(surname)) return no("invalid_name");
    if (!p) return no("invalid_phone");
    if (password.length < MIN_PASSWORD) return no("weak_password");
    const st = await load();
    if (st.members.some((m) => m.phone_number === p)) return no("phone_taken");
    const h = await hashPassword(password);
    const id = ++st.seq.members;
    st.members.push({ member_id: id, member_name: name.trim(), member_surname: surname.trim(), phone_number: p, membership_status: "Active",
      membership_expiry: plusDays(30), role: "Member", trainer_id: null, preferred_language: lang, pw_salt: h.salt, pw_hash: h.hash });
    st.current = id;
    save(st);
    return ok("created");
  },

  async login(phone, password) {
    const st = await load();
    const p = normalizePhone(phone);
    const m = st.members.find((x) => x.phone_number === p);
    if (!m || (await hashPassword(password, m.pw_salt)).hash !== m.pw_hash) return no("bad_credentials");
    st.current = m.member_id;
    save(st);
    return ok("saved");
  },

  async logout() {
    const st = await load();
    st.current = null;
    save(st);
  },

  async setLanguage(lang) {
    const st = await load();
    const m = me(st);
    if (m) { m.preferred_language = lang; save(st); }
  },

  async listBranches() {
    return [...(await load()).branches].sort((a, b) => a.branch_name.localeCompare(b.branch_name));
  },

  async listSessions(opts) {
    const st = await load();
    const now = Date.now();
    return st.sessions
      .filter((s) => opts?.includePast || new Date(s.start_time).getTime() > now)
      .map((s) => vSession(st, s))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  },

  async searchTrainers(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    return (await load()).trainers.filter((t) => includes(t.trainer_name, c)).map((t) => ({ trainer_id: t.trainer_id, trainer_name: t.trainer_name }));
  },

  async searchBranches(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    return (await load()).branches.filter((b) => includes(b.branch_name, c) || includes(b.address, c));
  },

  async myBookings(memberId) {
    const st = await load();
    return visibleBookings(st).filter((b) => b.member_id === memberId).sort((a, b) => b.start_time.localeCompare(a.start_time));
  },

  async searchBookings(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    const st = await load();
    return visibleBookings(st)
      .filter((b) => [b.class_name, b.trainer_name, b.branch_name, b.member_fullname].some((f) => includes(f, c)))
      .sort((a, b) => b.start_time.localeCompare(a.start_time)).slice(0, 50);
  },

  async book(sessionId) {
    const st = await load();
    const m = me(st);
    if (!m) return no("not_signed_in");
    const s = st.sessions.find((x) => x.session_id === sessionId);
    if (!s) return no("session_not_found");
    if (new Date(s.start_time).getTime() <= Date.now()) return no("class_started");
    if (m.membership_status === "Suspended") return no("membership_suspended");
    if (m.membership_expiry < almatyYmd(s.start_time)) return no("membership_expired");
    const old = st.bookings.find((b) => b.member_id === m.member_id && b.session_id === sessionId);
    if (old && old.booking_status !== "Cancelled") return no("already_booked");
    if (taken(st, sessionId) >= s.capacity) return no("class_full");
    if (old) Object.assign(old, { booking_status: "Confirmed", booking_time: nowIso(), cancelled_at: null, fee_forfeited: false });
    else st.bookings.push({ booking_id: ++st.seq.bookings, member_id: m.member_id, session_id: sessionId, booking_status: "Confirmed",
      booking_time: nowIso(), cancelled_at: null, fee_forfeited: false });
    save(st);
    return ok("booked");
  },

  async cancel(bookingId, acceptFee = false) {
    const st = await load();
    const m = me(st);
    const b = st.bookings.find((x) => x.booking_id === bookingId && x.member_id === m?.member_id);
    if (!b) return no("booking_not_found");
    if (b.booking_status !== "Confirmed") return no("not_cancellable");
    const start = new Date(st.sessions.find((x) => x.session_id === b.session_id)!.start_time).getTime();
    if (start <= Date.now()) return no("class_started");
    const late = start - Date.now() < FREE_CANCEL_MS;
    if (late && !acceptFee) return no("late_cancel_needs_confirm");
    Object.assign(b, { booking_status: "Cancelled", cancelled_at: nowIso(), fee_forfeited: late });
    save(st);
    return ok(late ? "cancelled_fee_forfeited" : "cancelled");
  },

  async trainerRoster() {
    const st = await load();
    const m = me(st);
    if (m?.role !== "Trainer" || m.trainer_id === null) return [];
    const cutoff = Date.now() - 12 * 3600_000;
    const rows: RosterRow[] = [];
    for (const s of st.sessions.filter((x) => x.trainer_id === m.trainer_id && new Date(x.end_time).getTime() > cutoff)) {
      const v = vSession(st, s);
      const base = { session_id: s.session_id, class_name: v.class_name, branch_name: v.branch_name, room_name: v.room_name,
        start_time: s.start_time, end_time: s.end_time, capacity: s.capacity };
      const bs = st.bookings.filter((b) => b.session_id === s.session_id && b.booking_status !== "Cancelled");
      if (!bs.length) rows.push({ ...base, booking_id: null, booking_status: null, member_fullname: null });
      for (const b of bs) {
        const who = st.members.find((x) => x.member_id === b.member_id)!;
        rows.push({ ...base, booking_id: b.booking_id, booking_status: b.booking_status, member_fullname: `${who.member_name} ${who.member_surname}` });
      }
    }
    return rows.sort((a, b) => a.start_time.localeCompare(b.start_time));
  },

  async adminList(entity) {
    const st = await load();
    if (!isAdmin(st)) return [];
    const rows = tableOf(st, entity).map((r) => ({ ...r }));
    if (entity === "members") rows.forEach((r) => { delete r.pw_hash; delete r.pw_salt; });
    return rows;
  },

  async adminInsert(entity, raw) {
    const st = await load();
    if (!isAdmin(st)) return no("forbidden");
    if (entity === "members") return no("forbidden");
    const row = coerce(raw);
    const err = validate(st, entity, row, null);
    if (err) return no(err);
    row[ENTITY_ID[entity]] = ++st.seq[entity];
    tableOf(st, entity).push(row);
    save(st);
    return ok("created");
  },

  async adminUpdate(entity, id, raw) {
    const st = await load();
    if (!isAdmin(st)) return no("forbidden");
    const target = tableOf(st, entity).find((r) => r[ENTITY_ID[entity]] === id);
    if (!target) return no("forbidden");
    const row = coerce(raw);
    const err = validate(st, entity, { ...target, ...row }, id);
    if (err) return no(err);
    Object.assign(target, row);
    save(st);
    return ok("updated");
  },

  async adminDelete(entity, id) {
    const st = await load();
    if (!isAdmin(st)) return no("forbidden");
    if (inUse(st, entity, id)) return no("in_use");
    const list = tableOf(st, entity);
    const i = list.findIndex((r) => r[ENTITY_ID[entity]] === id);
    if (i < 0) return no("forbidden");
    list.splice(i, 1);
    save(st);
    return ok("deleted");
  },

  async allBookings() {
    const st = await load();
    if (!isAdmin(st)) return [];
    const cutoff = Date.now() - 12 * 3600_000;
    return visibleBookings(st)
      .filter((b) => (b.booking_status === "Confirmed" || b.booking_status === "Attended") && new Date(b.end_time).getTime() > cutoff)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  },

  async listReaders() {
    const st = await load();
    if (!isAdmin(st)) return [];
    return st.readers.map<Reader>((r) => ({ ...r, branch_name: st.branches.find((b) => b.branch_id === r.branch_id)?.branch_name ?? "" }));
  },

  async checkIn(bookingId, readerId) {
    const st = await load();
    if (!isAdmin(st)) return no("admin_only");
    const b = st.bookings.find((x) => x.booking_id === bookingId);
    if (!b) return no("booking_not_found");
    if (b.booking_status === "Attended") return no("already_checked_in");
    if (b.booking_status !== "Confirmed") return no("not_checkinable");
    const r = st.readers.find((x) => x.reader_id === readerId);
    if (!r) return no("unknown_reader");
    const s = st.sessions.find((x) => x.session_id === b.session_id)!;
    if (r.branch_id !== s.branch_id) return no("wrong_branch_reader");
    // both steps saved together (one transaction)
    st.checkIns.push({ check_in_id: ++st.seq.checkIns, booking_id: b.booking_id, reader_id: readerId, check_in_time: nowIso() });
    b.booking_status = "Attended";
    save(st);
    return ok("checked_in");
  },
};
