// Pulse points & rewards, waitlist, class reviews (demo API, same rules as the
// migrations migration_points_rewards.sql, migration_waitlist.sql, migration_reviews.sql).
import { describe, it, expect, vi, afterEach } from "vitest";
import { demoApi as api } from "../../src/lib/demoApi";
import { H, loginAdmin, registerMember, adminCreateSession } from "./helpers";

const MEMBER = { phone: "+77000000004", password: "member123" };       // demo member with visit history
const RECEPTION = { phone: "+77000000003", password: "reception123" };
const TRAINER_1 = { phone: "+77000000002", password: "trainer123" };   // linked to trainer 1 (Aigerim S.)

async function login(a: { phone: string; password: string }) {
  const r = await api.login(a.phone, a.password);
  if (!r.ok) throw new Error("login failed: " + r.code);
}
/** Admin sets a reward's price (to make it affordable in a test). */
async function setCost(name: string, cost: number) {
  await loginAdmin();
  const w = (await api.adminList("rewards")).find((r) => r.reward_name === name)!;
  const r = await api.adminUpdate("rewards", Number(w.reward_id), { cost });
  if (!r.ok) throw new Error("setCost failed: " + r.code);
  await api.logout();
  return Number(w.reward_id);
}

describe("Pulse points", () => {
  afterEach(() => vi.useRealTimers());

  it("TC-P1 balance equals the sum of the history; points come only from visits", async () => {
    await login(MEMBER);
    const p = (await api.myPoints())!;
    const history = await api.myPointsHistory();
    expect(p.balance).toBe(history.reduce((a, e) => a + e.delta, 0));
    expect(history.some((e) => e.reason === "attended" && e.delta === 10)).toBe(true);
    expect(history.some((e) => e.reason === "no_show" && e.delta === -5)).toBe(true);
    expect(p.lifetime).toBeGreaterThanOrEqual(p.balance);
  });

  it("TC-P2 a new member has 0; a booking gives nothing; an NFC check-in gives +10", async () => {
    const s = await adminCreateSession(10 * 60_000); // starts in 10 min (check-in is open)
    await registerMember("+77015550101");
    expect((await api.myPoints())!.balance).toBe(0);
    expect((await api.book(s.session_id)).ok).toBe(true);
    expect((await api.myPoints())!.balance).toBe(0);
    const me = (await api.getMe())!;
    const bookingId = (await api.myBookings(me.member_id))[0].booking_id;
    await loginAdmin();
    expect((await api.checkIn(bookingId, "NFC-DT-01")).code).toBe("checked_in");
    await api.login("+77015550101", "secret123");
    expect((await api.myPoints())!.balance).toBe(10);
  });

  it("TC-P3 no-show costs 5 points; an excused no-show gives them back", async () => {
    const s = await adminCreateSession(5 * H);
    await registerMember("+77015550102");
    await api.book(s.session_id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7 * H); // the class is over, nobody came
    const me = (await api.getMe())!;
    const b = (await api.myBookings(me.member_id))[0];
    expect(b.booking_status).toBe("No-show");
    expect((await api.myPoints())!.balance).toBe(-5);
    await loginAdmin();
    expect((await api.excuseNoShow(b.booking_id, { reason: "Work", note: "", file: null })).code).toBe("excused");
    await api.login("+77015550102", "secret123");
    expect((await api.myPoints())!.balance).toBe(0);
  });

  it("TC-P4 leaderboard shows only first name + initial and marks the caller", async () => {
    await login(MEMBER);
    const b = (await api.leaderboard())!;
    const me = b.top.find((r) => r.is_me);
    if (me) expect(me.name).toBe("Aruzhan B.");
    for (const r of b.top) expect(r.name).toMatch(/^\S+ \S\.$/);
  });
});

