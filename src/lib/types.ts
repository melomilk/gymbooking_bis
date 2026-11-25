import type { Lang } from "./i18n";

export type Role = "Member" | "Trainer" | "Receptionist" | "Admin";
export type BookingStatus = "Confirmed" | "Cancelled" | "Attended" | "No-show";
export type Result = {
  ok: boolean; code: string; message?: string;
  /** seconds, for `rate_limited` */ retry_after?: number;
  /** code to show at the front desk, for `redeemed` */ redemption_code?: string;
  /** place in the queue, for `waitlist_joined` */ position?: number;
  /** new YYYY-MM-DD expiry date, for `membership_renewed` */ membership_expiry?: string;
};
/**
 * Answer to a password-reset request. IMITATION for the course project: no SMS is
 * sent, so the 6-digit code comes back here and the page shows it as the "SMS".
 * `token` proves which code was sent; it goes back with the code on confirm.
 */
export type ResetRequest = Result & { sms_code?: string; token?: string };

export type Branch = { branch_id: number; branch_name: string; address: string; phone_number: string;
  /** how many people fit in the gym at once; the club load is counted from it */ club_capacity?: number };
export type Room = { room_id: number; branch_id: number; room_name: string; max_capacity: number };
export type Trainer = { trainer_id: number; trainer_name: string; phone?: string | null; email?: string | null };
export type ClassType = { class_id: number; class_name: string; description: string | null; duration_min: number };
export type MemberRow = {
  member_id: number; member_name: string; member_surname: string; phone_number: string;
  membership_status: "Active" | "Suspended"; membership_expiry: string; role: Role;
  trainer_id: number | null; preferred_language: Lang; is_public?: boolean;
};

export type SessionRow = {
  session_id: number;
  class_id: number;
  class_name: string;
  description: string | null;
  duration_min: number;
  trainer_id: number;
  trainer_name: string;
  branch_id: number;
  branch_name: string;
  room_id: number;
  room_name: string;
  start_time: string;
  end_time: string;
  capacity: number;
  spots_taken: number;
  /** set when an admin cancelled the class */
  cancelled_at?: string | null;
};

export type Me = {
  member_id: number;
  member_name: string;
  member_surname: string;
  membership_expiry: string;
  phone_number: string;
  role: Role;
  trainer_id: number | null;
  preferred_language: Lang;
  effective_status: "Active" | "Expired" | "Suspended";
  /** other members can see this person in "Right now in the club" (undefined without the migration) */
  is_public?: boolean;
};

export type BookingRow = {
  booking_id: number;
  member_id: number;
  session_id: number;
  booking_status: BookingStatus;
  booking_time: string;
  cancelled_at: string | null;
  fee_forfeited: boolean;
  member_fullname: string;
  class_name: string;
  trainer_id: number;
  trainer_name: string;
  branch_id: number;
  branch_name: string;
  room_name: string;
  start_time: string;
  end_time: string;
  /** set when the gym cancelled the whole class */
  session_cancelled_at?: string | null;
  /** Set when an admin excused a no-show (the booking is then `Cancelled`). */
  excuse_reason?: ExcuseReason | null;
  excuse_note?: string | null;
  /** Path of the PDF note in the private `excuse-documents` bucket. */
  excuse_document?: string | null;
  excused_at?: string | null;
};

// ---------- excused no-show ----------
export type ExcuseReason = "Illness" | "Family" | "Work" | "Other";
export const EXCUSE_REASONS: ExcuseReason[] = ["Illness", "Family", "Work", "Other"];
/** Illness needs a PDF medical note; Other needs a written note. */
export const EXCUSE_DOC_MAX_BYTES = 5 * 1024 * 1024;
export const EXCUSE_DOC_TYPES = ["application/pdf"];
export type ExcuseInput = { reason: ExcuseReason; note: string; file: File | null };

export type RosterRow = {
  session_id: number; class_name: string; branch_name: string; room_name: string;
  start_time: string; end_time: string; capacity: number;
  booking_id: number | null; booking_status: BookingStatus | null; member_fullname: string | null;
};

/** One finished session in the attendance report (v_attendance_report). */
export type AttendanceRow = {
  session_id: number; class_name: string; trainer_name: string; branch_name: string;
  start_time: string; end_time: string; capacity: number;
  booked: number; attended: number; no_show: number;
};

