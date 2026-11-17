import { describe, it, expect } from "vitest";
import { demoApi as api } from "../../src/lib/demoApi";
import { H, DAY, ADMIN, loginAdmin, registerMember, firstSession, adminCreateSession } from "./helpers";

describe("Registration & login (FR-04)", () => {
  it("TC-01 register: valid data creates a Member account and logs in", async () => {
    const r = await api.register({ name: "Aruzhan", surname: "Bek", phone: "8 701 111 22 33", password: "secret123", lang: "en" });
    expect(r).toMatchObject({ ok: true, code: "created" });
    const me = await api.getMe();
    expect(me?.role).toBe("Member");
    expect(me?.phone_number).toBe("+77011112233"); // 8XXXXXXXXXX normalised to +7
    expect(me?.effective_status).toBe("Active");
  });

  it("TC-02 register: name with digits is rejected (invalid_name)", async () => {
    const r = await api.register({ name: "Ar1zhan", surname: "Bek", phone: "+77011112233", password: "secret123", lang: "en" });
    expect(r).toMatchObject({ ok: false, code: "invalid_name" });
  });

  it("TC-03 register: too short phone number is rejected (invalid_phone)", async () => {
    const r = await api.register({ name: "Aruzhan", surname: "Bek", phone: "12345", password: "secret123", lang: "en" });
    expect(r).toMatchObject({ ok: false, code: "invalid_phone" });
  });

  it("TC-04 register: password shorter than 6 characters is rejected (weak_password)", async () => {
    const r = await api.register({ name: "Aruzhan", surname: "Bek", phone: "+77011112233", password: "12345", lang: "en" });
    expect(r).toMatchObject({ ok: false, code: "weak_password" });
  });

  it("TC-05 register: already used phone number is rejected (phone_taken)", async () => {
    await registerMember("+77011112233");
    await api.logout();
    const r = await api.register({ name: "Other", surname: "Person", phone: "87011112233", password: "secret123", lang: "en" });
    expect(r).toMatchObject({ ok: false, code: "phone_taken" });
  });

  it("TC-06 login: wrong password fails, correct password succeeds", async () => {
    await registerMember("+77011112233", "secret123");
    await api.logout();
    expect(await api.login("+77011112233", "wrong-pass")).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(await api.getMe()).toBeNull();
    expect(await api.login("+77011112233", "secret123")).toMatchObject({ ok: true });
    expect((await api.getMe())?.phone_number).toBe("+77011112233");
  });
});

describe("Booking a class (FR-01, FR-02, FR-03)", () => {
  it("TC-07 book: anonymous user cannot book (not_signed_in)", async () => {
    const s = await firstSession();
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "not_signed_in" });
  });

  it("TC-08 book: logged-in member books a future session, spots_taken grows by 1", async () => {
    await registerMember();
    const s = await firstSession();
    expect(await api.book(s.session_id)).toMatchObject({ ok: true, code: "booked" });
    const after = (await api.listSessions()).find((x) => x.session_id === s.session_id)!;
    expect(after.spots_taken).toBe(s.spots_taken + 1);
    const mine = await api.myBookings((await api.getMe())!.member_id);
    expect(mine).toHaveLength(1);
    expect(mine[0].booking_status).toBe("Confirmed");
  });

  it("TC-09 book: the same session cannot be booked twice (already_booked)", async () => {
    await registerMember();
    const s = await firstSession();
    await api.book(s.session_id);
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "already_booked" });
  });

  it("TC-10 book: full class is refused (class_full) - capacity is never exceeded", async () => {
    const s = await adminCreateSession(DAY * 20, { capacity: 1 });
    await registerMember("+77011110001");
    expect(await api.book(s.session_id)).toMatchObject({ ok: true });
    await api.logout();
    await registerMember("+77011110002");
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "class_full" });
    const after = (await api.listSessions()).find((x) => x.session_id === s.session_id)!;
    expect(after.spots_taken).toBe(1);
  });

  it("TC-11 book: suspended membership cannot book (membership_suspended)", async () => {
    const member = await registerMember();
    await api.logout();
    await loginAdmin();
    expect(await api.adminUpdate("members", member.member_id, { membership_status: "Suspended" })).toMatchObject({ ok: true });
    await api.logout();
    await api.login("+77011112233", "secret123");
    const s = await firstSession();
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "membership_suspended" });
  });

  it("TC-12 book: expired membership cannot book (membership_expired)", async () => {
    const member = await registerMember();
    await api.logout();
    await loginAdmin();
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    await api.adminUpdate("members", member.member_id, { membership_expiry: yesterday });
    await api.logout();
    await api.login("+77011112233", "secret123");
    expect((await api.getMe())?.effective_status).toBe("Expired");
    const s = await firstSession();
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "membership_expired" });
  });
});

