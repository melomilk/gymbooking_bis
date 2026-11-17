import { demoApi as api } from "../../src/lib/demoApi";

export const H = 3600_000;
export const DAY = 24 * H;

export const ADMIN = { phone: "+77000000001", password: "admin123" };
export const TRAINER = { phone: "+77000000002", password: "trainer123" };

export async function loginAdmin() {
  const r = await api.login(ADMIN.phone, ADMIN.password);
  if (!r.ok) throw new Error("admin login failed: " + r.code);
}

/** Registers a new member (the new member becomes the current user). */
export async function registerMember(phone = "+77011112233", password = "secret123") {
  const r = await api.register({ name: "Test", surname: "User", phone, password, lang: "en" });
  if (!r.ok) throw new Error("register failed: " + r.code);
  return (await api.getMe())!;
}

/** First seeded future session (seed creates sessions for the next 7 days). */
export async function firstSession() {
  return (await api.listSessions())[0];
}

/** Admin creates an extra session. Room 2 (Studio B, branch 1, capacity 15), trainer 3, class 3. */
export async function adminCreateSession(startOffsetMs: number, opts: { capacity?: number; durationMin?: number; roomId?: number; branchId?: number; trainerId?: number } = {}) {
  await loginAdmin();
  const start = Date.now() + startOffsetMs;
  const end = start + (opts.durationMin ?? 45) * 60_000;
  const res = await api.adminInsert("class_sessions", {
    class_id: 3, trainer_id: opts.trainerId ?? 3, branch_id: opts.branchId ?? 1, room_id: opts.roomId ?? 2,
    start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), capacity: opts.capacity ?? 10,
  });
  if (!res.ok) throw new Error("adminInsert session failed: " + res.code);
  const all = await api.listSessions({ includePast: true });
  const created = all.sort((a, b) => b.session_id - a.session_id)[0];
  await api.logout();
  return created;
}