export type Reader = { reader_id: string; branch_id: number; branch_name: string; check_in_method: string };

export type RegisterInput = { name: string; surname: string; phone: string; password: string; lang: Lang };

// ---------- membership renewal ----------
export type MembershipPlanMonths = 1 | 3 | 6;
export type MembershipPlan = { months: MembershipPlanMonths; priceKzt: number; savePct?: number };
export const MEMBERSHIP_PLANS: readonly MembershipPlan[] = [
  { months: 1, priceKzt: 15000 },
  { months: 3, priceKzt: 40000, savePct: 11 },
  { months: 6, priceKzt: 72000, savePct: 20 },
] as const;

// ---------- trainer sign-up ----------
export type ApplicationStatus = "Pending" | "Approved" | "Rejected";
/** A stored certificate: `path` inside the private bucket, `name` = original file name. */
export type CertificateFile = { path: string; name: string };
/** What a would-be trainer fills in on top of the normal registration. */
export type TrainerApplicationInput = { email: string; specialization: string; experience_years: number; bio: string };
/** One row of v_trainer_applications. */
export type TrainerApplication = TrainerApplicationInput & {
  application_id: number; member_id: number; member_fullname: string; phone_number: string;
  certificates: CertificateFile[]; status: ApplicationStatus; reject_reason: string | null;
  created_at: string; reviewed_at: string | null; trainer_id: number | null;
};
export const CERT_MAX_FILES = 5;
export const CERT_MAX_BYTES = 5 * 1024 * 1024;
export const CERT_TYPES = ["application/pdf", "image/jpeg", "image/png"];

// Tables the admin panel can edit (FR-09)
export type Entity = "branches" | "rooms" | "trainers" | "classes" | "class_sessions" | "members" | "rewards";
export const ENTITY_ID: Record<Entity, string> = {
  branches: "branch_id", rooms: "room_id", trainers: "trainer_id",
  classes: "class_id", class_sessions: "session_id", members: "member_id", rewards: "reward_id",
};

// ---------- Pulse points and rewards (migration_points_rewards.sql) ----------
/** Points rules. The database trigger uses the same numbers. */
export const POINTS = { attended: 10, no_show: -5, review: 5, streak_bonus: 20, streak_every: 4 } as const;
export type RewardKind = "free_class" | "late_cancel_pass" | "membership_days" | "merch";
export const REWARD_KINDS: RewardKind[] = ["free_class", "late_cancel_pass", "membership_days", "merch"];
export type Reward = {
  reward_id: number; reward_name: string; description: string | null; kind: RewardKind;
  cost: number; stock: number | null; extend_days: number | null; active: boolean;
};
export type RedemptionStatus = "Active" | "Used" | "Cancelled";
export type Redemption = {
  redemption_id: number; member_id: number; member_fullname: string; phone_number: string;
  reward_id: number; reward_name: string; kind: RewardKind; extend_days: number | null; cost: number;
  code: string; status: RedemptionStatus; created_at: string; used_at: string | null; cancelled_at: string | null;
};
export type PointsSummary = { balance: number; lifetime: number; month_points: number; streak: number; streak_bonuses: number };
export type PointsReason = "attended" | "no_show" | "no_show_reversed" | "streak_bonus" | "review" | "review_removed" | "redeem" | "redeem_refund";
export type PointsEntry = {
  entry_id: number; delta: number; reason: PointsReason; created_at: string;
  class_name: string | null; start_time: string | null; reward_name: string | null;
};
export type LeaderboardRow = { place: number; name: string; points: number; is_me: boolean };
export type Leaderboard = { top: LeaderboardRow[]; me: { place: number; points: number } | null };

// ---------- waitlist (migration_waitlist.sql) ----------
/** The queue closes this long before the start (same as the free-cancellation window). */
export const WAITLIST_CLOSES_MS = 3 * 3600_000;
export const WAITLIST_MAX = 5;
export type WaitlistStatus = "Waiting" | "Promoted" | "Left" | "Expired";
export type WaitlistEntry = {
  entry_id: number; session_id: number; booking_id: number | null; status: WaitlistStatus;
  promoted_auto: boolean; status_reason: "membership" | "time_conflict" | "session_cancelled" | null;
  position: number | null; created_at: string; updated_at: string;
  class_name: string; trainer_name: string; branch_name: string; room_name: string; start_time: string; end_time: string;
};