describe("Rewards", () => {
  it("TC-R1 not enough points is rejected; a late-cancel pass can be held only once", async () => {
    await login(MEMBER);
    const before = (await api.myPoints())!.balance;
    const shirt = (await api.listRewards()).find((r) => r.reward_name === "PulseGym T-shirt")!;
    expect((await api.redeemReward(shirt.reward_id)).code).toBe("not_enough_points");
    const pass = (await api.listRewards()).find((r) => r.kind === "late_cancel_pass")!;
    expect((await api.redeemReward(pass.reward_id)).code).toBe("redeemed");
    expect((await api.myPoints())!.balance).toBe(before - pass.cost);
    expect((await api.redeemReward(pass.reward_id)).code).toBe("pass_already_active");
  });

  it("TC-R2 a late cancellation with a pass costs no fee and uses the pass", async () => {
    const s = await adminCreateSession(2 * H);
    await login(MEMBER);
    const pass = (await api.listRewards()).find((r) => r.kind === "late_cancel_pass")!;
    await api.redeemReward(pass.reward_id);
    await api.book(s.session_id);
    const me = (await api.getMe())!;
    const b = (await api.myBookings(me.member_id)).find((x) => x.session_id === s.session_id)!;
    expect((await api.cancel(b.booking_id, true)).code).toBe("cancelled_fee_forfeited"); // same code as the DB
    const after = (await api.myBookings(me.member_id)).find((x) => x.booking_id === b.booking_id)!;
    expect(after.fee_forfeited).toBe(false);
    expect((await api.myRedemptions()).find((r) => r.kind === "late_cancel_pass")!.status).toBe("Used");
  });

  it("TC-R3 free visit: code for the front desk; only staff can mark it handed out, once", async () => {
    const id = await setCost("Free single visit", 10);
    await login(MEMBER);
    const r = await api.redeemReward(id);
    expect(r.code).toBe("redeemed");
    expect(r.redemption_code).toMatch(/^PG-[A-Z0-9]{6}$/);
    const red = (await api.myRedemptions())[0];
    expect((await api.useRedemption(red.redemption_id)).code).toBe("staff_only");
    await login(RECEPTION);
    expect((await api.staffRedemptions()).some((x) => x.code === r.redemption_code)).toBe(true);
    expect((await api.useRedemption(red.redemption_id)).code).toBe("redemption_used");
    expect((await api.useRedemption(red.redemption_id)).code).toBe("redemption_not_active");
    expect((await api.redeemReward(id)).code).toBe("staff_cannot_redeem");
  });

  it("TC-R4 cancelling an unused reward returns the points and the stock", async () => {
    const id = await setCost("PulseGym T-shirt", 10);
    await login(MEMBER);
    const before = (await api.myPoints())!.balance;
    const stock = (await api.listRewards()).find((w) => w.reward_id === id)!.stock!;
    await api.redeemReward(id);
    expect((await api.listRewards()).find((w) => w.reward_id === id)!.stock).toBe(stock - 1);
    const red = (await api.myRedemptions())[0];
    expect((await api.cancelRedemption(red.redemption_id)).code).toBe("redemption_cancelled");
    expect((await api.myPoints())!.balance).toBe(before);
    expect((await api.listRewards()).find((w) => w.reward_id === id)!.stock).toBe(stock);
    expect((await api.cancelRedemption(red.redemption_id)).code).toBe("redemption_not_active");
  });

  it("TC-R5 membership days are added at once", async () => {
    const id = await setCost("+7 days of membership", 10);
    await login(MEMBER);
    const before = (await api.getMe())!.membership_expiry;
    await api.redeemReward(id);
    const after = (await api.getMe())!.membership_expiry;
    expect((Date.parse(after) - Date.parse(before)) / 86400_000).toBe(7);
  });
});

