// "Going with a friend" (demo API, same rules as supabase/migration_buddy_invite.sql).
import { describe, it, expect, vi, afterEach } from "vitest";
import { demoApi as api } from "../../src/lib/demoApi";
import { DAY, H, loginAdmin, registerMember, adminCreateSession } from "./helpers";

const RECEPTION = { phone: "+77000000003", password: "reception123" };
const A = "+77015550201", B = "+77015550202", C = "+77015550203";
const PW = "secret123";

async function as(phone: string, password = PW) {
  const r = await api.login(phone, password);
  if (!r.ok) throw new Error("login failed: " + phone + " " + r.code);
  return (await api.getMe())!;
}
/** Registers the three test members (A, B, C), then logs everybody out. */
async function people(...phones: string[]) {
  for (const p of phones) await registerMember(p, PW);
  await api.logout();
}
/** The current member books the class and returns the booking id. */
async function bookAs(phone: string, sessionId: number) {
  const m = await as(phone);
  const r = await api.book(sessionId);
  if (!r.ok) throw new Error("book failed: " + r.code);
  return (await api.myBookings(m.member_id)).find((b) => b.session_id === sessionId)!.booking_id;
}
const spots = async (sessionId: number) => (await api.listSessions()).find((s) => s.session_id === sessionId)!.spots_taken;