// ---------- trainer class requests (migration_session_requests.sql) ----------
export const REQUEST_MIN_AHEAD_MS = 3600_000;      // at least 1 hour ahead
export const REQUEST_MAX_DAYS = 60;                // at most 60 days ahead
export const REQUEST_MAX_PENDING = 10;
export const REQUEST_NOTE_MAX = 300;
export type SessionRequestStatus = "Pending" | "Approved" | "Rejected" | "Withdrawn";
export type ClassTypeOption = { class_id: number; class_name: string; duration_min: number };
export type RoomOption = { room_id: number; room_name: string; max_capacity: number; branch_id: number; branch_name: string };
export type SessionRequestInput = { class_id: number; room_id: number; start_time: string; capacity: number; note: string };
export type SessionRequest = {
  request_id: number; trainer_id: number; trainer_name: string; class_id: number; class_name: string; duration_min: number;
  branch_id: number; branch_name: string; room_id: number; room_name: string; max_capacity: number;
  start_time: string; end_time: string; capacity: number; note: string | null; status: SessionRequestStatus;
  reject_reason: string | null; created_at: string; reviewed_at: string | null; session_id: number | null;
};

// ---------- reviews (migration_reviews.sql) ----------
export const REVIEW_WINDOW_DAYS = 14;
export const REVIEW_MAX_CHARS = 500;
export type TrainerRating = { trainer_id: number; trainer_name: string; avg_rating: number; reviews_count: number };
export type MyReview = { review_id: number; booking_id: number; rating: number; comment: string | null; created_at: string; updated_at: string };
/** A review as the trainer (no name) or the admin (with name) sees it. */
export type Review = {
  review_id: number; rating: number; comment: string | null; created_at: string; updated_at: string;
  trainer_id: number; trainer_name: string; class_name: string; start_time: string; member_fullname: string | null;
};
// ---------- who is in the club now (migration_club_presence.sql) ----------
/** An open visit counts as finished after this long (people forget to sign out at the desk). */
export const VISIT_MAX_MS = 3 * 3600_000;
export const DEFAULT_CLUB_CAPACITY = 60;
export type ClubLoad = "low" | "medium" | "high";
/** A public member who is in the club now. `visits` = all their visits. */
export type ClubPerson = { member_id: number; name: string; initials: string; visits: number; entered_at: string };
/** `people` = public members only (empty when logged out); `hidden` = the others. */
export type ClubNow = { branch_id: number; present: number; capacity: number; load: ClubLoad; people: ClubPerson[]; hidden: number };
export type PublicProfile = {
  member_id: number; name: string; initials: string; visits_total: number; visits_month: number;
  first_visit: string | null; classes_attended: number; favourite_class: string | null;
  in_club: { branch_name: string; entered_at: string } | null;
};
/** Front desk: someone who is in the club now. */
export type ClubVisit = { visit_id: number; member_id: number; member_fullname: string; phone_number: string;
  branch_id: number; entered_at: string; is_public: boolean };
/** Front desk: member search result for "arrived". */
export type MemberLookup = { member_id: number; member_fullname: string; phone_number: string;
  effective_status: Me["effective_status"]; in_club_branch_id: number | null };
export type Row = Record<string, unknown>;

/**
 * Data access used by every page. Implemented twice with the same rules:
 * `supabaseApi` (real database) and `demoApi` (browser storage).
 * Write actions return a {@link Result}; translate it in the UI with `tr()`.
 * Full reference: docs/API.md.
 */
export interface Api {
  /** Which implementation is active. Pages use it only for the demo banner. */
  mode: "supabase" | "demo";

  // ---------- auth (FR-04, FR-07) ----------
  /** Logged-in member with computed `effective_status`, or `null` if logged out. */
  getMe(): Promise<Me | null>;
  /**
   * Validates input, creates the account and logs the member in.
   * Codes: `invalid_name`, `invalid_phone`, `weak_password`, `phone_taken`, `rate_limited` (+ `retry_after`), `saved`.
   */
  register(i: RegisterInput): Promise<Result>;
  /** Log in by phone (normalised to +7…) and password. Codes: `saved`, `bad_credentials`. */
  login(phone: string, password: string): Promise<Result>;
  logout(): Promise<void>;
  /** Saves the UI language on the member's account so it applies at next login. */
  setLanguage(lang: Lang): Promise<void>;