describe("Cancelling (FR-06)", () => {
  it("TC-13 cancel: more than 3 hours before the class is free of charge", async () => {
    await registerMember();
    const s = await firstSession(); // seeded sessions start at least a day ahead
    await api.book(s.session_id);
    const b = (await api.myBookings((await api.getMe())!.member_id))[0];
    expect(await api.cancel(b.booking_id)).toMatchObject({ ok: true, code: "cancelled" });
    const after = (await api.myBookings((await api.getMe())!.member_id))[0];
    expect(after).toMatchObject({ booking_status: "Cancelled", fee_forfeited: false });
  });

  it("TC-14 cancel: less than 3 hours before needs confirmation and forfeits the fee", async () => {
    const s = await adminCreateSession(H, { durationMin: 45 }); // starts in 1 hour
    await registerMember();
    await api.book(s.session_id);
    const memberId = (await api.getMe())!.member_id;
    const b = (await api.myBookings(memberId))[0];
    expect(await api.cancel(b.booking_id)).toMatchObject({ ok: false, code: "late_cancel_needs_confirm" });
    expect((await api.myBookings(memberId))[0].booking_status).toBe("Confirmed"); // nothing changed yet
    expect(await api.cancel(b.booking_id, true)).toMatchObject({ ok: true, code: "cancelled_fee_forfeited" });
    expect((await api.myBookings(memberId))[0]).toMatchObject({ booking_status: "Cancelled", fee_forfeited: true });
  });

  it("TC-15 cancel: a cancelled place can be booked again and frees/retakes the seat", async () => {
    await registerMember();
    const s = await firstSession();
    await api.book(s.session_id);
    const memberId = (await api.getMe())!.member_id;
    const b = (await api.myBookings(memberId))[0];
    await api.cancel(b.booking_id);
    expect((await api.listSessions()).find((x) => x.session_id === s.session_id)!.spots_taken).toBe(s.spots_taken);
    expect(await api.book(s.session_id)).toMatchObject({ ok: true, code: "booked" });
    expect(await api.myBookings(memberId)).toHaveLength(1); // same booking row is re-activated
  });
});

describe("Roles and admin rules (FR-09, FR-10)", () => {
  it("TC-16 access control: a Member cannot read or change admin data", async () => {
    await registerMember();
    expect(await api.adminInsert("branches", { branch_name: "X", address: "Y", phone_number: "+77270009999" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await api.adminList("members")).toEqual([]);
    expect(await api.adminDelete("classes", 1)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await api.allBookings()).toEqual([]);
    expect(await api.checkIn(1, "NFC-DT-01")).toMatchObject({ ok: false, code: "admin_only" });
  });

  it("TC-17 sessions: room overlap and capacity above room size are refused", async () => {
    await adminCreateSession(DAY * 20, { capacity: 10 });
    await loginAdmin();
    const start = Date.now() + DAY * 20 + 15 * 60_000; // overlaps the session created above (same room 2)
    const overlap = await api.adminInsert("class_sessions", {
      class_id: 3, trainer_id: 2, branch_id: 1, room_id: 2,
      start_time: new Date(start).toISOString(), end_time: new Date(start + 45 * 60_000).toISOString(), capacity: 10,
    });
    expect(overlap).toMatchObject({ ok: false, code: "room_overlap" });
    const tooBig = await api.adminInsert("class_sessions", {
      class_id: 3, trainer_id: 2, branch_id: 1, room_id: 2,
      start_time: new Date(Date.now() + DAY * 25).toISOString(), end_time: new Date(Date.now() + DAY * 25 + H).toISOString(), capacity: 999,
    });
    expect(tooBig).toMatchObject({ ok: false, code: "capacity_exceeds_room" });
  });

  it("TC-18 admin delete: a branch that still has rooms cannot be deleted (in_use)", async () => {
    await loginAdmin();
    expect(await api.adminDelete("branches", 1)).toMatchObject({ ok: false, code: "in_use" });
    expect((await api.listBranches()).some((b) => b.branch_id === 1)).toBe(true);
  });

  it("TC-19 check-in: confirmed booking becomes Attended once; repeats and wrong branch reader are refused", async () => {
    const s = (await api.listSessions()).find((x) => x.branch_id === 1)!; // Downtown; its reader is NFC-DT-01
    await registerMember();
    await api.book(s.session_id);
    await api.logout();
    await loginAdmin();
    const booking = (await api.allBookings())[0];
    expect(await api.checkIn(booking.booking_id, "NFC-RS-01")).toMatchObject({ ok: false, code: "wrong_branch_reader" }); // reader of branch 2
    expect(await api.checkIn(booking.booking_id, "NFC-DT-01")).toMatchObject({ ok: true, code: "checked_in" });
    expect((await api.allBookings())[0].booking_status).toBe("Attended");
    expect(await api.checkIn(booking.booking_id, "NFC-DT-01")).toMatchObject({ ok: false, code: "already_checked_in" });
  });

  it("TC-20 roles: admin can give a member the Receptionist role (UI page /receptionist exists)", async () => {
    // The Role type and the /receptionist page allow "Receptionist", so assigning it should work.
    const member = await registerMember();
    await api.logout();
    await loginAdmin();
    const r = await api.adminUpdate("members", member.member_id, { role: "Receptionist" });
    expect(r).toMatchObject({ ok: true, code: "updated" });
  });
  it("TC-21 roles: Receptionist can use front-desk functions (bookings, readers, check-in) but not admin functions", async () => {
    const s = (await api.listSessions()).find((x) => x.branch_id === 1)!;
    await registerMember("+77011110001");
    await api.book(s.session_id);
    await api.logout();
    const staff = await registerMember("+77011110002", "secret123");
    await api.logout();
    await loginAdmin();
    expect(await api.adminUpdate("members", staff.member_id, { role: "Receptionist" })).toMatchObject({ ok: true });
    await api.logout();
    await api.login("+77011110002", "secret123");
    expect((await api.getMe())?.role).toBe("Receptionist");

    const bookings = await api.allBookings();
    expect(bookings).toHaveLength(1);
    expect((await api.listReaders()).length).toBeGreaterThan(0);
    expect(await api.checkIn(bookings[0].booking_id, "NFC-DT-01")).toMatchObject({ ok: true, code: "checked_in" });

    // still not an admin
    expect(await api.adminInsert("branches", { branch_name: "X", address: "Y", phone_number: "+77270009999" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await api.adminList("members")).toEqual([]);
    expect(await api.attendanceReport()).toEqual([]);
  });
});