describe("Going with a friend", () => {
  afterEach(() => vi.useRealTimers());

  it("TC-39 an invitation holds a place for 2 hours; wrong numbers are refused", async () => {
    const s = await adminCreateSession(5 * H, { capacity: 2 });
    await people(A, B, C);
    const a = await bookAs(A, s.session_id);
    expect((await api.inviteBuddy(a, "123")).code).toBe("invalid_phone");
    expect((await api.inviteBuddy(a, A)).code).toBe("buddy_self");
    expect((await api.inviteBuddy(a, RECEPTION.phone)).code).toBe("buddy_staff");
    expect((await api.inviteBuddy(9999, B)).code).toBe("booking_not_found");
    const r = await api.inviteBuddy(a, "8 701 555 02 02"); // any format -> +77015550202
    expect(r.code).toBe("buddy_invited");
    expect(Math.abs(new Date(r.expires_at!).getTime() - (Date.now() + 2 * H))).toBeLessThan(60_000);
    expect((await api.inviteBuddy(a, C)).code).toBe("buddy_already_invited"); // one friend per booking
    expect(await spots(s.session_id)).toBe(2);                              // A + the held place
    const sent = (await api.myBuddyInvites())[0];
    expect([sent.direction, sent.status, sent.friend_phone]).toEqual(["sent", "Pending", B]);
    await as(C);
    expect((await api.book(s.session_id)).code).toBe("class_full");          // the held place is not free
  });

  it("TC-40 the friend accepts: the held place becomes their booking", async () => {
    const s = await adminCreateSession(5 * H, { capacity: 2 });
    await people(A, B, C);
    const a = await bookAs(A, s.session_id);
    await api.inviteBuddy(a, B);
    await as(B);
    const id = (await api.myBuddyInvites())[0].invite_id;
    await as(C);
    expect(await api.myBuddyInvites()).toEqual([]);                        // not C's invitation
    expect((await api.acceptBuddyInvite(id)).code).toBe("invite_not_found");
    const b = await as(B);
    const got = (await api.myBuddyInvites())[0];
    expect([got.direction, got.status, got.inviter_name, got.friend_phone]).toEqual(["received", "Pending", "Test U.", null]);
    expect((await api.acceptBuddyInvite(id)).code).toBe("buddy_accepted");
    expect((await api.acceptBuddyInvite(id)).code).toBe("invite_not_pending");
    const mine = (await api.myBookings(b.member_id)).find((x) => x.session_id === s.session_id)!;
    expect(mine.booking_status).toBe("Confirmed");
    expect(await spots(s.session_id)).toBe(2);                              // still 2: the hold turned into a booking
    await as(A);
    const sent = (await api.myBuddyInvites())[0];
    expect([sent.status, sent.friend_name, sent.friend_booking_id]).toEqual(["Accepted", "Test U.", mine.booking_id]);
  });

  it("TC-41 a friend without an account signs up with the number and accepts", async () => {
    const s = await adminCreateSession(5 * H, { capacity: 5 });
    await people(A);
    const a = await bookAs(A, s.session_id);
    expect((await api.inviteBuddy(a, "+77015550299")).code).toBe("buddy_invited");
    await registerMember("+77015550299", PW);                               // registers within the 2 hours
    const got = await api.myBuddyInvites();
    expect(got.map((i) => [i.direction, i.status])).toEqual([["received", "Pending"]]);
    expect((await api.acceptBuddyInvite(got[0].invite_id)).code).toBe("buddy_accepted");
  });

  it("TC-42 after 2 hours the hold ends by itself and the waitlist gets the place", async () => {
    const s = await adminCreateSession(2 * DAY, { capacity: 2 });
    await people(A, B, C);
    const a = await bookAs(A, s.session_id);
    await api.inviteBuddy(a, B);
    await as(C);
    expect((await api.joinWaitlist(s.session_id)).code).toBe("waitlist_joined"); // full because of the hold
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * H + 60_000);
    const c = await as(C);
    expect((await api.myBookings(c.member_id)).find((x) => x.session_id === s.session_id)?.booking_status).toBe("Confirmed");
    await as(B);
    const got = (await api.myBuddyInvites())[0];
    expect(got.status).toBe("Expired");
    expect((await api.acceptBuddyInvite(got.invite_id)).code).toBe("invite_not_pending");
    await as(A);
    expect((await api.inviteBuddy(a, B)).code).toBe("class_full");          // the place is gone now
  });

  it("TC-43 the hold never lasts past the start; decline / take back / cancel free the place", async () => {
    const soon = await adminCreateSession(40 * 60_000, { capacity: 5 });
    await people(A, B, C);
    const a1 = await bookAs(A, soon.session_id);
    const r = await api.inviteBuddy(a1, B);
    expect(new Date(r.expires_at!).getTime()).toBe(new Date(soon.start_time).getTime());

    const s = await adminCreateSession(5 * H, { capacity: 5, roomId: 1, trainerId: 2 });
    const a2 = await bookAs(A, s.session_id);
    await api.inviteBuddy(a2, C);
    expect(await spots(s.session_id)).toBe(2);
    await as(C);
    const toC = (await api.myBuddyInvites())[0];
    expect((await api.declineBuddyInvite(toC.invite_id)).code).toBe("buddy_declined");
    expect(await spots(s.session_id)).toBe(1);

    await as(A);
    expect((await api.inviteBuddy(a2, C)).code).toBe("buddy_invited");      // a new invitation after a "no"
    const again = (await api.myBuddyInvites()).find((i) => i.status === "Pending" && i.session_id === s.session_id)!;
    expect((await api.withdrawBuddyInvite(again.invite_id)).code).toBe("buddy_withdrawn");
    expect((await api.withdrawBuddyInvite(again.invite_id)).code).toBe("invite_not_pending");
    expect(await spots(s.session_id)).toBe(1);

    await api.inviteBuddy(a2, C);
    expect((await api.cancel(a2)).code).toBe("cancelled");                  // the inviter cancels
    expect(await spots(s.session_id)).toBe(0);
    expect((await api.myBuddyInvites()).find((i) => i.session_id === s.session_id && i.invite_id > again.invite_id)?.status).toBe("Cancelled");
  });

  it("TC-44 both checked in -> +15 points each, once; only one came -> nothing", async () => {
    const s = await adminCreateSession(10 * 60_000, { capacity: 5 }); // check-in is open
    await people(A, B, C);
    const a = await bookAs(A, s.session_id);
    await api.inviteBuddy(a, B);
    await as(B);
    await api.acceptBuddyInvite((await api.myBuddyInvites())[0].invite_id);
    const b = (await api.myBookings((await api.getMe())!.member_id))[0].booking_id;
    const c = await bookAs(C, s.session_id);   // C came alone, nobody invited them

    await as(RECEPTION.phone, RECEPTION.password);
    expect((await api.checkIn(a, "NFC-DT-01")).code).toBe("checked_in");
    await as(A);
    expect((await api.myPointsHistory()).some((e) => e.reason === "buddy_bonus")).toBe(false); // the friend isn't here yet
    await as(RECEPTION.phone, RECEPTION.password);
    expect((await api.checkIn(b, "NFC-DT-01")).code).toBe("checked_in");
    expect((await api.checkIn(c, "NFC-DT-01")).code).toBe("checked_in");
    expect((await api.checkIn(b, "NFC-DT-01")).code).toBe("already_checked_in");

    for (const phone of [A, B]) {
      await as(phone);
      const bonus = (await api.myPointsHistory()).filter((e) => e.reason === "buddy_bonus");
      expect(bonus.map((e) => e.delta)).toEqual([15]);
      const p = (await api.myPoints())!;
      expect([p.balance, p.lifetime]).toEqual([25, 25]);                     // 10 for the class + 15
      expect((await api.myBuddyInvites())[0].bonus_at).not.toBeNull();
    }
    await as(C);
    expect((await api.myPoints())!.balance).toBe(10);
  });

  it("TC-45 limits: friend already booked, number already invited, at most 3 holds", async () => {
    const s = await adminCreateSession(5 * H, { capacity: 10 });
    await people(A, B, C);
    await bookAs(B, s.session_id);
    const a = await bookAs(A, s.session_id);
    expect((await api.inviteBuddy(a, B)).code).toBe("buddy_already_booked");
    const c = await bookAs(C, s.session_id);
    await as(A);
    await api.inviteBuddy(a, "+77015550290");
    await as(C);
    expect((await api.inviteBuddy(c, "+77015550290")).code).toBe("buddy_friend_invited");

    // A holds places in 3 other classes -> the 4th is refused
    await loginAdmin();
    const ids: number[] = [];
    for (let i = 1; i <= 3; i++) ids.push((await adminCreateSession(i * DAY, { capacity: 10 })).session_id);
    for (const [i, sid] of ids.entries()) {
      const bk = await bookAs(A, sid);
      expect((await api.inviteBuddy(bk, `+7701555030${i}`)).code).toBe(i < 2 ? "buddy_invited" : "buddy_limit");
    }
    await as(A);
    await api.logout();
    expect((await api.inviteBuddy(a, "+77015550299")).code).toBe("not_signed_in");
  });
});