  // ---------- public data ----------
  listBranches(): Promise<Branch[]>;
  /** Schedule with `spots_taken`. Future sessions only unless `includePast` (admin panel). */
  listSessions(opts?: { includePast?: boolean; includeCancelled?: boolean }): Promise<SessionRow[]>;
  /** Trainer names containing `q` (FR-08). Contacts are never returned. */
  searchTrainers(q: string): Promise<Trainer[]>;
  /** Branches whose name or address contains `q` (FR-08). */
  searchBranches(q: string): Promise<Branch[]>;

  // ---------- member ----------
  /** All bookings of one member, newest first. */
  myBookings(memberId: number): Promise<BookingRow[]>;
  /** Bookings matching class, trainer, branch or member name. Own rows for members, all rows for admins. */
  searchBookings(q: string): Promise<BookingRow[]>;
  /**
   * Books a place (FR-01, FR-02). Atomic: the session row is locked while seats are counted.
   * Codes: `booked`, `class_full`, `already_booked`, `class_started`,
   * `membership_suspended`, `membership_expired`, `not_signed_in`, `session_not_found`.
   */
  book(sessionId: number): Promise<Result>;
  /**
   * Cancels a confirmed booking (FR-06). Less than 3 h before start the first call returns
   * `late_cancel_needs_confirm`; call again with `acceptFee = true` to cancel and forfeit the fee.
   * Codes: `cancelled`, `cancelled_fee_forfeited`, `not_cancellable`, `class_started`, `booking_not_found`.
   */
  cancel(bookingId: number, acceptFee?: boolean): Promise<Result>;
  /**
   * Renews the logged-in member's subscription (imitation online payment; updates status and expiry only).
   * Codes: `membership_renewed` (+ `membership_expiry`), `invalid_plan`, `membership_suspended`,
   * `staff_cannot_renew`, `not_signed_in`.
   */
  renewMembership(months: MembershipPlanMonths): Promise<Result>;

  // ---------- trainer ----------
  /** The trainer's own sessions with attendee names (FR-10). */
  trainerRoster(): Promise<RosterRow[]>;

  // ---------- admin (FR-09) ----------
  /** All rows of an editable table. */
  adminList(entity: Entity): Promise<Row[]>;
  /** Codes: `created` or a database error code (`duplicate`, `room_overlap`, `capacity_exceeds_room`, …). */
  adminInsert(entity: Entity, row: Row): Promise<Result>;
  /** Codes: `updated`, `forbidden`, or a database error code. */
  adminUpdate(entity: Entity, id: number, row: Row): Promise<Result>;
  /** Codes: `deleted`, `in_use` (still referenced), `forbidden`. */
  adminDelete(entity: Entity, id: number): Promise<Result>;
  /**
   * Cancels a whole class: its confirmed bookings are cancelled free of charge and
   * it disappears from the schedule. Codes: `session_cancelled_done`, `session_is_cancelled`,
   * `class_started`, `session_not_found`, `forbidden`.
   */
  cancelSession(sessionId: number): Promise<Result>;

