// Demo mode: same rules as supabase/schema.sql, data kept in this browser
// (localStorage). Used automatically when the Supabase env vars are not set.
// Passwords are stored as salted PBKDF2 hashes even here (NFR-03).
import type {
  Api, AttendanceRow, CertificateFile, TrainerApplication, Branch, BookingRow, ClassType, Entity, Me, MemberRow, Reader, Result, Room, RosterRow, Row, SessionRow, Trainer,
  Leaderboard, MyReview, PointsEntry, PointsSummary, Redemption, Review, Reward, TrainerRating, WaitlistEntry,
} from "./types";
import { CERT_MAX_BYTES, CERT_MAX_FILES, CERT_TYPES, ENTITY_ID, EXCUSE_DOC_MAX_BYTES, EXCUSE_DOC_TYPES,
  POINTS, REVIEW_MAX_CHARS, REVIEW_WINDOW_DAYS, REWARD_KINDS, WAITLIST_CLOSES_MS, WAITLIST_MAX } from "./types";
import { almatyWeekStart, streakWeeks } from "./rewards";
import { checkExcuse, checkTrainerApplication, cleanQuery, MIN_PASSWORD, normalizePhone, validName } from "./validate";
import { CHECKIN_OPENS_MS, FREE_CANCEL_MS } from "./format";

const KEY = "gym-demo-v3"; // v3: points, rewards, waitlist, reviews + a demo member with visit history
const TZ_OFFSET_H = 5; // Asia/Almaty

type DMember = MemberRow & { pw_salt: string; pw_hash: string };
type DSession = { session_id: number; class_id: number; trainer_id: number; branch_id: number; room_id: number; start_time: string; end_time: string; capacity: number; cancelled_at?: string | null };
type DBooking = { booking_id: number; member_id: number; session_id: number; booking_status: BookingRow["booking_status"]; booking_time: string; cancelled_at: string | null; fee_forfeited: boolean;
  excuse_reason?: BookingRow["excuse_reason"]; excuse_note?: string | null; excuse_document?: string | null; excused_at?: string | null };
type DReader = { reader_id: string; branch_id: number; check_in_method: string };
type Store = {
  branches: Branch[]; rooms: Room[]; trainers: Trainer[]; classes: ClassType[];
  members: DMember[]; sessions: DSession[]; bookings: DBooking[]; readers: DReader[];
  checkIns: { check_in_id: number; booking_id: number; reader_id: string | null; is_manual?: boolean; check_in_time: string }[];
  current: number | null; seq: Record<string, number>;
  // trainer sign-up (optional: stores saved before this feature don't have them)
  applications?: DApplication[];
  /** certificate / excuse note path -> data URL (small files only; localStorage is ~5 MB) */
  files?: Record<string, string>;
} & Extra;
type DApplication = Omit<TrainerApplication, "member_fullname" | "phone_number">;
// Pulse points, rewards, waitlist, reviews (same rules as the three migrations)
type DRedemption = { redemption_id: number; member_id: number; reward_id: number; cost: number; code: string;
  status: Redemption["status"]; created_at: string; used_at: string | null; cancelled_at: string | null; used_booking_id?: number | null };
type DWait = { entry_id: number; session_id: number; member_id: number; status: WaitlistEntry["status"]; promoted_auto: boolean;
  status_reason: WaitlistEntry["status_reason"]; booking_id: number | null; created_at: string; updated_at: string };
type DReview = { review_id: number; booking_id: number; member_id: number; session_id: number; trainer_id: number;
  rating: number; comment: string | null; created_at: string; updated_at: string };
type Extra = {
  rewards: Reward[]; redemptions: DRedemption[]; waitlist: DWait[]; reviews: DReview[];
  /** booking_id -> when the +5 for a review was given / taken back (points once per class) */
  reviewPoints: Record<number, { given: string; removed?: string }>;
};
const DEMO_FILE_LIMIT = 700 * 1024;

export const DEMO_ACCOUNTS = [
  { role: "Admin", phone: "+7 700 000 0001", password: "admin123" },
  { role: "Trainer", phone: "+7 700 000 0002", password: "trainer123" },
  { role: "Receptionist", phone: "+7 700 000 0003", password: "reception123" },
  { role: "Member", phone: "+7 700 000 0004", password: "member123" },
] as const;

/** Starter catalog: the same as migration_points_rewards.sql. */
const STARTER_REWARDS: Omit<Reward, "reward_id">[] = [
  { reward_name: "Late-cancel pass", description: "Your next late cancellation is free of charge.", kind: "late_cancel_pass", cost: 60, stock: null, extend_days: null, active: true },
  { reward_name: "Free single visit", description: "One extra class or a guest visit for a friend.", kind: "free_class", cost: 150, stock: null, extend_days: null, active: true },
  { reward_name: "PulseGym water bottle", description: "Branded 0.7 l bottle. Pick it up at the front desk.", kind: "merch", cost: 250, stock: 30, extend_days: null, active: true },
  { reward_name: "+7 days of membership", description: "Your membership is extended by 7 days right away.", kind: "membership_days", cost: 300, stock: null, extend_days: 7, active: true },
  { reward_name: "PulseGym towel", description: "Branded sports towel. Pick it up at the front desk.", kind: "merch", cost: 350, stock: 20, extend_days: null, active: true },
  { reward_name: "PulseGym T-shirt", description: "Branded training T-shirt. Pick it up at the front desk.", kind: "merch", cost: 500, stock: 15, extend_days: null, active: true },
];

/** Stores saved by an older version lack the new lists. */
function normalize(st: Store): Store {
  st.rewards ??= STARTER_REWARDS.map((r, i) => ({ ...r, reward_id: i + 1 }));
  st.redemptions ??= []; st.waitlist ??= []; st.reviews ??= []; st.reviewPoints ??= {};
  st.seq.rewards ??= st.rewards.reduce((m, r) => Math.max(m, r.reward_id), 0);
  for (const k of ["redemptions", "waitlist", "reviews"]) st.seq[k] ??= 0;
  return st;
}

