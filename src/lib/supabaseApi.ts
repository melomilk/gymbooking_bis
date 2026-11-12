import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Api, AttendanceRow, BookingRow, CertificateFile, Entity, Result, Row, TrainerApplication } from "./types";
import { CERT_MAX_BYTES, CERT_MAX_FILES, CERT_TYPES, ENTITY_ID } from "./types";
import { checkTrainerApplication, cleanQuery, MIN_PASSWORD, normalizePhone, phoneToAuthEmail, validName } from "./validate";

const CERT_BUCKET = "trainer-certificates";

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string);
  }
  return client;
}

/** Postgres / PostgREST error -> translatable code */
export function dbErrorCode(e: { code?: string; message?: string } | null): string {
  const m = e?.message ?? "";
  for (const c of ["capacity_exceeds_room", "capacity_below_bookings", "cannot_demote_self", "cannot_change_login"]) {
    if (m.includes(c)) return c;
  }
  switch (e?.code) {
    case "23P01": return m.includes("trainer") ? "trainer_overlap" : "room_overlap";
    case "23503": return "in_use";
    case "23505": return "duplicate";
    case "23514":
      if (m.includes("class_sessions_check")) return "invalid_time";
      if (m.includes("members_check")) return "trainer_needs_link";
      return "invalid_value";
    case "23502": return "required";
    case "42501": return "forbidden";
    case "22P02": case "22007": case "22008": return "invalid_value";
  }
  return "error";
}

const fail = (e: { code?: string; message?: string } | null): Result => ({ ok: false, code: dbErrorCode(e), message: e?.message });

/** Turns past 'Confirmed' bookings into 'No-show' before any booking list is read. */
async function markNoShows() {
  await sb().rpc("mark_no_shows"); // errors ignored: reading must still work
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) return fail(error);
  return data as Result;
}

const now = () => new Date().toISOString();

/** Per-minute sign-up limit (migration_signup_rate_limit.sql). Without the migration: never limited. */
async function signupRateLimited(): Promise<Result | null> {
  const { data, error } = await sb().rpc("signup_rate_status");
  const st = data as { allowed?: boolean; retry_after?: number } | null;
  if (error || !st || st.allowed !== false) return null;
  return { ok: false, code: "rate_limited", retry_after: st.retry_after ?? 60 };
}