  // ---------- forgotten password (imitation SMS) ----------
  /** Codes: `reset_code_sent`, `invalid_phone`, `reset_unknown_phone`, `reset_staff`, `reset_unavailable`. */
  requestPasswordReset(phone: string): Promise<ResetRequest>;
  /** Codes: `reset_done`, `reset_bad_code`, `reset_expired`, `weak_password`, plus the request codes. */
  resetPassword(i: { phone: string; token: string; smsCode: string; password: string }): Promise<Result>;
  /** Confirmed, attended and no-show bookings from the last 12 h onward, for check-in. */
  allBookings(): Promise<BookingRow[]>;
  listReaders(): Promise<Reader[]>;
  /**
   * Records an NFC check-in: inserts a log row and sets the booking to `Attended`
   * in one transaction. Codes: `checked_in`, `already_checked_in`, `not_checkinable`,
   * `unknown_reader`, `wrong_branch_reader`, `admin_only`.
   */
  checkIn(bookingId: number, readerId: string): Promise<Result>;
  /**
   * Plan B when the NFC reader fails: the admin marks a `Confirmed` or `No-show`
   * booking as `Attended` after the class has started (a forfeited fee is returned).
   * Codes: `checked_in_manual`, `already_checked_in`, `not_checkinable`,
   * `class_not_started`, `booking_not_found`, `admin_only`.
   */
  manualCheckIn(bookingId: number): Promise<Result>;
  /** Finished sessions with booked / attended / no-show counts, newest first (admin only). */
  attendanceReport(): Promise<AttendanceRow[]>;
  /** No-shows and excused bookings of the last 30 days, newest first (admin only). */
  noShowBookings(): Promise<BookingRow[]>;
  /**
   * The member missed the class for a valid reason. Uploads the PDF note (if any), then the
   * booking becomes `Cancelled` with the reason saved, and the forfeited fee is returned.
   * `Illness` requires a PDF, `Other` requires a note. Not the same as `manualCheckIn`:
   * the member did NOT come. Codes: `excused`, `not_no_show`, `invalid_reason`, `note_required`,
   * `document_required`, `pdf_only`, `file_too_large`, `upload_failed`, `booking_not_found`, `admin_only`.
   */
  excuseNoShow(bookingId: number, i: ExcuseInput): Promise<Result>;
  /** Short-lived link to open an excuse PDF (admin or the booking's member), or `null`. */
  excuseDocumentUrl(path: string): Promise<string | null>;

  // ---------- trainer sign-up ----------
  /**
   * Logged-in Member applies to become a Trainer: uploads the certificates, then saves
   * the application. The role stays `Member` until an admin approves.
   * Codes: `application_sent`, `application_exists`, `already_trainer`, `certificates_required`,
   * `file_too_large`, `bad_file_type`, `upload_failed`, `invalid_email`, `required`, `invalid_value`.
   */
  submitTrainerApplication(i: TrainerApplicationInput, files: File[]): Promise<Result>;
  /**
   * Replaces the caller's PENDING application with a corrected version. `keep` are
   * certificates already uploaded that stay; `files` are new ones to upload.
   * Codes: `application_updated`, `application_not_pending`, plus the submit codes.
   */
  updateTrainerApplication(i: TrainerApplicationInput, keep: CertificateFile[], files: File[]): Promise<Result>;
  /** The caller's latest application, or `null`. */
  myTrainerApplication(): Promise<TrainerApplication | null>;
  /** All applications, pending first (admin only). */
  listTrainerApplications(): Promise<TrainerApplication[]>;
  /** Short-lived link to open a certificate (owner or admin), or `null`. */
  certificateUrl(path: string): Promise<string | null>;
  /**
   * Admin decision. Approve creates the trainer profile and makes the member a Trainer.
   * Codes: `application_approved`, `application_rejected`, `application_not_pending`,
   * `application_not_found`, `already_trainer`, `admin_only`.
   */
  reviewTrainerApplication(id: number, approve: boolean, reason?: string): Promise<Result>;

  // ---------- Pulse points and rewards ----------
  // Without the migration these return empty data / null, so the site keeps working.
  /** Balance, lifetime points (for the level), this month, streak in weeks. `null` if unavailable. */
  myPoints(): Promise<PointsSummary | null>;
  /** Own points history, newest first. */
  myPointsHistory(): Promise<PointsEntry[]>;
  /** Top 10 of this month + the caller's place. */
  leaderboard(): Promise<Leaderboard | null>;
  /** Active rewards, cheapest first. */
  listRewards(): Promise<Reward[]>;
  /**
   * Exchanges points for a reward. Codes: `redeemed` (+ `redemption_code`), `not_enough_points`,
   * `out_of_stock`, `reward_unavailable`, `pass_already_active`, `staff_cannot_redeem`.
   */
  redeemReward(rewardId: number): Promise<Result>;
  myRedemptions(): Promise<Redemption[]>;
  /** Cancel an unused reward: points (and stock) come back. Codes: `redemption_cancelled`, `redemption_not_active`. */
  cancelRedemption(redemptionId: number): Promise<Result>;
  /** Front desk: all redemptions, active first (staff only). */
  staffRedemptions(): Promise<Redemption[]>;
  /** Front desk hands out a free visit / merch. Codes: `redemption_used`, `redemption_not_active`, `redemption_auto`, `staff_only`. */
  useRedemption(redemptionId: number): Promise<Result>;