// ---------- helpers ----------
const ok = (code: string): Result => ({ ok: true, code });
/** Password-reset codes "sent by SMS" (demo mode keeps them in memory only). */
const resetCodes = new Map<string, { code: string; expires: number }>();
const RESET_TTL_MS = 10 * 60_000;
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
  const st = {
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
    // rewards & co. are filled by normalize() below (it fills only missing lists)
    readers: [
      { reader_id: "NFC-DT-01", branch_id: 1, check_in_method: "NFC" },
      { reader_id: "NFC-RS-01", branch_id: 2, check_in_method: "NFC" },
    ],
    current: null,
    seq: { branches: 2, rooms: 3, trainers: 3, classes: 5, members: 0, class_sessions: 0, bookings: 0, checkIns: 0 },
  } as unknown as Store; // the reward lists are added by normalize()
  normalize(st);
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
    ["Madina", "Orazova", "+77000000003", "reception123", "Receptionist", null],
    ["Aruzhan", "Bekova", "+77000000004", "member123", "Member", null],
    ["Timur", "Sarsen", "+77000000005", "member123", "Member", null],
  ];
  for (const [n, s, p, pw, role, tid] of accounts) {
    const h = await hashPassword(pw);
    st.members.push({ member_id: ++st.seq.members, member_name: n, member_surname: s, phone_number: p, membership_status: "Active",
      membership_expiry: plusDays(365), role, trainer_id: tid, preferred_language: "en", pw_salt: h.salt, pw_hash: h.hash });
  }
  seedHistory(st);
  return st;
}

/**
 * Demo history so points, badges, the leaderboard and reviews have something to
 * show: the last 5 weeks of classes, Aruzhan (member 4) came 2-3 times a week
 * and missed once; Timur (member 5) came a few times. One review is left.
 */
function seedHistory(st: Store) {
  const past: [number, number, number, number, string, number][] = [ // days ago, class, trainer, room(branch), time, minutes
    [33, 1, 1, 1, "08:00", 60], [31, 3, 3, 2, "12:00", 45], [26, 2, 2, 1, "18:00", 55], [24, 1, 1, 1, "08:00", 60],
    [19, 4, 3, 2, "19:00", 45], [17, 5, 2, 3, "08:00", 60], [12, 1, 1, 1, "08:00", 60], [10, 3, 3, 2, "12:00", 45],
    [5, 2, 2, 1, "18:00", 55], [3, 1, 1, 1, "08:00", 60], [2, 4, 3, 2, "19:00", 45],
  ];
  const branchOf = (room: number) => st.rooms.find((r) => r.room_id === room)!.branch_id;
  past.forEach(([ago, cls, tr, room, hm, mins], i) => {
    const day = new Date(Date.parse(todayYmd() + "T00:00:00Z") - ago * 86400_000).toISOString().slice(0, 10);
    const start = new Date(`${day}T${hm}:00+05:00`).getTime();
    const sid = ++st.seq.class_sessions;
    st.sessions.push({ session_id: sid, class_id: cls, trainer_id: tr, branch_id: branchOf(room), room_id: room,
      start_time: new Date(start).toISOString(), end_time: new Date(start + mins * 60_000).toISOString(), capacity: 15 });
    const add = (member: number, status: BookingRow["booking_status"]) => st.bookings.push({ booking_id: ++st.seq.bookings,
      member_id: member, session_id: sid, booking_status: status, booking_time: new Date(start - 86400_000).toISOString(),
      cancelled_at: null, fee_forfeited: status === "No-show" });
    add(4, i === 4 ? "No-show" : "Attended");
    if (i % 3 === 0) add(5, "Attended");
  });
  // Aruzhan rated the yoga class 3 days ago (trainer 1 = the demo trainer account)
  const b = st.bookings.find((x) => x.member_id === 4 && st.sessions.find((s) => s.session_id === x.session_id)?.class_id === 1
    && Date.now() - new Date(st.sessions.find((s) => s.session_id === x.session_id)!.start_time).getTime() < 7 * 86400_000)!;
  const s = st.sessions.find((x) => x.session_id === b.session_id)!;
  st.reviews.push({ review_id: ++st.seq.reviews, booking_id: b.booking_id, member_id: 4, session_id: s.session_id, trainer_id: s.trainer_id,
    rating: 5, comment: "Calm music, clear explanations.", created_at: s.end_time, updated_at: s.end_time });
  st.reviewPoints[b.booking_id] = { given: s.end_time };
}

/** Same rule as mark_no_shows() in schema.sql: a booking still 'Confirmed'
 *  after its class has ended becomes 'No-show' and the fee is forfeited. */
function markNoShows(st: Store): boolean {
  let changed = false;
  for (const b of st.bookings) {
    if (b.booking_status !== "Confirmed") continue;
    const s = st.sessions.find((x) => x.session_id === b.session_id);
    if (s && new Date(s.end_time).getTime() < Date.now()) {
      b.booking_status = "No-show";
      b.fee_forfeited = true;
      changed = true;
    }
  }
  return changed;
}

let seeding: Promise<Store> | null = null;
async function load(): Promise<Store> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const st = normalize(JSON.parse(raw) as Store);
      if (markNoShows(st)) save(st);
      return st;
    }
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
/** Admin or Receptionist: the front-desk functions (all bookings, readers, check-in). */
const isStaff = (st: Store) => me(st)?.role === "Admin" || me(st)?.role === "Receptionist";
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
    cancelled_at: s.cancelled_at ?? null,
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
    start_time: s.start_time, end_time: s.end_time, session_cancelled_at: s.cancelled_at ?? null,
    excuse_reason: b.excuse_reason ?? null, excuse_note: b.excuse_note ?? null,
    excuse_document: b.excuse_document ?? null, excused_at: b.excused_at ?? null,
  };
}

