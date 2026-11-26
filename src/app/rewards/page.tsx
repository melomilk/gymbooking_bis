"use client";
// Pulse points: balance, level, streak, badges, the reward catalog, the
// member's rewards with front-desk codes, this month's leaderboard and history.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth, useT } from "@/components/Providers";
import Modal from "@/components/Modal";
import Toast, { type ToastMsg } from "@/components/Toast";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { Key } from "@/lib/i18n";
import { badgesFor, levelFor } from "@/lib/rewards";
import { POINTS, type BookingRow, type Leaderboard, type PointsEntry, type PointsSummary, type Redemption, type Reward } from "@/lib/types";

type Data = {
  points: PointsSummary | null; history: PointsEntry[]; rewards: Reward[]; mine: Redemption[];
  board: Leaderboard | null; bookings: BookingRow[]; reviews: number;
};

export default function RewardsPage() {
  const router = useRouter();
  const { me, loading: authLoading, refresh } = useAuth();
  const { t, tr, lang } = useT();
  const [d, setD] = useState<Data | null>(null);
  const [confirm, setConfirm] = useState<Reward | null>(null);
  const [got, setGot] = useState<{ reward: Reward; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMsg>(null);

  const load = useCallback(async () => {
    if (!me) return;
    const [points, history, rewards, mine, board, bookings, reviews] = await Promise.all([
      api.myPoints(), api.myPointsHistory(), api.listRewards(), api.myRedemptions(), api.leaderboard(),
      api.myBookings(me.member_id), api.myReviews(),
    ]);
    setD({ points, history, rewards, mine, board, bookings, reviews: reviews.length });
  }, [me]);

  useEffect(() => {
    if (authLoading) return;
    if (!me) router.replace("/login");
    else load();
  }, [authLoading, me, load, router]);

  async function redeem(w: Reward) {
    setBusy(true);
    const r = await api.redeemReward(w.reward_id);
    setBusy(false);
    setConfirm(null);
    if (!r.ok) { setToast({ ok: false, text: tr(r) }); return; }
    setGot({ reward: w, code: r.redemption_code ?? "" });
    if (w.kind === "membership_days") await refresh(); // new expiry date in the profile
    load();
  }

  async function cancelReward(x: Redemption) {
    const r = await api.cancelRedemption(x.redemption_id);
    setToast({ ok: r.ok, text: tr(r) });
    if (r.ok) load();
  }

  if (authLoading || !me || !d) return <p className="muted">{t("loading")}</p>;
  const staff = me.role === "Admin" || me.role === "Receptionist";
  if (staff) return <><h1>{t("rewards_title")}</h1><div className="notice">{t("rewards_staff_note")}</div></>;
  if (!d.points) return <><h1>{t("rewards_title")}</h1><div className="notice">{t("points_unavailable")}</div></>;

  const p = d.points;
  const lv = levelFor(p.lifetime);
  const badges = badgesFor(d.bookings, p, d.reviews);
  const activeMine = d.mine.filter((x) => x.status === "Active");

  return (
    <>
      <h1>{t("rewards_title")}</h1>

      <section className="points-hero" aria-label={t("points_balance")}>
        <div>
          <div className="small muted">{t("points_balance")}</div>
          <div className="points-big" data-balance={p.balance}>{p.balance}</div>
          <div className="small muted">{t("points_month", { n: p.month_points })}</div>
        </div>
        <div className="level-box">
          <div><span className="small muted">{t("points_level")}</span> <b>{t(`level_${lv.level.id}` as Key)}</b></div>
          <div className="level-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lv.progress * 100)}>
            <div style={{ width: `${lv.progress * 100}%` }} />
          </div>
          <div className="small muted">
            {lv.next ? t("level_to_next", { n: lv.toNext, level: t(`level_${lv.next.id}` as Key) }) : t("level_max")}
          </div>
        </div>
        <div className="streak-box">
          <div className="streak-num">🔥 {p.streak}</div>
          <div className="small muted">{t("streak_weeks", { n: p.streak })}</div>
          <div className="small muted">{t("streak_next_bonus", { n: POINTS.streak_every - (p.streak % POINTS.streak_every), bonus: POINTS.streak_bonus })}</div>
        </div>
      </section>

      <details className="rules">
        <summary>{t("points_how")}</summary>
        <ul className="small">
          <li>{t("rule_attended", { n: POINTS.attended })}</li>
          <li>{t("rule_streak", { n: POINTS.streak_bonus, weeks: POINTS.streak_every })}</li>
          <li>{t("rule_review", { n: POINTS.review })}</li>
          <li>{t("rule_buddy", { n: POINTS.buddy_bonus })}</li>
          <li>{t("rule_no_show", { n: -POINTS.no_show })}</li>
          <li>{t("rule_level")}</li>
        </ul>
      </details>

      <h2>{t("rewards_catalog")}</h2>
      {d.rewards.length === 0 ? <p className="muted">{t("rewards_empty")}</p> : (
        <div className="grid rewards-grid">
          {d.rewards.map((w) => {
            const out = w.stock !== null && w.stock <= 0;
            const short = w.cost - p.balance;
            return (
              <article key={w.reward_id} className={`card reward kind-${w.kind}`} data-reward={w.reward_id}>
                <div className="card-top">
                  <h3>{w.reward_name}</h3>
                  <span className="cost">{w.cost} <span className="small">{t("pts")}</span></span>
                </div>
                <span className="pill small">{t(`rk_${w.kind}` as Key)}</span>
                {w.description && <p className="small muted">{w.description}</p>}
                <p className="small">{t(`rk_${w.kind}_how` as Key, { days: w.extend_days ?? 0 })}</p>
                <div className="card-bottom">
                  <span className="small muted">{w.stock === null ? "" : out ? t("out_of_stock_short") : t("stock_left", { n: w.stock })}</span>
                  <button className="btn" disabled={out || short > 0} onClick={() => setConfirm(w)}>
                    {short > 0 ? t("points_short", { n: short }) : t("redeem_btn")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <h2>{t("my_rewards")}</h2>
      {d.mine.length === 0 ? <p className="muted">{t("my_rewards_empty")}</p> : (
        <ul className="list" id="my-rewards">
          {[...activeMine, ...d.mine.filter((x) => x.status !== "Active")].map((x) => (
            <li key={x.redemption_id} className="row-item" data-redemption={x.redemption_id}>
              <div>
                <b>{x.reward_name}</b> <span className="muted small">· {x.cost} {t("pts")} · {fmtDateTime(x.created_at, lang)}</span>
                {x.status === "Active" && (
                  <div className="small">
                    {x.kind === "late_cancel_pass" ? t("pass_active_note") : <>{t("show_code_note")} <b className="code">{x.code}</b></>}
                  </div>
                )}
                {x.kind === "membership_days" && <div className="small muted">{t("membership_extended", { days: x.extend_days ?? 0, date: fmtDate(me.membership_expiry, lang) })}</div>}
              </div>
              <div className="right">
                <span className={`pill rs-${x.status.toLowerCase()}`}>{t(`rs_${x.status}` as Key)}</span>
                {x.status === "Active" && <button className="btn ghost" onClick={() => cancelReward(x)}>{t("redemption_cancel")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2>{t("badges_title")}</h2>
      <div className="badges">
        {badges.map((b) => (
          <div key={b.id} className={`badge ${b.earned ? "earned" : ""}`} data-badge={b.id} title={t(`badge_${b.id}_desc` as Key)}>
            <span className="badge-icon" aria-hidden>{b.icon}</span>
            <b className="small">{t(`badge_${b.id}` as Key)}</b>
            <span className="small muted">{b.earned ? t("badge_earned") : b.progress}</span>
          </div>
        ))}
      </div>

      <h2>{t("leaderboard_title")}</h2>
      {!d.board || d.board.top.length === 0 ? <p className="muted">{t("leaderboard_empty")}</p> : (
        <>
          <ol className="leaderboard">
            {d.board.top.map((r) => (
              <li key={`${r.place}-${r.name}`} className={r.is_me ? "me" : ""}>
                <span className="place">{r.place <= 3 ? ["🥇", "🥈", "🥉"][r.place - 1] : r.place}</span>
                <span className="who">{r.name}{r.is_me ? ` (${t("you")})` : ""}</span>
                <b>{r.points}</b>
              </li>
            ))}
          </ol>
          {d.board.me && !d.board.top.some((r) => r.is_me) && (
            <p className="small">{t("leaderboard_me", { place: d.board.me.place, n: d.board.me.points })}</p>
          )}
          <p className="small muted">{t("leaderboard_note")}</p>
        </>
      )}

      <h2>{t("points_history")}</h2>
      {d.history.length === 0 ? (
        <p className="muted">{t("points_history_empty")} <Link href="/">{t("browse_classes")}</Link></p>
      ) : (
        <ul className="list history-points">
          {d.history.map((e) => (
            <li key={e.entry_id} className="row-item">
              <div>
                <b>{t(`pr_${e.reason}` as Key)}</b>
                <span className="small muted"> · {[e.class_name ?? e.reward_name, fmtDateTime(e.created_at, lang)].filter(Boolean).join(" · ")}</span>
              </div>
              <b className={e.delta > 0 ? "good-text" : "bad-text"}>{e.delta > 0 ? `+${e.delta}` : e.delta}</b>
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <Modal title={t("redeem_confirm_title")} onClose={() => setConfirm(null)} actions={<>
          <button className="btn ghost" onClick={() => setConfirm(null)}>{t("close")}</button>
          <button className="btn" disabled={busy} onClick={() => redeem(confirm)}>{busy ? t("please_wait") : t("redeem_confirm_yes", { n: confirm.cost })}</button>
        </>}>
          <p>{t("redeem_confirm_body", { name: confirm.reward_name, n: confirm.cost, left: p.balance - confirm.cost })}</p>
          <p className="small muted">{t(`rk_${confirm.kind}_how` as Key, { days: confirm.extend_days ?? 0 })}</p>
        </Modal>
      )}

      {got && (
        <Modal title={t("redeemed_title")} onClose={() => setGot(null)} actions={<button className="btn" onClick={() => setGot(null)}>{t("close")}</button>}>
          <p><b>{got.reward.reward_name}</b></p>
          {got.reward.kind === "free_class" || got.reward.kind === "merch" ? (
            <>
              <p>{t("show_code_note")}</p>
              <p className="big-code" data-code={got.code}>{got.code}</p>
            </>
          ) : (
            <p>{t(`rk_${got.reward.kind}_how` as Key, { days: got.reward.extend_days ?? 0 })}</p>
          )}
        </Modal>
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