describe("Waitlist", () => {
  it("TC-W1 full class: join the queue; when a place frees up the first in line is booked", async () => {
    const s = await adminCreateSession(2 * 24 * H, { capacity: 1 });
    await registerMember("+77015550201");
    expect((await api.joinWaitlist(s.session_id)).code).toBe("has_free_places");
    await api.book(s.session_id);
    await api.logout();
    await registerMember("+77015550202");
    const j = await api.joinWaitlist(s.session_id);
    expect(j).toMatchObject({ ok: true, code: "waitlist_joined", position: 1 });
    expect((await api.joinWaitlist(s.session_id)).code).toBe("already_waiting");
    expect((await api.waitlistCounts())[s.session_id]).toBe(1);

    await api.login("+77015550201", "secret123");
    const me1 = (await api.getMe())!;
    await api.cancel((await api.myBookings(me1.member_id))[0].booking_id);

    await api.login("+77015550202", "secret123");
    const me2 = (await api.getMe())!;
    expect((await api.myBookings(me2.member_id))[0].booking_status).toBe("Confirmed");
    expect((await api.myWaitlist())[0]).toMatchObject({ status: "Promoted", promoted_auto: true });
  });

  it("TC-W2 the queue closes 3 hours before the start", async () => {
    const s = await adminCreateSession(2 * H, { capacity: 1 });
    await registerMember("+77015550203");
    await api.book(s.session_id);
    await api.logout();
    await registerMember("+77015550204");
    expect((await api.joinWaitlist(s.session_id)).code).toBe("waitlist_closed");
  });

  it("TC-W3 the admin raises capacity -> the queue is booked; cancels the class -> the queue expires", async () => {
    const s = await adminCreateSession(2 * 24 * H, { capacity: 1 });
    await registerMember("+77015550205"); await api.book(s.session_id); await api.logout();
    await registerMember("+77015550206"); await api.joinWaitlist(s.session_id); await api.logout();
    await registerMember("+77015550207"); await api.joinWaitlist(s.session_id); await api.logout();
    await loginAdmin();
    const row = (await api.adminList("class_sessions")).find((r) => r.session_id === s.session_id)!;
    expect((await api.adminUpdate("class_sessions", s.session_id, { ...row, capacity: 2 })).ok).toBe(true);
    expect((await api.cancelSession(s.session_id)).ok).toBe(true);
    await api.login("+77015550206", "secret123");
    expect((await api.myWaitlist())[0].status).toBe("Promoted");
    await api.login("+77015550207", "secret123");
    expect((await api.myWaitlist())[0]).toMatchObject({ status: "Expired", status_reason: "session_cancelled" });
  });
});

describe("Reviews", () => {
  it("TC-V1 only an attended class can be rated; first review +5, editing gives nothing more", async () => {
    await login(MEMBER);
    const me = (await api.getMe())!;
    const before = (await api.myPoints())!.balance;
    const already = new Set((await api.myReviews()).map((r) => r.booking_id));
    const b = (await api.myBookings(me.member_id)).find((x) => x.booking_status === "Attended"
      && Date.now() - Date.parse(x.end_time) < 10 * 24 * H && !already.has(x.booking_id))!;
    expect((await api.submitReview(b.booking_id, 6, "")).code).toBe("invalid_rating");
    expect((await api.submitReview(b.booking_id, 4, "Good class")).code).toBe("review_saved_points");
    expect((await api.submitReview(b.booking_id, 5, "Great class")).code).toBe("review_saved");
    expect((await api.myPoints())!.balance).toBe(before + 5);
    const missed = (await api.myBookings(me.member_id)).find((x) => x.booking_status === "No-show")!;
    expect((await api.submitReview(missed.booking_id, 5, "")).code).toBe("review_not_attended");
  });

  it("TC-V2 trainer sees reviews without names; admin sees names and can remove one (-5)", async () => {
    await login(TRAINER_1);
    const mine = await api.listReviews();
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.member_fullname).toBeNull();
    expect((await api.deleteReview(mine[0].review_id)).code).toBe("admin_only");

    await loginAdmin();
    const all = await api.listReviews();
    expect(all[0].member_fullname).toBeTruthy();
    await login(MEMBER);
    const before = (await api.myPoints())!.balance;
    await loginAdmin();
    expect((await api.deleteReview(all[0].review_id)).code).toBe("review_deleted");
    await login(MEMBER);
    expect((await api.myPoints())!.balance).toBe(before - 5);
    expect((await api.trainerRatings()).length).toBe(0);
  });
});