/** v_bookings: own rows for members, all rows for admins */
function visibleBookings(st: Store): BookingRow[] {
  const m = me(st);
  if (!m) return [];
  return st.bookings.filter((b) => m.role === "Admin" || m.role === "Receptionist" || b.member_id === m.member_id).map((b) => vBooking(st, b));
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
      const rest = st.sessions.filter((s) => s.session_id !== id && !s.cancelled_at); // a cancelled class frees its room / trainer
      if (rest.some((s) => s.room_id === room.room_id && overlaps(s, cand))) return "room_overlap";
      if (rest.some((s) => s.trainer_id === num(row.trainer_id) && overlaps(s, cand))) return "trainer_overlap";
      return null;
    }
    case "members": {
      const target = st.members.find((m) => m.member_id === id);
      if (!target) return "forbidden";
      const role = str(row.role ?? target.role);
      const tid = row.trainer_id === undefined ? target.trainer_id : row.trainer_id === null || row.trainer_id === "" ? null : num(row.trainer_id);
      if (!["Member", "Trainer", "Receptionist", "Admin"].includes(role)) return "invalid_value";
      if (role === "Trainer" && tid === null) return "trainer_needs_link";
      if (tid !== null && st.members.some((m) => m.member_id !== id && m.trainer_id === tid)) return "duplicate";
      if (target.member_id === st.current && target.role === "Admin" && role !== "Admin") return "cannot_demote_self";
      if (row.membership_status && !["Active", "Suspended"].includes(str(row.membership_status))) return "invalid_value";
      return null;
    }
    case "rewards": {  // same CHECKs as the rewards table
      const cost = num(row.cost), stock = row.stock === null || row.stock === undefined ? null : num(row.stock);
      const days = row.extend_days === null || row.extend_days === undefined ? null : num(row.extend_days);
      if (!str(row.reward_name) || !REWARD_KINDS.includes(str(row.kind) as Reward["kind"])) return "required";
      if (!(cost >= 1 && cost <= 100000) || (stock !== null && !(stock >= 0))) return "invalid_value";
      if (days !== null && !(days >= 1 && days <= 365)) return "invalid_value";
      if (row.kind === "membership_days" && days === null) return "reward_needs_days";
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
    case "rewards": return st.redemptions.some((r) => r.reward_id === id);
  }
}

const NUMERIC = new Set(["branch_id", "room_id", "trainer_id", "class_id", "max_capacity", "duration_min", "capacity", "cost", "stock", "extend_days"]);
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
function vApplication(st: Store, a: DApplication): TrainerApplication {
  const m = st.members.find((x) => x.member_id === a.member_id)!;
  return { ...a, member_fullname: `${m.member_name} ${m.member_surname}`, phone_number: m.phone_number };
}

