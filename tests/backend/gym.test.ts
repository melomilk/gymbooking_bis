import { describe, it, expect, vi, afterEach } from "vitest";
import { demoApi as api } from "../../src/lib/demoApi";
import { H, DAY, ADMIN, TRAINER, loginAdmin, registerMember, firstSession, adminCreateSession } from "./helpers";
import { formatPhone } from "../../src/lib/validate";

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
    const s = await adminCreateSession(10 * 60_000); // Downtown, starts in 10 min (check-in is open); its reader is NFC-DT-01
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
    const s = await adminCreateSession(10 * 60_000); // Downtown, starts in 10 min (check-in is open)
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

describe("Fixes from the manual test table (cases 2-5)", () => {
  it("TC-22 book: Admin and Receptionist accounts cannot book classes (staff_cannot_book)", async () => {
    const s = await firstSession();
    await loginAdmin();
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "staff_cannot_book" });
    expect((await api.listSessions()).find((x) => x.session_id === s.session_id)!.spots_taken).toBe(s.spots_taken);
  });

  it("TC-23 book: a class that overlaps another booked class is refused (time_conflict)", async () => {
    const a = await adminCreateSession(5 * H);                                                    // 45 min, branch 1
    const b = await adminCreateSession(5 * H + 15 * 60_000, { roomId: 3, branchId: 2, trainerId: 1 }); // starts during a
    const c = await adminCreateSession(5 * H + 45 * 60_000, { roomId: 1, trainerId: 2 });          // starts exactly when a ends
    await registerMember();
    expect(await api.book(a.session_id)).toMatchObject({ ok: true, code: "booked" });
    expect(await api.book(b.session_id)).toMatchObject({ ok: false, code: "time_conflict" });
    expect(await api.book(c.session_id)).toMatchObject({ ok: true, code: "booked" }); // back-to-back is fine
    // b overlaps both a and c: it can be booked only after both are cancelled
    const mine = await api.myBookings((await api.getMe())!.member_id);
    const idOf = (sessionId: number) => mine.find((x) => x.session_id === sessionId)!.booking_id;
    expect(await api.cancel(idOf(a.session_id))).toMatchObject({ ok: true });
    expect(await api.book(b.session_id)).toMatchObject({ ok: false, code: "time_conflict" });
    expect(await api.cancel(idOf(c.session_id))).toMatchObject({ ok: true });
    expect(await api.book(b.session_id)).toMatchObject({ ok: true, code: "booked" });
  });

  it("TC-24 check-in: more than 30 min before the start is refused, booking stays Confirmed (checkin_too_early)", async () => {
    const s = await adminCreateSession(2 * H);
    await registerMember();
    await api.book(s.session_id);
    const memberId = (await api.getMe())!.member_id;
    await api.logout();
    await loginAdmin();
    const booking = (await api.allBookings()).find((x) => x.session_id === s.session_id)!;
    expect(await api.checkIn(booking.booking_id, "NFC-DT-01")).toMatchObject({ ok: false, code: "checkin_too_early" });
    expect((await api.allBookings()).find((x) => x.booking_id === booking.booking_id)!.booking_status).toBe("Confirmed");
    expect(memberId).toBe(booking.member_id);
  });
});