  // ---------- waitlist ----------
  /** Queue length per upcoming class: session_id -> people waiting. */
  waitlistCounts(): Promise<Record<number, number>>;
  /** Own queue entries (waiting, booked from the queue, expired), newest class first. */
  myWaitlist(): Promise<WaitlistEntry[]>;
  /**
   * Join the queue of a full class. Codes: `waitlist_joined` (+ `position`), `has_free_places`,
   * `already_waiting`, `already_booked`, `waitlist_closed`, `waitlist_limit`, `time_conflict`,
   * `membership_expired`, `membership_suspended`, `session_cancelled`, `staff_cannot_book`.
   */
  joinWaitlist(sessionId: number): Promise<Result>;
  /** Codes: `waitlist_left`, `not_waiting`. */
  leaveWaitlist(sessionId: number): Promise<Result>;

  // ---------- reviews ----------
  /** Average rating per trainer (public). */
  trainerRatings(): Promise<TrainerRating[]>;
  myReviews(): Promise<MyReview[]>;
  /**
   * Rate an attended class (1-5 stars, optional comment) within 14 days after it ends; can be edited.
   * Codes: `review_saved_points` (first time, +5 points), `review_saved`, `review_not_attended`,
   * `review_too_early`, `review_too_late`, `invalid_rating`.
   */
  submitReview(bookingId: number, rating: number, comment: string): Promise<Result>;
  /** Trainer: reviews of own classes without names. Admin: all reviews with names. */
  listReviews(): Promise<Review[]>;
  /** Admin removes a review; its points are taken back. Codes: `review_deleted`, `review_not_found`, `admin_only`. */
  deleteReview(reviewId: number): Promise<Result>;

  // ---------- trainer class requests ----------
  /** Class types and rooms a trainer can choose from (empty without the migration). */
  requestOptions(): Promise<{ classes: ClassTypeOption[]; rooms: RoomOption[] }>;
  /** Trainer: own requests. Admin: all requests, pending first. */
  listSessionRequests(): Promise<SessionRequest[]>;
  /**
   * Trainer proposes a class; the end time follows from the class duration.
   * Codes: `request_sent`, `trainer_only`, `request_too_soon`, `request_too_far`, `capacity_exceeds_room`,
   * `room_overlap`, `trainer_overlap`, `request_overlap`, `request_limit`, `required`, `invalid_value`.
   */
  submitSessionRequest(i: SessionRequestInput): Promise<Result>;
  /** Codes: `request_withdrawn`, `request_not_pending`. */
  withdrawSessionRequest(requestId: number): Promise<Result>;
  /**
   * Admin. Approve creates the class in the schedule. Codes: `request_approved`, `request_rejected`,
   * `request_not_pending`, `request_expired`, `room_overlap`, `trainer_overlap`, `capacity_exceeds_room`, `admin_only`.
   */
  reviewSessionRequest(requestId: number, approve: boolean, reason?: string): Promise<Result>;

  // ---------- right now in the club (migration_club_presence.sql) ----------
  // Without the migration these return null / empty data, so the site keeps working.
  /** People in the branch now, the load level and the public members among them. `null` if unavailable. */
  clubNow(branchId: number): Promise<ClubNow | null>;
  /** Another member's profile; `null` if it is private or the caller is logged out. */
  publicProfile(memberId: number): Promise<PublicProfile | null>;
  /** Codes: `profile_public_on`, `profile_public_off`, `not_signed_in`. */
  setProfilePublic(isPublic: boolean): Promise<Result>;
  /** Front desk: members by name or phone (max 10). */
  staffFindMembers(q: string): Promise<MemberLookup[]>;
  /** Front desk: who is in the branch now, newest first. */
  clubVisitsNow(branchId: number): Promise<ClubVisit[]>;
  /**
   * Front desk marks that a member came into the club.
   * Codes: `visit_started`, `already_in_club`, `member_not_found`, `branch_not_found`,
   * `visit_membership_expired`, `visit_membership_suspended`, `staff_only`.
   */
  visitEnter(memberId: number, branchId: number): Promise<Result>;
  /** Front desk marks that the member left. Codes: `visit_ended`, `visit_not_open`, `staff_only`. */
  visitLeave(visitId: number): Promise<Result>;
}