/** File -> data URL without FileReader (also works in Node tests). */
async function fileToDataUrl(f: File) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${f.type};base64,${btoa(bin)}`;
}

const readAsDataUrl = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

// ---------- Pulse points (derived from bookings, reviews and redemptions) ----------
const W_MS = 7 * 86400_000;
function ledgerFor(st: Store, memberId: number): PointsEntry[] {
  const out: PointsEntry[] = [];
  const add = (delta: number, reason: PointsEntry["reason"], created_at: string, extra: Partial<PointsEntry> = {}) =>
    out.push({ entry_id: out.length + 1, delta, reason, created_at, class_name: null, start_time: null, reward_name: null, ...extra });
  const attendedStarts: string[] = [];
  for (const b of st.bookings.filter((x) => x.member_id === memberId)) {
    const ses = st.sessions.find((x) => x.session_id === b.session_id)!;
    const cls = { class_name: st.classes.find((c) => c.class_id === ses.class_id)?.class_name ?? null, start_time: ses.start_time };
    if (b.booking_status === "Attended") { add(POINTS.attended, "attended", ses.start_time, cls); attendedStarts.push(ses.start_time); }
    if (b.booking_status === "No-show") add(POINTS.no_show, "no_show", ses.end_time, cls);
    if (b.booking_status === "Cancelled" && b.excused_at) {
      add(POINTS.no_show, "no_show", ses.end_time, cls);
      add(-POINTS.no_show, "no_show_reversed", b.excused_at, cls);
    }
    const rp = st.reviewPoints[b.booking_id];
    if (rp) {
      add(POINTS.review, "review", rp.given, cls);
      if (rp.removed) add(-POINTS.review, "review_removed", rp.removed, cls);
    }
  }
  // +20 for every 4th week in a row
  const weeks = Array.from(new Set(attendedStarts.map(almatyWeekStart))).sort((a, b) => a - b);
  let run = 0;
  weeks.forEach((w, i) => {
    run = i > 0 && w === weeks[i - 1] + W_MS ? run + 1 : 1;
    if (run % POINTS.streak_every === 0) add(POINTS.streak_bonus, "streak_bonus", new Date(w + 6 * 86400_000).toISOString());
  });
  for (const r of st.redemptions.filter((x) => x.member_id === memberId)) {
    const name = st.rewards.find((w) => w.reward_id === r.reward_id)?.reward_name ?? null;
    add(-r.cost, "redeem", r.created_at, { reward_name: name });
    if (r.status === "Cancelled" && r.cancelled_at) add(r.cost, "redeem_refund", r.cancelled_at, { reward_name: name });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.entry_id - a.entry_id);
}

const monthStartIso = () => { // 1st of this month, 00:00 Almaty
  const d = new Date(Date.now() + TZ_OFFSET_H * 3600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_H * 3600_000).toISOString();
};

function summaryFor(st: Store, memberId: number): PointsSummary {
  const l = ledgerFor(st, memberId);
  const sum = (f: (e: PointsEntry) => boolean) => l.filter(f).reduce((a, e) => a + e.delta, 0);
  const month = monthStartIso();
  const attended = st.bookings.filter((b) => b.member_id === memberId && b.booking_status === "Attended")
    .map((b) => st.sessions.find((x) => x.session_id === b.session_id)!.start_time);
  return {
    balance: sum(() => true),
    lifetime: sum((e) => e.reason === "attended" || e.reason === "streak_bonus" || e.reason === "review"),
    month_points: sum((e) => e.created_at >= month && e.reason !== "redeem" && e.reason !== "redeem_refund"),
    streak: streakWeeks(attended),
    streak_bonuses: l.filter((e) => e.reason === "streak_bonus").length,
  };
}

function vRedemption(st: Store, r: DRedemption): Redemption {
  const m = st.members.find((x) => x.member_id === r.member_id)!;
  const w = st.rewards.find((x) => x.reward_id === r.reward_id)!;
  return { redemption_id: r.redemption_id, member_id: r.member_id, member_fullname: `${m.member_name} ${m.member_surname}`,
    phone_number: m.phone_number, reward_id: r.reward_id, reward_name: w.reward_name, kind: w.kind, extend_days: w.extend_days,
    cost: r.cost, code: r.code, status: r.status, created_at: r.created_at, used_at: r.used_at, cancelled_at: r.cancelled_at };
}

// ---------- waitlist (same rules as promote_waitlist() in migration_waitlist.sql) ----------
function promoteWaitlist(st: Store, sessionId: number) {
  const s = st.sessions.find((x) => x.session_id === sessionId);
  if (!s) return;
  const waiting = () => st.waitlist.filter((w) => w.session_id === sessionId && w.status === "Waiting")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.entry_id - b.entry_id);
  if (s.cancelled_at) {
    for (const w of waiting()) Object.assign(w, { status: "Expired", status_reason: "session_cancelled", updated_at: nowIso() });
    return;
  }
  if (new Date(s.start_time).getTime() - Date.now() < WAITLIST_CLOSES_MS) return;
  while (taken(st, sessionId) < s.capacity) {
    const w = waiting()[0];
    if (!w) return;
    const m = st.members.find((x) => x.member_id === w.member_id)!;
    let reason: WaitlistEntry["status_reason"] = null;
    if (m.membership_status === "Suspended" || m.membership_expiry < almatyYmd(s.start_time)) reason = "membership";
    else if (st.bookings.some((b) => {
      if (b.member_id !== m.member_id || b.session_id === sessionId || (b.booking_status !== "Confirmed" && b.booking_status !== "Attended")) return false;
      const o = st.sessions.find((x) => x.session_id === b.session_id)!;
      return new Date(o.start_time) < new Date(s.end_time) && new Date(s.start_time) < new Date(o.end_time);
    })) reason = "time_conflict";
    if (reason) { Object.assign(w, { status: "Expired", status_reason: reason, updated_at: nowIso() }); continue; }
    let b = st.bookings.find((x) => x.member_id === m.member_id && x.session_id === sessionId);
    if (b && b.booking_status !== "Cancelled") { Object.assign(w, { status: "Promoted", booking_id: b.booking_id, updated_at: nowIso() }); continue; }
    if (b) Object.assign(b, { booking_status: "Confirmed", booking_time: nowIso(), cancelled_at: null, fee_forfeited: false });
    else {
      b = { booking_id: ++st.seq.bookings, member_id: m.member_id, session_id: sessionId, booking_status: "Confirmed",
        booking_time: nowIso(), cancelled_at: null, fee_forfeited: false };
      st.bookings.push(b);
    }
    Object.assign(w, { status: "Promoted", promoted_auto: true, booking_id: b.booking_id, updated_at: nowIso() });
  }
}

/** The member booked the class themself: no longer waiting for it. */
function markBookedFromQueue(st: Store, memberId: number, sessionId: number, bookingId: number) {
  for (const w of st.waitlist) {
    if (w.member_id === memberId && w.session_id === sessionId && w.status === "Waiting") {
      Object.assign(w, { status: "Promoted", booking_id: bookingId, updated_at: nowIso() });
    }
  }
}

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
    if (!p) return no("invalid_phone");
    const m = st.members.find((x) => x.phone_number === p);
    if (!m || (await hashPassword(password, m.pw_salt)).hash !== m.pw_hash) return no("bad_credentials");
    st.current = m.member_id;
    save(st);
    return ok("saved");
  },

  async requestPasswordReset(phone) {
    const p = normalizePhone(phone);
    if (!p) return no("invalid_phone");
    const st = await load();
    const m = st.members.find((x) => x.phone_number === p);
    if (!m) return no("reset_unknown_phone");
    if (m.role === "Admin" || m.role === "Receptionist") return no("reset_staff");
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    resetCodes.set(p, { code, expires: Date.now() + RESET_TTL_MS });
    return { ...ok("reset_code_sent"), sms_code: code, token: "demo" };
  },

  async resetPassword({ phone, smsCode, password }) {
    const p = normalizePhone(phone);
    if (!p) return no("invalid_phone");
    const sent = resetCodes.get(p);
    if (!sent) return no("reset_bad_code");
    if (Date.now() > sent.expires) return no("reset_expired");
    if (sent.code !== smsCode) return no("reset_bad_code");
    if (password.length < MIN_PASSWORD) return no("weak_password");
    const st = await load();
    const m = st.members.find((x) => x.phone_number === p);
    if (!m) return no("reset_unknown_phone");
    const h = await hashPassword(password);
    Object.assign(m, { pw_salt: h.salt, pw_hash: h.hash });
    resetCodes.delete(p); // a code works once
    save(st);
    return ok("reset_done");
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
      .filter((s) => opts?.includeCancelled || !s.cancelled_at)
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
    // staff accounts are for running the gym, not for booking classes
    if (m.role === "Admin" || m.role === "Receptionist") return no("staff_cannot_book");
    const s = st.sessions.find((x) => x.session_id === sessionId);
    if (!s) return no("session_not_found");
    if (s.cancelled_at) return no("session_cancelled");
    if (new Date(s.start_time).getTime() <= Date.now()) return no("class_started");
    if (m.membership_status === "Suspended") return no("membership_suspended");
    if (m.membership_expiry < almatyYmd(s.start_time)) return no("membership_expired");
    const old = st.bookings.find((b) => b.member_id === m.member_id && b.session_id === sessionId);
    if (old && old.booking_status !== "Cancelled") return no("already_booked");
    // a member can't be in two classes at the same time
    const clash = st.bookings.some((b) => {
      if (b.member_id !== m.member_id || b.session_id === sessionId) return false;
      if (b.booking_status !== "Confirmed" && b.booking_status !== "Attended") return false;
      const o = st.sessions.find((x) => x.session_id === b.session_id)!;
      const ms = (iso: string) => new Date(iso).getTime();
      return ms(o.start_time) < ms(s.end_time) && ms(s.start_time) < ms(o.end_time);
    });
    if (clash) return no("time_conflict");
    if (taken(st, sessionId) >= s.capacity) return no("class_full");
    if (old) Object.assign(old, { booking_status: "Confirmed", booking_time: nowIso(), cancelled_at: null, fee_forfeited: false });
    else st.bookings.push({ booking_id: ++st.seq.bookings, member_id: m.member_id, session_id: sessionId, booking_status: "Confirmed",
      booking_time: nowIso(), cancelled_at: null, fee_forfeited: false });
    markBookedFromQueue(st, m.member_id, sessionId, (old ?? st.bookings[st.bookings.length - 1]).booking_id);
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
    if (late) {  // late-cancel pass (like the use_late_cancel_pass trigger): the fee is not taken
      const pass = st.redemptions.filter((r) => r.member_id === b.member_id && r.status === "Active"
        && st.rewards.find((w) => w.reward_id === r.reward_id)?.kind === "late_cancel_pass")
        .sort((x, y) => x.created_at.localeCompare(y.created_at))[0];
      if (pass) {
        b.fee_forfeited = false;
        Object.assign(pass, { status: "Used", used_at: nowIso(), used_booking_id: b.booking_id });
      }
    }
    promoteWaitlist(st, b.session_id);
    save(st);
    // the same code as cancel_booking() returns; the page checks fee_forfeited afterwards
    return ok(late ? "cancelled_fee_forfeited" : "cancelled");
  },

  async trainerRoster() {
    const st = await load();
    const m = me(st);
    if (m?.role !== "Trainer" || m.trainer_id === null) return [];
    const cutoff = Date.now() - 12 * 3600_000;
    const rows: RosterRow[] = [];
    for (const s of st.sessions.filter((x) => x.trainer_id === m.trainer_id && !x.cancelled_at && new Date(x.end_time).getTime() > cutoff)) {
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
    if (entity === "class_sessions") {
      // same rule as the protect_booked_session trigger in schema.sql
      const s = target as unknown as DSession;
      if (s.cancelled_at) return no("session_is_cancelled");
      const next = { ...target, ...row };
      const ms = (v: unknown) => new Date(String(v)).getTime();
      const moved = (["class_id", "room_id", "branch_id"] as const).some((k) => next[k] !== target[k])
        || ms(next.start_time) !== ms(s.start_time) || ms(next.end_time) !== ms(s.end_time);
      if (moved && taken(st, id) > 0) return no("session_has_bookings");
    }
    const before = entity === "class_sessions" ? Number(target.capacity) : 0;
    Object.assign(target, row);
    if (entity === "class_sessions" && Number(target.capacity) > before) promoteWaitlist(st, id);
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

  async cancelSession(sessionId) {
    const st = await load();
    if (!isAdmin(st)) return no("forbidden");
    const s = st.sessions.find((x) => x.session_id === sessionId);
    if (!s) return no("session_not_found");
    if (s.cancelled_at) return no("session_is_cancelled");
    if (new Date(s.start_time).getTime() <= Date.now()) return no("class_started");
    const at = nowIso();
    for (const b of st.bookings) {
      if (b.session_id === sessionId && b.booking_status === "Confirmed") {
        Object.assign(b, { booking_status: "Cancelled", cancelled_at: at, fee_forfeited: false });
      }
    }
    s.cancelled_at = at;
    promoteWaitlist(st, sessionId); // the class is cancelled: the queue expires
    save(st);
    return ok("session_cancelled_done");
  },

  async allBookings() {
    const st = await load();
    if (!isStaff(st)) return [];
    const cutoff = Date.now() - 12 * 3600_000;
    return visibleBookings(st)
      .filter((b) => b.booking_status !== "Cancelled" && new Date(b.end_time).getTime() > cutoff)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  },

  async listReaders() {
    const st = await load();
    if (!isStaff(st)) return [];
    return st.readers.map<Reader>((r) => ({ ...r, branch_name: st.branches.find((b) => b.branch_id === r.branch_id)?.branch_name ?? "" }));
  },

  async checkIn(bookingId, readerId) {
    const st = await load();
    if (!isStaff(st)) return no("admin_only");
    const b = st.bookings.find((x) => x.booking_id === bookingId);
    if (!b) return no("booking_not_found");
    if (b.booking_status === "Attended") return no("already_checked_in");
    if (b.booking_status !== "Confirmed") return no("not_checkinable");
    const r = st.readers.find((x) => x.reader_id === readerId);
    if (!r) return no("unknown_reader");
    const s = st.sessions.find((x) => x.session_id === b.session_id)!;
    if (r.branch_id !== s.branch_id) return no("wrong_branch_reader");
    if (new Date(s.start_time).getTime() - Date.now() > CHECKIN_OPENS_MS) return no("checkin_too_early");
    // both steps saved together (one transaction)
    st.checkIns.push({ check_in_id: ++st.seq.checkIns, booking_id: b.booking_id, reader_id: readerId, check_in_time: nowIso() });
    b.booking_status = "Attended";
    save(st);
    return ok("checked_in");
  },

  async manualCheckIn(bookingId) {
    const st = await load();
    if (!isStaff(st)) return no("admin_only");
    const b = st.bookings.find((x) => x.booking_id === bookingId);
    if (!b) return no("booking_not_found");
    if (b.booking_status === "Attended") return no("already_checked_in");
    if (b.booking_status !== "Confirmed" && b.booking_status !== "No-show") return no("not_checkinable");
    const s = st.sessions.find((x) => x.session_id === b.session_id)!;
    if (new Date(s.start_time).getTime() > Date.now()) return no("class_not_started");
    st.checkIns.push({ check_in_id: ++st.seq.checkIns, booking_id: b.booking_id, reader_id: null, is_manual: true, check_in_time: nowIso() });
    Object.assign(b, { booking_status: "Attended", fee_forfeited: false });
    save(st);
    return ok("checked_in_manual");
  },

  async attendanceReport() {
    const st = await load();
    if (!isAdmin(st)) return [];
    return st.sessions
      .filter((s) => !s.cancelled_at && new Date(s.end_time).getTime() < Date.now())
      .sort((a, b) => b.start_time.localeCompare(a.start_time))
      .slice(0, 100)
      .map<AttendanceRow>((s) => {
        const v = vSession(st, s);
        const bs = st.bookings.filter((b) => b.session_id === s.session_id);
        const count = (f: (status: string) => boolean) => bs.filter((b) => f(b.booking_status)).length;
        return {
          session_id: s.session_id, class_name: v.class_name, trainer_name: v.trainer_name, branch_name: v.branch_name,
          start_time: s.start_time, end_time: s.end_time, capacity: s.capacity,
          booked: count((x) => x !== "Cancelled"), attended: count((x) => x === "Attended"), no_show: count((x) => x === "No-show"),
        };
      });
  },
  // ---------- excused no-show (same rules as migration_excuse_no_show.sql) ----------
  async noShowBookings() {
    const st = await load();
    if (!isAdmin(st)) return [];
    const cutoff = Date.now() - 30 * 86400_000;
    return visibleBookings(st)
      .filter((b) => (b.booking_status === "No-show" || b.excuse_reason) && new Date(b.start_time).getTime() > cutoff)
      .sort((a, b) => b.start_time.localeCompare(a.start_time));
  },

  async excuseNoShow(bookingId, i) {
    const err = checkExcuse(i, { maxBytes: EXCUSE_DOC_MAX_BYTES, types: EXCUSE_DOC_TYPES });
    if (err) return no(err);
    const st = await load();
    if (!isAdmin(st)) return no("admin_only");
    const b = st.bookings.find((x) => x.booking_id === bookingId);
    if (!b) return no("booking_not_found");
    if (b.booking_status !== "No-show") return no("not_no_show");
    let path: string | null = null;
    if (i.file) {
      path = `${bookingId}/${Date.now()}.pdf`;
      st.files ??= {};
      // big files are only listed by name in demo mode, so the browser storage doesn't overflow
      if (i.file.size <= DEMO_FILE_LIMIT) st.files[path] = await fileToDataUrl(i.file);
    }
    const note = i.note.trim().slice(0, 500) || null;
    Object.assign(b, {
      booking_status: "Cancelled", fee_forfeited: false, cancelled_at: nowIso(),
      excuse_reason: i.reason, excuse_note: note, excuse_document: path, excused_at: nowIso(),
    });
    save(st);
    return ok("excused");
  },

  async excuseDocumentUrl(path) {
    const st = await load();
    const m = me(st);
    const b = st.bookings.find((x) => x.excuse_document === path);
    if (!m || !b || (m.role !== "Admin" && b.member_id !== m.member_id)) return null;
    return st.files?.[path] ?? null;
  },

  // ---------- trainer sign-up (same rules as migration_trainer_signup.sql) ----------
  async submitTrainerApplication(input, files) {
    const err = checkTrainerApplication(input, files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES });
    if (err) return no(err);
    const st = await load();
    const m = me(st);
    if (!m) return no("not_signed_in");
    if (m.role !== "Member") return no("already_trainer");
    st.applications ??= [];
    st.files ??= {};
    if (st.applications.some((a) => a.member_id === m.member_id && a.status !== "Rejected")) return no("application_exists");

    const certs: CertificateFile[] = [];
    for (const f of files) {
      const path = `demo/${m.member_id}/${Date.now()}-${certs.length}`;
      // big files are only listed by name in demo mode, so the browser storage doesn't overflow
      if (f.size <= DEMO_FILE_LIMIT) st.files[path] = await readAsDataUrl(f);
      certs.push({ path, name: f.name.slice(0, 120) });
    }
    st.seq.applications = (st.seq.applications ?? 0) + 1;
    st.applications.push({
      application_id: st.seq.applications, member_id: m.member_id, email: input.email.trim(),
      specialization: input.specialization.trim(), experience_years: input.experience_years, bio: input.bio.trim(),
      certificates: certs, status: "Pending", reject_reason: null, created_at: nowIso(), reviewed_at: null, trainer_id: null,
    });
    save(st);
    return ok("application_sent");
  },

  async updateTrainerApplication(input, keep, files) {
    const err = checkTrainerApplication(input, files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES }, keep.length);
    if (err) return no(err);
    const st = await load();
    const m = me(st);
    if (!m) return no("not_signed_in");
    const app = (st.applications ?? []).find((a) => a.member_id === m.member_id && a.status === "Pending");
    if (!app) return no("application_not_pending");
    // only certificates that really belong to this application can be kept
    if (keep.some((k) => !app.certificates.some((c) => c.path === k.path))) return no("invalid_value");
    st.files ??= {};
    const certs: CertificateFile[] = [...keep];
    for (const f of files) {
      const path = `demo/${m.member_id}/${Date.now()}-${certs.length}`;
      if (f.size <= DEMO_FILE_LIMIT) st.files[path] = await readAsDataUrl(f);
      certs.push({ path, name: f.name.slice(0, 120) });
    }
    for (const c of app.certificates) if (!certs.some((k) => k.path === c.path)) delete st.files[c.path]; // removed files
    Object.assign(app, {
      email: input.email.trim(), specialization: input.specialization.trim(), experience_years: input.experience_years,
      bio: input.bio.trim(), certificates: certs, created_at: nowIso(),
    });
    save(st);
    return ok("application_updated");
  },

  async myTrainerApplication() {
    const st = await load();
    const m = me(st);
    if (!m) return null;
    const mine = (st.applications ?? []).filter((a) => a.member_id === m.member_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return mine[0] ? vApplication(st, mine[0]) : null;
  },

  async listTrainerApplications() {
    const st = await load();
    if (!isAdmin(st)) return [];
    return (st.applications ?? []).map((a) => vApplication(st, a))
      .sort((a, b) => Number(b.status === "Pending") - Number(a.status === "Pending") || b.created_at.localeCompare(a.created_at));
  },

  async certificateUrl(path) {
    const st = await load();
    const m = me(st);
    const owner = (st.applications ?? []).find((a) => a.certificates.some((c) => c.path === path));
    if (!m || !owner || (m.role !== "Admin" && owner.member_id !== m.member_id)) return null;
    return st.files?.[path] ?? null;
  },

  async reviewTrainerApplication(id, approve, reason) {
    const st = await load();
    if (!isAdmin(st)) return no("admin_only");
    const a = (st.applications ?? []).find((x) => x.application_id === id);
    if (!a) return no("application_not_found");
    if (a.status !== "Pending") return no("application_not_pending");
    if (!approve) {
      Object.assign(a, { status: "Rejected", reject_reason: reason?.trim() || null, reviewed_at: nowIso() });
      save(st);
      return ok("application_rejected");
    }
    const m = st.members.find((x) => x.member_id === a.member_id)!;
    if (m.role !== "Member") return no("already_trainer");
    const trainerId = ++st.seq.trainers;
    st.trainers.push({ trainer_id: trainerId, trainer_name: `${m.member_name} ${m.member_surname}`, phone: m.phone_number, email: a.email });
    Object.assign(m, { role: "Trainer", trainer_id: trainerId });
    Object.assign(a, { status: "Approved", reviewed_at: nowIso(), trainer_id: trainerId });
    save(st);
    return ok("application_approved");
  },
  // ---------- Pulse points and rewards (same rules as migration_points_rewards.sql) ----------
  async myPoints() {
    const st = await load();
    const m = me(st);
    return m ? summaryFor(st, m.member_id) : null;
  },

  async myPointsHistory() {
    const st = await load();
    const m = me(st);
    return m ? ledgerFor(st, m.member_id).slice(0, 30) : [];
  },

  async leaderboard() {
    const st = await load();
    const m = me(st);
    if (!m) return null;
    const month = monthStartIso();
    const rows = st.members.filter((x) => x.role === "Member" || x.role === "Trainer")
      .map((x) => ({ x, points: ledgerFor(st, x.member_id)
        .filter((e) => e.created_at >= month && e.reason !== "redeem" && e.reason !== "redeem_refund")
        .reduce((a, e) => a + e.delta, 0) }))
      .filter((r) => r.points > 0)
      .sort((a, b) => b.points - a.points);
    const ranked = rows.map((r) => ({ ...r, place: rows.findIndex((o) => o.points === r.points) + 1 }));
    const mine = ranked.find((r) => r.x.member_id === m.member_id);
    return {
      top: ranked.slice(0, 10).map((r) => ({ place: r.place, name: `${r.x.member_name} ${r.x.member_surname.slice(0, 1)}.`,
        points: r.points, is_me: r.x.member_id === m.member_id })),
      me: mine ? { place: mine.place, points: mine.points } : null,
    };
  },

  async listRewards() {
    const st = await load();
    return st.rewards.filter((r) => r.active).sort((a, b) => a.cost - b.cost);
  },

  async redeemReward(rewardId) {
    const st = await load();
    const m = me(st);
    if (!m) return no("not_signed_in");
    if (m.role === "Admin" || m.role === "Receptionist") return no("staff_cannot_redeem");
    const w = st.rewards.find((x) => x.reward_id === rewardId);
    if (!w || !w.active) return no("reward_unavailable");
    if (w.stock !== null && w.stock <= 0) return no("out_of_stock");
    const activePass = st.redemptions.some((r) => r.member_id === m.member_id && r.status === "Active"
      && st.rewards.find((x) => x.reward_id === r.reward_id)?.kind === "late_cancel_pass");
    if (w.kind === "late_cancel_pass" && activePass) return no("pass_already_active");
    if (summaryFor(st, m.member_id).balance < w.cost) return no("not_enough_points");
    let code = "";
    do code = "PG-" + Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");
    while (st.redemptions.some((r) => r.code === code));
    const r: DRedemption = { redemption_id: ++st.seq.redemptions, member_id: m.member_id, reward_id: w.reward_id, cost: w.cost,
      code, status: "Active", created_at: nowIso(), used_at: null, cancelled_at: null };
    st.redemptions.push(r);
    if (w.stock !== null) w.stock -= 1;
    if (w.kind === "membership_days") {  // applied at once
      const from = m.membership_expiry > todayYmd() ? m.membership_expiry : todayYmd();
      m.membership_expiry = new Date(Date.parse(from + "T00:00:00Z") + (w.extend_days ?? 0) * 86400_000).toISOString().slice(0, 10);
      Object.assign(r, { status: "Used", used_at: nowIso() });
    }
    save(st);
    return { ok: true, code: "redeemed", redemption_code: code };
  },

  async myRedemptions() {
    const st = await load();
    const m = me(st);
    if (!m) return [];
    return st.redemptions.filter((r) => r.member_id === m.member_id).map((r) => vRedemption(st, r))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async cancelRedemption(redemptionId) {
    const st = await load();
    const m = me(st);
    const r = st.redemptions.find((x) => x.redemption_id === redemptionId && (x.member_id === m?.member_id || isStaff(st)));
    if (!r) return no("redemption_not_found");
    if (r.status !== "Active") return no("redemption_not_active");
    Object.assign(r, { status: "Cancelled", cancelled_at: nowIso() });
    const w = st.rewards.find((x) => x.reward_id === r.reward_id);
    if (w && w.stock !== null) w.stock += 1;
    save(st);
    return ok("redemption_cancelled");
  },

  async staffRedemptions() {
    const st = await load();
    if (!isStaff(st)) return [];
    return st.redemptions.map((r) => vRedemption(st, r))
      .sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active") || b.created_at.localeCompare(a.created_at));
  },

  async useRedemption(redemptionId) {
    const st = await load();
    if (!isStaff(st)) return no("staff_only");
    const r = st.redemptions.find((x) => x.redemption_id === redemptionId);
    if (!r) return no("redemption_not_found");
    if (r.status !== "Active") return no("redemption_not_active");
    const kind = st.rewards.find((x) => x.reward_id === r.reward_id)?.kind;
    if (kind !== "free_class" && kind !== "merch") return no("redemption_auto");
    Object.assign(r, { status: "Used", used_at: nowIso() });
    save(st);
    return ok("redemption_used");
  },

  // ---------- waitlist (same rules as migration_waitlist.sql) ----------
  async waitlistCounts() {
    const st = await load();
    const out: Record<number, number> = {};
    for (const w of st.waitlist) {
      const s = st.sessions.find((x) => x.session_id === w.session_id);
      if (w.status !== "Waiting" || !s || s.cancelled_at || new Date(s.start_time).getTime() - Date.now() < WAITLIST_CLOSES_MS) continue;
      out[w.session_id] = (out[w.session_id] ?? 0) + 1;
    }
    return out;
  },

  async myWaitlist() {
    const st = await load();
    const m = me(st);
    if (!m) return [];
    return st.waitlist.filter((w) => w.member_id === m.member_id).map((w) => {
      const s = st.sessions.find((x) => x.session_id === w.session_id)!;
      const v = vSession(st, s);
      const closed = !!s.cancelled_at || new Date(s.start_time).getTime() - Date.now() < WAITLIST_CLOSES_MS;
      const queue = st.waitlist.filter((q) => q.session_id === w.session_id && q.status === "Waiting")
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.entry_id - b.entry_id);
      return { entry_id: w.entry_id, session_id: w.session_id, booking_id: w.booking_id,
        status: w.status === "Waiting" && closed ? "Expired" : w.status, promoted_auto: w.promoted_auto, status_reason: w.status_reason,
        position: w.status === "Waiting" ? queue.findIndex((q) => q.entry_id === w.entry_id) + 1 : null,
        created_at: w.created_at, updated_at: w.updated_at, class_name: v.class_name, trainer_name: v.trainer_name,
        branch_name: v.branch_name, room_name: v.room_name, start_time: s.start_time, end_time: s.end_time } as WaitlistEntry;
    }).sort((a, b) => b.start_time.localeCompare(a.start_time));
  },

  async joinWaitlist(sessionId) {
    const st = await load();
    const m = me(st);
    if (!m) return no("not_signed_in");
    if (m.role === "Admin" || m.role === "Receptionist") return no("staff_cannot_book");
    const s = st.sessions.find((x) => x.session_id === sessionId);
    if (!s) return no("session_not_found");
    if (s.cancelled_at) return no("session_cancelled");
    if (new Date(s.start_time).getTime() - Date.now() < WAITLIST_CLOSES_MS) return no("waitlist_closed");
    if (m.membership_status === "Suspended") return no("membership_suspended");
    if (m.membership_expiry < almatyYmd(s.start_time)) return no("membership_expired");
    if (st.bookings.some((b) => b.member_id === m.member_id && b.session_id === sessionId
      && (b.booking_status === "Confirmed" || b.booking_status === "Attended"))) return no("already_booked");
    if (st.waitlist.some((w) => w.member_id === m.member_id && w.session_id === sessionId && w.status === "Waiting")) return no("already_waiting");
    const clash = st.bookings.some((b) => {
      if (b.member_id !== m.member_id || (b.booking_status !== "Confirmed" && b.booking_status !== "Attended")) return false;
      const o = st.sessions.find((x) => x.session_id === b.session_id)!;
      return new Date(o.start_time) < new Date(s.end_time) && new Date(s.start_time) < new Date(o.end_time);
    });
    if (clash) return no("time_conflict");
    if (taken(st, sessionId) < s.capacity) return no("has_free_places");
    const mine = st.waitlist.filter((w) => w.member_id === m.member_id && w.status === "Waiting"
      && new Date(st.sessions.find((x) => x.session_id === w.session_id)!.start_time).getTime() > Date.now());
    if (mine.length >= WAITLIST_MAX) return no("waitlist_limit");
    st.waitlist.push({ entry_id: ++st.seq.waitlist, session_id: sessionId, member_id: m.member_id, status: "Waiting",
      promoted_auto: false, status_reason: null, booking_id: null, created_at: nowIso(), updated_at: nowIso() });
    save(st);
    const position = st.waitlist.filter((w) => w.session_id === sessionId && w.status === "Waiting").length;
    return { ok: true, code: "waitlist_joined", position };
  },

  async leaveWaitlist(sessionId) {
    const st = await load();
    const m = me(st);
    const w = st.waitlist.find((x) => x.member_id === m?.member_id && x.session_id === sessionId && x.status === "Waiting");
    if (!w) return no("not_waiting");
    Object.assign(w, { status: "Left", updated_at: nowIso() });
    save(st);
    return ok("waitlist_left");
  },

  // ---------- reviews (same rules as migration_reviews.sql) ----------
  async trainerRatings() {
    const st = await load();
    return st.trainers.map<TrainerRating>((t) => {
      const rs = st.reviews.filter((r) => r.trainer_id === t.trainer_id);
      return { trainer_id: t.trainer_id, trainer_name: t.trainer_name, reviews_count: rs.length,
        avg_rating: rs.length ? Math.round((rs.reduce((a, r) => a + r.rating, 0) / rs.length) * 10) / 10 : 0 };
    }).filter((r) => r.reviews_count > 0);
  },

  async myReviews() {
    const st = await load();
    const m = me(st);
    if (!m) return [];
    return st.reviews.filter((r) => r.member_id === m.member_id).map<MyReview>((r) => ({ review_id: r.review_id, booking_id: r.booking_id,
      rating: r.rating, comment: r.comment, created_at: r.created_at, updated_at: r.updated_at }));
  },

  async submitReview(bookingId, rating, comment) {
    const st = await load();
    const m = me(st);
    const b = st.bookings.find((x) => x.booking_id === bookingId && x.member_id === m?.member_id);
    if (!m || !b) return no("booking_not_found");
    if (b.booking_status !== "Attended") return no("review_not_attended");
    const s = st.sessions.find((x) => x.session_id === b.session_id)!;
    const end = new Date(s.end_time).getTime();
    if (end > Date.now()) return no("review_too_early");
    if (Date.now() - end > REVIEW_WINDOW_DAYS * 86400_000) return no("review_too_late");
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return no("invalid_rating");
    const text = comment.trim() || null;
    if (text && text.length > REVIEW_MAX_CHARS) return no("invalid_value");
    const old = st.reviews.find((r) => r.booking_id === bookingId);
    if (old) Object.assign(old, { rating, comment: text, updated_at: nowIso() });
    else st.reviews.push({ review_id: ++st.seq.reviews, booking_id: bookingId, member_id: m.member_id, session_id: s.session_id,
      trainer_id: s.trainer_id, rating, comment: text, created_at: nowIso(), updated_at: nowIso() });
    const first = !old && !st.reviewPoints[bookingId];   // points once per class
    if (first) st.reviewPoints[bookingId] = { given: nowIso() };
    save(st);
    return ok(first ? "review_saved_points" : "review_saved");
  },

  async listReviews() {
    const st = await load();
    const m = me(st);
    if (!m) return [];
    const admin = m.role === "Admin";
    if (!admin && !(m.role === "Trainer" && m.trainer_id !== null)) return [];
    return st.reviews.filter((r) => admin || r.trainer_id === m.trainer_id).map<Review>((r) => {
      const s = st.sessions.find((x) => x.session_id === r.session_id)!;
      const who = st.members.find((x) => x.member_id === r.member_id);
      return { review_id: r.review_id, rating: r.rating, comment: r.comment, created_at: r.created_at, updated_at: r.updated_at,
        trainer_id: r.trainer_id, trainer_name: st.trainers.find((t) => t.trainer_id === r.trainer_id)?.trainer_name ?? "",
        class_name: st.classes.find((c) => c.class_id === s.class_id)?.class_name ?? "", start_time: s.start_time,
        member_fullname: admin && who ? `${who.member_name} ${who.member_surname}` : null };
    }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async deleteReview(reviewId) {
    const st = await load();
    if (!isAdmin(st)) return no("admin_only");
    const i = st.reviews.findIndex((r) => r.review_id === reviewId);
    if (i < 0) return no("review_not_found");
    const [r] = st.reviews.splice(i, 1);
    const rp = st.reviewPoints[r.booking_id];
    if (rp && !rp.removed) rp.removed = nowIso();
    save(st);
    return ok("review_deleted");
  },
};