describe("Fixes from the manual test table (cases 6-9)", () => {
  it("TC-25 admin cancels a class: bookings cancelled free, class leaves the schedule, member sees 'cancelled by the gym'", async () => {
    const s = await adminCreateSession(2 * H);
    const m = await registerMember();
    expect(await api.book(s.session_id)).toMatchObject({ ok: true });
    await api.logout();
    await loginAdmin();
    expect(await api.adminDelete("class_sessions", s.session_id)).toMatchObject({ ok: false, code: "in_use" }); // delete stays refused
    expect(await api.cancelSession(s.session_id)).toMatchObject({ ok: true, code: "session_cancelled_done" });
    expect(await api.cancelSession(s.session_id)).toMatchObject({ ok: false, code: "session_is_cancelled" });
    const adminView = (await api.listSessions({ includePast: true, includeCancelled: true })).find((x) => x.session_id === s.session_id)!;
    expect(adminView.cancelled_at).toBeTruthy();
    await api.logout();
    await api.login("+77011112233", "secret123");
    expect((await api.listSessions()).some((x) => x.session_id === s.session_id)).toBe(false);
    const [b] = await api.myBookings(m.member_id);
    expect(b).toMatchObject({ booking_status: "Cancelled", fee_forfeited: false });
    expect(b.session_cancelled_at).toBeTruthy();
    expect(await api.book(s.session_id)).toMatchObject({ ok: false, code: "session_cancelled" });
  });

  it("TC-26 only admins can cancel a class; a cancelled class frees its room and trainer for a new one", async () => {
    const s = await adminCreateSession(3 * H);
    await registerMember();
    expect(await api.cancelSession(s.session_id)).toMatchObject({ ok: false, code: "forbidden" });
    await api.logout();
    await loginAdmin();
    expect(await api.cancelSession(s.session_id)).toMatchObject({ ok: true });
    await api.logout();
    const again = await adminCreateSession(3 * H); // same room, trainer and time: throws if still blocked
    expect(again.session_id).not.toBe(s.session_id);
  });

  it("TC-27 a booked class keeps its date, time, room and class; trainer and capacity can still change", async () => {
    const s = await adminCreateSession(5 * H);
    await registerMember();
    await api.book(s.session_id);
    await api.logout();
    await loginAdmin();
    const base = { class_id: s.class_id, trainer_id: s.trainer_id, room_id: s.room_id, branch_id: s.branch_id,
      start_time: s.start_time, end_time: s.end_time, capacity: s.capacity };
    const shift = (iso: string) => new Date(new Date(iso).getTime() + H).toISOString();
    expect(await api.adminUpdate("class_sessions", s.session_id, { ...base, start_time: shift(s.start_time), end_time: shift(s.end_time) }))
      .toMatchObject({ ok: false, code: "session_has_bookings" });
    expect(await api.adminUpdate("class_sessions", s.session_id, { ...base, room_id: 1 })).toMatchObject({ ok: false, code: "session_has_bookings" });
    expect(await api.adminUpdate("class_sessions", s.session_id, { ...base, class_id: 1 })).toMatchObject({ ok: false, code: "session_has_bookings" });
    expect(await api.adminUpdate("class_sessions", s.session_id, { ...base, trainer_id: 2, capacity: 12 })).toMatchObject({ ok: true, code: "updated" });
  });

  it("TC-28 changing a class's trainer moves it from the old trainer's 'My classes' (bug 9 regression)", async () => {
    const s = await adminCreateSession(4 * H, { trainerId: 1 }); // trainer 1 = the demo trainer account
    await api.login(TRAINER.phone, TRAINER.password);
    expect((await api.trainerRoster()).some((x) => x.session_id === s.session_id)).toBe(true);
    await api.logout();
    await loginAdmin();
    expect(await api.adminUpdate("class_sessions", s.session_id, { class_id: s.class_id, trainer_id: 3, room_id: s.room_id,
      branch_id: s.branch_id, start_time: s.start_time, end_time: s.end_time, capacity: s.capacity })).toMatchObject({ ok: true });
    await api.logout();
    await api.login(TRAINER.phone, TRAINER.password);
    expect((await api.trainerRoster()).some((x) => x.session_id === s.session_id)).toBe(false);
  });
});

describe("Forgotten password (manual test table, case 12)", () => {
  it("TC-29 reset: only the code that was sent works; the new password replaces the old one", async () => {
    await registerMember("+77011112233", "secret123");
    await api.logout();
    const r = await api.requestPasswordReset("8 701 111 22 33"); // any phone format
    expect(r).toMatchObject({ ok: true, code: "reset_code_sent" });
    expect(r.sms_code).toMatch(/^\d{6}$/);
    const wrong = r.sms_code === "000000" ? "111111" : "000000";
    expect(await api.resetPassword({ phone: "+77011112233", token: r.token!, smsCode: wrong, password: "newpass1" }))
      .toMatchObject({ ok: false, code: "reset_bad_code" });
    expect(await api.resetPassword({ phone: "+77011112233", token: r.token!, smsCode: r.sms_code!, password: "123" }))
      .toMatchObject({ ok: false, code: "weak_password" });
    expect(await api.resetPassword({ phone: "+77011112233", token: r.token!, smsCode: r.sms_code!, password: "newpass1" }))
      .toMatchObject({ ok: true, code: "reset_done" });
    expect(await api.login("+77011112233", "secret123")).toMatchObject({ ok: false, code: "bad_credentials" });
    expect(await api.login("+77011112233", "newpass1")).toMatchObject({ ok: true });
    // a code works only once
    expect(await api.resetPassword({ phone: "+77011112233", token: r.token!, smsCode: r.sms_code!, password: "again123" }))
      .toMatchObject({ ok: false, code: "reset_bad_code" });
  });

  it("TC-30 reset: unknown phone and staff accounts are refused", async () => {
    expect(await api.requestPasswordReset("+77019998877")).toMatchObject({ ok: false, code: "reset_unknown_phone" });
    expect(await api.requestPasswordReset(ADMIN.phone)).toMatchObject({ ok: false, code: "reset_staff" });
    expect(await api.requestPasswordReset("+77000000003")).toMatchObject({ ok: false, code: "reset_staff" }); // receptionist
    expect(await api.requestPasswordReset("123")).toMatchObject({ ok: false, code: "invalid_phone" });
  });
});

