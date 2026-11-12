import type { Lang } from "./i18n";

export type Role = "Member" | "Trainer" | "Admin";
export type BookingStatus = "Confirmed" | "Cancelled" | "Attended" | "No-show";
export type Result = { ok: boolean; code: string; message?: string; /** seconds, for `rate_limited` */ retry_after?: number };

export type Branch = { branch_id: number; branch_name: string; address: string; phone_number: string };
export type Room = { room_id: number; branch_id: number; room_name: string; max_capacity: number };
export type Trainer = { trainer_id: number; trainer_name: string; phone?: string | null; email?: string | null };
export type ClassType = { class_id: number; class_name: string; description: string | null; duration_min: number };
export type MemberRow = {
  member_id: number; member_name: string; member_surname: string; phone_number: string;
  membership_status: "Active" | "Suspended"; membership_expiry: string; role: Role;
  trainer_id: number | null; preferred_language: Lang;
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
};

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
export type Entity = "branches" | "rooms" | "trainers" | "classes" | "class_sessions" | "members";
export const ENTITY_ID: Record<Entity, string> = {
  branches: "branch_id", rooms: "room_id", trainers: "trainer_id",
  classes: "class_id", class_sessions: "session_id", members: "member_id",
};
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
  listSessions(opts?: { includePast?: boolean }): Promise<SessionRow[]>;
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

  // ---------- trainer sign-up ----------
  /**
   * Logged-in Member applies to become a Trainer: uploads the certificates, then saves
   * the application. The role stays `Member` until an admin approves.
   * Codes: `application_sent`, `application_exists`, `already_trainer`, `certificates_required`,
   * `file_too_large`, `bad_file_type`, `upload_failed`, `invalid_email`, `required`, `invalid_value`.
   */
  submitTrainerApplication(i: TrainerApplicationInput, files: File[]): Promise<Result>;
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
}