export const supabaseApi: Api = {
  mode: "supabase",

  async getMe() {
    const { data: s } = await sb().auth.getSession();
    if (!s.session) return null;
    const { data } = await sb().from("v_me").select("*").maybeSingle();
    return data ?? null;
  },

  async register({ name, surname, phone, password, lang }) {
    const p = normalizePhone(phone);
    if (!validName(name) || !validName(surname)) return { ok: false, code: "invalid_name" };
    if (!p) return { ok: false, code: "invalid_phone" };
    if (password.length < MIN_PASSWORD) return { ok: false, code: "weak_password" };

    const limited = await signupRateLimited();
    if (limited) return limited;

    // Preferred path: server route creates a confirmed user with the service key.
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, surname, phone: p, password, lang }),
    }).catch(() => null);
    const body: (Result & { fallback?: boolean }) | null = res ? await res.json().catch(() => null) : null;

    if (body && !body.fallback) {
      if (!body.ok) return body;
    } else {
      // No service key configured: plain sign-up (requires "Confirm email" OFF in Supabase).
      const { error } = await sb().auth.signUp({
        email: phoneToAuthEmail(p),
        password,
        options: { data: { member_name: name.trim(), member_surname: surname.trim(), phone_number: p, preferred_language: lang } },
      });
      if (error) {
        const late = await signupRateLimited(); // the database trigger refused the user
        if (late) return late;
        const msg = error.message.toLowerCase();
        if (msg.includes("already") || error.code === "user_already_exists") return { ok: false, code: "phone_taken" };
        if (msg.includes("password")) return { ok: false, code: "weak_password" };
        if (msg.includes("database error")) return { ok: false, code: "phone_taken" };
        return { ok: false, code: "error", message: error.message };
      }
    }
    // log the new member in (FR-04: "the member is logged in")
    return supabaseApi.login(p, password);
  },

  async login(phone, password) {
    const p = normalizePhone(phone);
    if (!p) return { ok: false, code: "bad_credentials" };
    const { error } = await sb().auth.signInWithPassword({ email: phoneToAuthEmail(p), password });
    return error ? { ok: false, code: "bad_credentials" } : { ok: true, code: "saved" };
  },

  async logout() {
    await sb().auth.signOut();
  },

  async setLanguage(lang) {
    await sb().rpc("set_my_language", { p_lang: lang });
  },

  async listBranches() {
    const { data } = await sb().from("branches").select("*").order("branch_name");
    return data ?? [];
  },

  async listSessions(opts) {
    let q = sb().from("v_sessions").select("*").order("start_time");
    if (!opts?.includePast) q = q.gt("start_time", now());
    const { data } = await q;
    return data ?? [];
  },

  async searchTrainers(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    const { data } = await sb().from("v_trainers").select("*").ilike("trainer_name", `%${c}%`).order("trainer_name");
    return data ?? [];
  },

  async searchBranches(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    const { data } = await sb().from("branches").select("*")
      .or(`branch_name.ilike.*${c}*,address.ilike.*${c}*`).order("branch_name");
    return data ?? [];
  },

  async myBookings(memberId) {
    await markNoShows();
    const { data } = await sb().from("v_bookings").select("*").eq("member_id", memberId).order("start_time", { ascending: false });
    return (data ?? []) as BookingRow[];
  },

  async searchBookings(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    await markNoShows();
    // v_bookings itself limits members to their own rows (admins see all)
    const { data } = await sb().from("v_bookings").select("*")
      .or(`class_name.ilike.*${c}*,trainer_name.ilike.*${c}*,branch_name.ilike.*${c}*,member_fullname.ilike.*${c}*`)
      .order("start_time", { ascending: false }).limit(50);
    return (data ?? []) as BookingRow[];
  },

  book: (sessionId) => rpc("book_session", { p_session_id: sessionId }),
  cancel: (bookingId, acceptFee = false) => rpc("cancel_booking", { p_booking_id: bookingId, p_accept_fee: acceptFee }),

  async trainerRoster() {
    await markNoShows();
    const { data } = await sb().from("v_trainer_roster").select("*")
      .gt("end_time", new Date(Date.now() - 12 * 3600_000).toISOString()).order("start_time");
    return data ?? [];
  },

  async adminList(entity: Entity) {
    const { data } = await sb().from(entity).select("*").order(ENTITY_ID[entity]);
    return (data ?? []) as Row[];
  },

  async adminInsert(entity, row) {
    const { error } = await sb().from(entity).insert(row).select();
    return error ? fail(error) : { ok: true, code: "created" };
  },

  async adminUpdate(entity, id, row) {
    const { data, error } = await sb().from(entity).update(row).eq(ENTITY_ID[entity], id).select();
    if (error) return fail(error);
    return data && data.length ? { ok: true, code: "updated" } : { ok: false, code: "forbidden" };
  },

  async adminDelete(entity, id) {
    const { data, error } = await sb().from(entity).delete().eq(ENTITY_ID[entity], id).select();
    if (error) return fail(error);
    return data && data.length ? { ok: true, code: "deleted" } : { ok: false, code: "forbidden" };
  },

  async allBookings() {
    await markNoShows();
    const { data } = await sb().from("v_bookings").select("*")
      .in("booking_status", ["Confirmed", "Attended", "No-show"])
      .gt("end_time", new Date(Date.now() - 12 * 3600_000).toISOString())
      .order("start_time");
    return (data ?? []) as BookingRow[];
  },

  async listReaders() {
    const { data } = await sb().from("v_readers").select("*").order("reader_id");
    return data ?? [];
  },

  checkIn: (bookingId, readerId) => rpc("check_in_booking", { p_booking_id: bookingId, p_reader_id: readerId }),
  manualCheckIn: (bookingId) => rpc("manual_check_in", { p_booking_id: bookingId }),

  async attendanceReport() {
    await markNoShows(); // so finished classes already show their no-shows
    const { data } = await sb().from("v_attendance_report").select("*")
      .lt("end_time", now()).order("start_time", { ascending: false }).limit(100);
    return (data ?? []) as AttendanceRow[];
  },

  // ---------- trainer sign-up ----------
  async submitTrainerApplication(input, files) {
    const err = checkTrainerApplication(input, files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES });
    if (err) return { ok: false, code: err };
    const { data: u } = await sb().auth.getUser();
    if (!u.user) return { ok: false, code: "not_signed_in" };

    // 1) files -> private bucket, folder = auth uid (checked by the storage policy and by the function)
    const uploaded: CertificateFile[] = [];
    for (const f of files) {
      const ext = (f.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
      const path = `${u.user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error } = await sb().storage.from(CERT_BUCKET).upload(path, f, { contentType: f.type, upsert: false });
      if (error) return { ok: false, code: "upload_failed", message: error.message };
      uploaded.push({ path, name: f.name.slice(0, 120) });
    }
    // 2) the application row
    return rpc("submit_trainer_application", {
      p_email: input.email.trim(), p_specialization: input.specialization.trim(),
      p_experience_years: input.experience_years, p_bio: input.bio.trim(), p_certificates: uploaded,
    });
  },

  async myTrainerApplication() {
    const { data: s } = await sb().auth.getSession();
    if (!s.session) return null;
    const me = await supabaseApi.getMe();
    if (!me) return null;
    const { data } = await sb().from("v_trainer_applications").select("*")
      .eq("member_id", me.member_id).order("created_at", { ascending: false }).limit(1);
    return ((data ?? [])[0] as TrainerApplication | undefined) ?? null;
  },

  async listTrainerApplications() {
    const { data } = await sb().from("v_trainer_applications").select("*").order("created_at", { ascending: false });
    const rows = (data ?? []) as TrainerApplication[];
    return rows.sort((a, b) => Number(b.status === "Pending") - Number(a.status === "Pending"));
  },

  async certificateUrl(path) {
    const { data } = await sb().storage.from(CERT_BUCKET).createSignedUrl(path, 300);
    return data?.signedUrl ?? null;
  },

  reviewTrainerApplication: (id, approve, reason) =>
    rpc("review_trainer_application", { p_application_id: id, p_approve: approve, p_reason: reason ?? null }),
};
