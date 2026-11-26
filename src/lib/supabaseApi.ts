import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type {
  Api, AttendanceRow, BookingRow, CertificateFile, Entity, Leaderboard, MyReview, PointsEntry, PointsSummary, Redemption,
  ResetRequest, Result, Review, Reward, Row, SessionRow, TrainerApplication, TrainerRating, WaitlistEntry,
  ClassTypeOption, RoomOption, SessionRequest, ClubNow, ClubVisit, MemberLookup, PublicProfile, BuddyInvite,
} from "./types";
import { CERT_MAX_BYTES, CERT_MAX_FILES, CERT_TYPES, ENTITY_ID, EXCUSE_DOC_MAX_BYTES, EXCUSE_DOC_TYPES } from "./types";
import { checkExcuse, checkTrainerApplication, cleanQuery, MIN_PASSWORD, normalizePhone, phoneToAuthEmail, validName } from "./validate";

const CERT_BUCKET = "trainer-certificates";
const EXCUSE_BUCKET = "excuse-documents";

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
  for (const c of ["capacity_exceeds_room", "capacity_below_bookings", "cannot_demote_self", "cannot_change_login",
    "session_has_bookings", "session_is_cancelled"]) {
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

/** Uploads certificates to the private bucket, folder = auth uid (checked by the storage policy and by the functions). */
async function uploadCertificates(files: File[]): Promise<Result & { uploaded: CertificateFile[] }> {
  const { data: u } = await sb().auth.getUser();
  if (!u.user) return { ok: false, code: "not_signed_in", uploaded: [] };
  const uploaded: CertificateFile[] = [];
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
    const path = `${u.user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const { error } = await sb().storage.from(CERT_BUCKET).upload(path, f, { contentType: f.type, upsert: false });
    if (error) return { ok: false, code: "upload_failed", message: error.message, uploaded };
    uploaded.push({ path, name: f.name.slice(0, 120) });
  }
  return { ok: true, code: "uploaded", uploaded };
}

/** /api/reset-password: runs on the server, where the service key can change a password. */
async function resetCall(body: Record<string, unknown>): Promise<ResetRequest> {
  const res = await fetch("/api/reset-password", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  const data = res ? ((await res.json().catch(() => null)) as ResetRequest | null) : null;
  return data ?? { ok: false, code: "error" };
}

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
    if (!p) return { ok: false, code: "invalid_phone" }; // not a phone number at all: say so
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
    const rows = (data ?? []) as SessionRow[];
    // filtered here, not in the query, so the schedule still works before migration_session_cancel.sql is run
    return opts?.includeCancelled ? rows : rows.filter((s) => !s.cancelled_at);
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
  renewMembership: (months) => rpc("renew_membership", { p_months: months }),

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

  cancelSession: (sessionId) => rpc("cancel_session", { p_session_id: sessionId }),

  requestPasswordReset: (phone) => resetCall({ action: "send", phone }),
  resetPassword: ({ phone, token, smsCode, password }) => resetCall({ action: "confirm", phone, token, sms_code: smsCode, password }),

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

  // ---------- excused no-show (migration_excuse_no_show.sql) ----------
  async noShowBookings() {
    await markNoShows();
    const { data } = await sb().from("v_bookings").select("*")
      .or("booking_status.eq.No-show,excuse_reason.not.is.null")
      .gt("start_time", new Date(Date.now() - 30 * 86400_000).toISOString())
      .order("start_time", { ascending: false }).limit(200);
    return (data ?? []) as BookingRow[];
  },

  async excuseNoShow(bookingId, i) {
    const err = checkExcuse(i, { maxBytes: EXCUSE_DOC_MAX_BYTES, types: EXCUSE_DOC_TYPES });
    if (err) return { ok: false, code: err };
    let path: string | null = null;
    if (i.file) {
      // folder = booking id (the function checks it)
      path = `${bookingId}/${Date.now()}-${crypto.randomUUID()}.pdf`;
      const { error } = await sb().storage.from(EXCUSE_BUCKET).upload(path, i.file, { contentType: "application/pdf", upsert: false });
      if (error) return { ok: false, code: "upload_failed", message: error.message };
    }
    const r = await rpc("excuse_no_show", { p_booking_id: bookingId, p_reason: i.reason, p_note: i.note, p_document: path });
    // refused (e.g. not a no-show any more): don't leave an orphan file behind
    if (!r.ok && path) await sb().storage.from(EXCUSE_BUCKET).remove([path]);
    return r;
  },

  async excuseDocumentUrl(path) {
    const { data } = await sb().storage.from(EXCUSE_BUCKET).createSignedUrl(path, 300);
    return data?.signedUrl ?? null;
  },

  // ---------- trainer sign-up ----------
  async submitTrainerApplication(input, files) {
    const err = checkTrainerApplication(input, files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES });
    if (err) return { ok: false, code: err };
    // 1) files -> private bucket, 2) the application row
    const up = await uploadCertificates(files);
    if (!up.ok) return up;
    return rpc("submit_trainer_application", {
      p_email: input.email.trim(), p_specialization: input.specialization.trim(),
      p_experience_years: input.experience_years, p_bio: input.bio.trim(), p_certificates: up.uploaded,
    });
  },

  async updateTrainerApplication(input, keep, files) {
    const err = checkTrainerApplication(input, files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES }, keep.length);
    if (err) return { ok: false, code: err };
    const up = await uploadCertificates(files);
    if (!up.ok) return up;
    return rpc("update_trainer_application", {
      p_email: input.email.trim(), p_specialization: input.specialization.trim(),
      p_experience_years: input.experience_years, p_bio: input.bio.trim(), p_certificates: [...keep, ...up.uploaded],
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
    // 1 hour: the admin page prepares the links when it opens (bug 18)
    const { data } = await sb().storage.from(CERT_BUCKET).createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  },

  reviewTrainerApplication: (id, approve, reason) =>
    rpc("review_trainer_application", { p_application_id: id, p_approve: approve, p_reason: reason ?? null }),

  // ---------- Pulse points and rewards (migration_points_rewards.sql) ----------
  // A missing migration shows up as an error here; the pages then just show nothing.
  async myPoints() {
    const { data, error } = await sb().rpc("my_points");
    return error || !data ? null : (data as PointsSummary);
  },

  async myPointsHistory() {
    const { data } = await sb().from("v_my_points_history").select("*")
      .order("created_at", { ascending: false }).order("entry_id", { ascending: false }).limit(30);
    return (data ?? []) as PointsEntry[];
  },

  async leaderboard() {
    const { data, error } = await sb().rpc("points_leaderboard", { p_limit: 10 });
    return error || !data ? null : (data as Leaderboard);
  },

  async listRewards() {
    const { data } = await sb().from("rewards").select("*").eq("active", true).order("cost");
    return (data ?? []) as Reward[];
  },

  redeemReward: (rewardId) => rpc("redeem_reward", { p_reward_id: rewardId }),

  async myRedemptions() {
    const me = await supabaseApi.getMe();
    if (!me) return [];
    const { data } = await sb().from("v_redemptions").select("*").eq("member_id", me.member_id)
      .order("created_at", { ascending: false });
    return (data ?? []) as Redemption[];
  },

  cancelRedemption: (redemptionId) => rpc("cancel_redemption", { p_redemption_id: redemptionId }),

  async staffRedemptions() {
    const { data } = await sb().from("v_redemptions").select("*").order("created_at", { ascending: false }).limit(200);
    const rows = (data ?? []) as Redemption[];
    return rows.sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active"));
  },

  useRedemption: (redemptionId) => rpc("use_redemption", { p_redemption_id: redemptionId }),

  // ---------- waitlist (migration_waitlist.sql) ----------
  async waitlistCounts() {
    const { data } = await sb().from("v_waitlist_counts").select("*");
    const out: Record<number, number> = {};
    for (const r of (data ?? []) as { session_id: number; waiting: number }[]) out[r.session_id] = r.waiting;
    return out;
  },

  async myWaitlist() {
    const { data: s } = await sb().auth.getSession();
    if (!s.session) return [];
    const { data } = await sb().from("v_my_waitlist").select("*").order("start_time", { ascending: false }).limit(50);
    return (data ?? []) as WaitlistEntry[];
  },

  joinWaitlist: (sessionId) => rpc("join_waitlist", { p_session_id: sessionId }),
  leaveWaitlist: (sessionId) => rpc("leave_waitlist", { p_session_id: sessionId }),

  // ---------- reviews (migration_reviews.sql) ----------
  async trainerRatings() {
    const { data } = await sb().from("v_trainer_ratings").select("*");
    return (data ?? []) as TrainerRating[];
  },

  async myReviews() {
    const { data: s } = await sb().auth.getSession();
    if (!s.session) return [];
    const { data } = await sb().from("v_my_reviews").select("*");
    return (data ?? []) as MyReview[];
  },

  submitReview: (bookingId, rating, comment) =>
    rpc("submit_review", { p_booking_id: bookingId, p_rating: rating, p_comment: comment }),

  async listReviews() {
    const { data } = await sb().from("v_reviews").select("*").order("created_at", { ascending: false }).limit(200);
    return (data ?? []) as Review[];
  },

  deleteReview: (reviewId) => rpc("delete_review", { p_review_id: reviewId }),

  // ---------- trainer class requests (migration_session_requests.sql) ----------
  async requestOptions() {
    const [c, r] = await Promise.all([
      sb().from("v_class_types").select("*").order("class_name"),
      sb().from("v_rooms").select("*").order("branch_name").order("room_name"),
    ]);
    return { classes: (c.data ?? []) as ClassTypeOption[], rooms: (r.data ?? []) as RoomOption[] };
  },

  async listSessionRequests() {
    const { data } = await sb().from("v_session_requests").select("*").order("created_at", { ascending: false }).limit(200);
    const rows = (data ?? []) as SessionRequest[];
    return rows.sort((a, b) => Number(b.status === "Pending") - Number(a.status === "Pending"));
  },

  submitSessionRequest: (i) => rpc("submit_session_request", {
    p_class_id: i.class_id, p_room_id: i.room_id, p_start_time: i.start_time, p_capacity: i.capacity, p_note: i.note,
  }),
  withdrawSessionRequest: (id) => rpc("withdraw_session_request", { p_request_id: id }),
  reviewSessionRequest: (id, approve, reason) =>
    rpc("review_session_request", { p_request_id: id, p_approve: approve, p_reason: reason ?? null }),

  // ---------- right now in the club (migration_club_presence.sql) ----------
  async clubNow(branchId) {
    const { data, error } = await sb().rpc("club_now", { p_branch_id: branchId });
    return error || !data ? null : (data as ClubNow);
  },

  async publicProfile(memberId) {
    const { data, error } = await sb().rpc("public_profile", { p_member_id: memberId });
    return error || !data ? null : (data as PublicProfile);
  },

  setProfilePublic: (isPublic) => rpc("set_profile_public", { p_public: isPublic }),

  async staffFindMembers(q) {
    const c = cleanQuery(q);
    if (!c) return [];
    const { data, error } = await sb().rpc("staff_find_members", { p_q: c });
    return error || !data ? [] : (data as MemberLookup[]);
  },

  async clubVisitsNow(branchId) {
    const { data, error } = await sb().rpc("club_visits_now", { p_branch_id: branchId });
    return error || !data ? [] : (data as ClubVisit[]);
  },

  visitEnter: (memberId, branchId) => rpc("visit_enter", { p_member_id: memberId, p_branch_id: branchId }),
  visitLeave: (visitId) => rpc("visit_leave", { p_visit_id: visitId }),

  // ---------- going with a friend (migration_buddy_invite.sql) ----------
  async myBuddyInvites() {
    const { data: s } = await sb().auth.getSession();
    if (!s.session) return [];
    await sb().rpc("expire_buddy_invites"); // frees holds that ran out; errors ignored (no migration yet)
    const { data } = await sb().from("v_my_buddy_invites").select("*").order("created_at", { ascending: false }).limit(50);
    return (data ?? []) as BuddyInvite[];
  },
  async inviteBuddy(bookingId, phone) {
    const p = normalizePhone(phone);
    if (!p) return { ok: false, code: "invalid_phone" };
    return rpc("invite_buddy", { p_booking_id: bookingId, p_phone: p });
  },
  acceptBuddyInvite: (inviteId) => rpc("accept_buddy_invite", { p_invite_id: inviteId }),
  declineBuddyInvite: (inviteId) => rpc("decline_buddy_invite", { p_invite_id: inviteId }),
  withdrawBuddyInvite: (inviteId) => rpc("withdraw_buddy_invite", { p_invite_id: inviteId }),
};