describe("Excused no-show (valid reason)", () => {
  afterEach(() => vi.useRealTimers());
  const pdf = () => new File(["%PDF-1.4 test"], "note.pdf", { type: "application/pdf" });

  /** A member books a class, then the clock moves past its end -> the booking is a No-show. */
  async function makeNoShow() {
    const s = await adminCreateSession(2 * H);
    const m = await registerMember();
    await api.book(s.session_id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * H);
    const b = (await api.myBookings(m.member_id))[0];
    expect(b).toMatchObject({ booking_status: "No-show", fee_forfeited: true });
    await api.logout();
    return { b, m };
  }

  it("TC-31 illness with a PDF: booking becomes Cancelled, fee returned, reason and file saved", async () => {
    const { b } = await makeNoShow();
    await loginAdmin();
    expect((await api.noShowBookings()).map((x) => x.booking_id)).toContain(b.booking_id);
    expect(await api.excuseNoShow(b.booking_id, { reason: "Illness", note: "flu", file: pdf() }))
      .toMatchObject({ ok: true, code: "excused" });
    const after = (await api.noShowBookings()).find((x) => x.booking_id === b.booking_id)!;
    expect(after).toMatchObject({ booking_status: "Cancelled", fee_forfeited: false, excuse_reason: "Illness", excuse_note: "flu" });
    expect(await api.excuseDocumentUrl(after.excuse_document!)).toMatch(/^data:application\/pdf;base64,/);
    // the miss no longer counts in the attendance report
    const row = (await api.attendanceReport()).find((r) => r.session_id === b.session_id)!;
    expect(row).toMatchObject({ booked: 0, no_show: 0 });
    // excusing twice is refused
    expect(await api.excuseNoShow(b.booking_id, { reason: "Work", note: "", file: null }))
      .toMatchObject({ ok: false, code: "not_no_show" });
  });

  it("TC-32 rules: illness needs a PDF, Other needs a comment, only admins, only no-shows", async () => {
    const { b } = await makeNoShow();
    // a member can't excuse their own miss
    await api.login("+77011112233", "secret123");
    expect(await api.excuseNoShow(b.booking_id, { reason: "Work", note: "", file: null })).toMatchObject({ ok: false, code: "admin_only" });
    await api.logout();
    await loginAdmin();
    expect(await api.excuseNoShow(b.booking_id, { reason: "Illness", note: "", file: null })).toMatchObject({ code: "document_required" });
    const png = new File(["x"], "a.png", { type: "image/png" });
    expect(await api.excuseNoShow(b.booking_id, { reason: "Illness", note: "", file: png })).toMatchObject({ code: "pdf_only" });
    expect(await api.excuseNoShow(b.booking_id, { reason: "Other", note: "  ", file: null })).toMatchObject({ code: "note_required" });
    expect(await api.excuseNoShow(b.booking_id, { reason: "Family", note: "", file: null })).toMatchObject({ ok: true });
    // a booking that is not a no-show can't be excused
    const upcoming = (await api.allBookings()).find((x) => x.booking_status === "Confirmed");
    if (upcoming) expect(await api.excuseNoShow(upcoming.booking_id, { reason: "Work", note: "", file: null })).toMatchObject({ code: "not_no_show" });
  });
});

describe("Manual test table, cases 16-17", () => {
  it("TC-31 phone: every way of writing the same number logs into the same account", async () => {
    await registerMember("7771234567", "secret123"); // 10 digits, no +7
    await api.logout();
    for (const p of ["+7 777 123 45 67", "87771234567", "+7(777)123-45-67", "007 777 123 4567", "77771234567"]) {
      expect(await api.login(p, "secret123")).toMatchObject({ ok: true });
      await api.logout();
    }
    expect(await api.login("777777777", "secret123")).toMatchObject({ ok: false, code: "invalid_phone" }); // 9 digits
    expect(formatPhone("87771234567")).toBe("+7 777 123 45 67");
    expect(formatPhone("+7(777)1234567")).toBe("+7 777 123 45 67");
  });

  it("TC-32 trainer application: a pending one can be corrected and sent again; a reviewed one can't", async () => {
    // files over the demo size limit are listed by name only (no FileReader in Node)
    const pdf = (name: string) => new File([new Uint8Array(701 * 1024)], name, { type: "application/pdf" });
    await registerMember("+77011112233", "secret123");
    const input = { email: "coach@mail.kz", specialization: "Yoga", experience_years: 3, bio: "" };
    expect(await api.submitTrainerApplication(input, [pdf("one.pdf"), pdf("two.pdf")])).toMatchObject({ ok: true });
    const sent = (await api.myTrainerApplication())!;

    // fix the specialization, drop one file, add a new one
    expect(await api.updateTrainerApplication({ ...input, specialization: "Pilates" }, [sent.certificates[0]], [pdf("three.pdf")]))
      .toMatchObject({ ok: true, code: "application_updated" });
    const updated = (await api.myTrainerApplication())!;
    expect(updated.application_id).toBe(sent.application_id);
    expect(updated.status).toBe("Pending");
    expect(updated.specialization).toBe("Pilates");
    expect(updated.certificates.map((c) => c.name)).toEqual(["one.pdf", "three.pdf"]);
    expect(await api.updateTrainerApplication(input, [], [])).toMatchObject({ ok: false, code: "certificates_required" });

    // reviewed -> can't be edited any more
    await api.logout();
    await loginAdmin();
    expect(await api.reviewTrainerApplication(sent.application_id, false, "Unreadable files")).toMatchObject({ ok: true });
    await api.logout();
    await api.login("+77011112233", "secret123");
    expect(await api.updateTrainerApplication(input, [], [pdf("x.pdf")])).toMatchObject({ ok: false, code: "application_not_pending" });
  });
});
