import type { Lang } from "./i18n";

export type Role = "Member" | "Trainer" | "Admin";
export type BookingStatus = "Confirmed" | "Cancelled" | "Attended" | "No-show";
export type Result = { ok: boolean; code: string; message?: string };

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

export type Reader = { reader_id: string; branch_id: number; branch_name: string; check_in_method: string };

export type RegisterInput = { name: string; surname: string; phone: string; password: string; lang: Lang };

// Tables the admin panel can edit (FR-09)
export type Entity = "branches" | "rooms" | "trainers" | "classes" | "class_sessions" | "members";
export const ENTITY_ID: Record<Entity, string> = {
  branches: "branch_id", rooms: "room_id", trainers: "trainer_id",
  classes: "class_id", class_sessions: "session_id", members: "member_id",
};
export type Row = Record<string, unknown>;

export interface Api {
  mode: "supabase" | "demo";
  // auth (FR-04)
  getMe(): Promise<Me | null>;
  register(i: RegisterInput): Promise<Result>;
  login(phone: string, password: string): Promise<Result>;
  logout(): Promise<void>;
  setLanguage(lang: Lang): Promise<void>;
  // public data
  listBranches(): Promise<Branch[]>;
  listSessions(opts?: { includePast?: boolean }): Promise<SessionRow[]>;
  searchTrainers(q: string): Promise<Trainer[]>;
  searchBranches(q: string): Promise<Branch[]>;
  // member
  myBookings(memberId: number): Promise<BookingRow[]>;
  searchBookings(q: string): Promise<BookingRow[]>; // own rows for members, all rows for admins
  book(sessionId: number): Promise<Result>;
  cancel(bookingId: number, acceptFee?: boolean): Promise<Result>;
  // trainer
  trainerRoster(): Promise<RosterRow[]>;
  // admin
  adminList(entity: Entity): Promise<Row[]>;
  adminInsert(entity: Entity, row: Row): Promise<Result>;
  adminUpdate(entity: Entity, id: number, row: Row): Promise<Result>;
  adminDelete(entity: Entity, id: number): Promise<Result>;
  allBookings(): Promise<BookingRow[]>;
  listReaders(): Promise<Reader[]>;
  checkIn(bookingId: number, readerId: string): Promise<Result>;
}
