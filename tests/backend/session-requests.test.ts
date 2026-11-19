// Trainer class requests (demo API, same rules as migration_session_requests.sql).
import { describe, it, expect } from "vitest";
import { demoApi as api } from "../../src/lib/demoApi";
import { H, DAY, loginAdmin, registerMember } from "./helpers";

const TRAINER_1 = { phone: "+77000000002", password: "trainer123" }; // Aigerim S., trainer 1

async function loginTrainer() {
  const r = await api.login(TRAINER_1.phone, TRAINER_1.password);
  if (!r.ok) throw new Error("trainer login failed: " + r.code);
}
/** A start time with nothing in the demo schedule: day +10, 06:00 Almaty. */
const freeSlot = (dayOffset = 10, hour = "06:00") => {
  const d = new Date(Date.now() + dayOffset * DAY + 5 * H).toISOString().slice(0, 10);
  return new Date(`${d}T${hour}:00+05:00`).toISOString();
};

describe("Trainer class requests", () => {
  it("TC-S1 only a trainer can propose; options list classes and rooms", async () => {
    await registerMember("+77015550301");
    const o = await api.requestOptions();
    expect(o.classes.length).toBeGreaterThan(0);
    expect(o.rooms.length).toBeGreaterThan(0);
    const r = await api.submitSessionRequest({ class_id: 1, room_id: 1, start_time: freeSlot(), capacity: 10, note: "" });
    expect(r.code).toBe("trainer_only");
  });

  it("TC-S2 time, capacity and conflicts are checked", async () => {
    await loginTrainer();
    const base = { class_id: 1, room_id: 2, capacity: 10, note: "" };
    expect((await api.submitSessionRequest({ ...base, start_time: new Date(Date.now() + 30 * 60_000).toISOString() })).code).toBe("request_too_soon");
    expect((await api.submitSessionRequest({ ...base, start_time: new Date(Date.now() + 70 * DAY).toISOString() })).code).toBe("request_too_far");
    expect((await api.submitSessionRequest({ ...base, start_time: freeSlot(), capacity: 99 })).code).toBe("capacity_exceeds_room");
    // the demo schedule: Yoga with trainer 1 in Studio A (room 1) tomorrow 10:00
    const yoga = (await api.listSessions()).find((s) => s.trainer_id === 1 && s.room_id === 1)!;
    expect((await api.submitSessionRequest({ ...base, room_id: 1, start_time: yoga.start_time })).code).toBe("room_overlap");
    expect((await api.submitSessionRequest({ ...base, room_id: 2, start_time: yoga.start_time })).code).toBe("trainer_overlap");
    expect((await api.submitSessionRequest({ ...base, start_time: freeSlot() })).code).toBe("request_sent");
    expect((await api.submitSessionRequest({ ...base, room_id: 3, start_time: freeSlot() })).code).toBe("request_overlap");
    const [q] = await api.listSessionRequests();
    expect(q.status).toBe("Pending");
    expect((Date.parse(q.end_time) - Date.parse(q.start_time)) / 60_000).toBe(60); // Yoga is 60 min
  });

  it("TC-S3 admin approves -> the class is in the schedule; the room is then taken", async () => {
    await loginTrainer();
    const start = freeSlot(12);
    await api.submitSessionRequest({ class_id: 2, room_id: 2, start_time: start, capacity: 12, note: "Extra Pilates" });
    await loginAdmin();
    const pending = (await api.listSessionRequests()).filter((q) => q.status === "Pending");
    expect(pending.length).toBe(1);
    expect((await api.reviewSessionRequest(pending[0].request_id, true)).code).toBe("request_approved");
    expect((await api.reviewSessionRequest(pending[0].request_id, true)).code).toBe("request_not_pending");
    const sessions = await api.listSessions();
    const created = sessions.find((s) => s.start_time === start && s.room_id === 2)!;
    expect(created).toMatchObject({ class_name: "Pilates", trainer_id: 1, capacity: 12 });

    await loginTrainer();
    expect((await api.submitSessionRequest({ class_id: 3, room_id: 2, start_time: start, capacity: 10, note: "" })).code)
      .toBe("room_overlap");
    expect((await api.listSessionRequests()).find((q) => q.status === "Approved")!.session_id).toBe(created.session_id);
  });

  it("TC-S4 reject with a reason; withdraw only own pending request", async () => {
    await loginTrainer();
    await api.submitSessionRequest({ class_id: 1, room_id: 1, start_time: freeSlot(14), capacity: 10, note: "" });
    await api.submitSessionRequest({ class_id: 1, room_id: 1, start_time: freeSlot(15), capacity: 10, note: "" });
    const [a, b] = (await api.listSessionRequests()).sort((x, y) => x.request_id - y.request_id);
    expect((await api.reviewSessionRequest(a.request_id, false)).code).toBe("admin_only");
    expect((await api.withdrawSessionRequest(b.request_id)).code).toBe("request_withdrawn");
    expect((await api.withdrawSessionRequest(b.request_id)).code).toBe("request_not_pending");
    await loginAdmin();
    expect((await api.reviewSessionRequest(a.request_id, false, "Studio A is booked for a corporate event")).code).toBe("request_rejected");
    await loginTrainer();
    const after = (await api.listSessionRequests()).find((q) => q.request_id === a.request_id)!;
    expect(after).toMatchObject({ status: "Rejected", reject_reason: "Studio A is booked for a corporate event" });
  });
});
