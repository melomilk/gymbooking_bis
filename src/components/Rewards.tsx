"use client";
// Pieces shared by several pages: star rating, review dialog, the front-desk
// list of rewards to hand out, the review list (trainer / admin) and the
// admin's reward catalog editor.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtDateTime, fmtDayShort, fmtTime } from "@/lib/format";
import type { Key } from "@/lib/i18n";
import { REVIEW_MAX_CHARS, REWARD_KINDS, type BookingRow, type MyReview, type Redemption, type Result, type Review, type Row } from "@/lib/types";
import CrudSection, { type CrudConfig } from "./CrudSection";
import Modal from "./Modal";
import { useT } from "./Providers";

// ---------- stars ----------
/** Read-only stars, e.g. ★★★★☆ 4.2 */
export function Stars({ value, count }: { value: number; count?: number }) {
  const { t } = useT();
  const full = Math.round(value);
  return (
    <span className="stars" aria-label={t("rating_aria", { value: value.toFixed(1) })} title={value.toFixed(1)}>
      <span aria-hidden>{"★".repeat(full)}<span className="stars-off">{"★".repeat(5 - full)}</span></span>
      <span className="small muted"> {value.toFixed(1)}{count !== undefined ? ` (${count})` : ""}</span>
    </span>
  );
}

/** 1-5 stars input (radio buttons, works with the keyboard). */
function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useT();
  return (
    <div className="star-input" role="radiogroup" aria-label={t("review_rating")}>
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className={n <= value ? "on" : ""} title={t(`stars_${n}` as Key)}>
          <input type="radio" name="rating" value={n} checked={value === n} onChange={() => onChange(n)} />
          <span aria-hidden>★</span>
          <span className="sr-only">{t(`stars_${n}` as Key)}</span>
        </label>
      ))}
      <span className="small muted">{value ? t(`stars_${value}` as Key) : ""}</span>
    </div>
  );
}

// ---------- review dialog ----------
export function ReviewModal({ booking, existing, onClose, onSaved }: {
  booking: BookingRow; existing?: MyReview; onClose: () => void; onSaved: (r: Result) => void;
}) {
  const { t, tr, lang } = useT();
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!rating) return setError(tr({ code: "invalid_rating" }));
    setBusy(true);
    const r = await api.submitReview(booking.booking_id, rating, comment);
    setBusy(false);
    if (!r.ok) return setError(tr(r));
    onSaved(r);
  }

  return (
    <Modal title={existing ? t("review_edit_title") : t("review_title")} onClose={onClose} actions={<>
      <button className="btn ghost" onClick={onClose}>{t("close")}</button>
      <button className="btn" disabled={busy} onClick={save}>{busy ? t("please_wait") : t("review_send")}</button>
    </>}>
      <p className="small muted">{booking.class_name} · {t("with_trainer", { name: booking.trainer_name })} · {fmtDayShort(booking.start_time, lang)}, {fmtTime(booking.start_time)}</p>
      <StarInput value={rating} onChange={(v) => { setRating(v); setError(null); }} />
      <label className="form">{t("review_comment")}
        <textarea rows={3} maxLength={REVIEW_MAX_CHARS} value={comment} onChange={(e) => setComment(e.target.value)} />
        <span className="small muted">{t("review_hint")}</span>
      </label>
      {!existing && <p className="small good-text">{t("review_points_hint")}</p>}
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Modal>
  );
}

// ---------- front desk: hand out rewards ----------
export function StaffRedemptions({ onResult }: { onResult: (r: Result) => void }) {
  const { t, lang } = useT();
  const [rows, setRows] = useState<Redemption[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => setRows(await api.staffRedemptions()), []);
  useEffect(() => { load(); }, [load]);

  async function act(id: number, fn: (id: number) => Promise<Result>) {
    setBusy(id);
    const r = await fn(id);
    setBusy(null);
    onResult(r);
    if (r.ok) load();
  }

  if (!rows) return <p className="muted">{t("loading")}</p>;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || r.code.toLowerCase().includes(needle)
    || r.member_fullname.toLowerCase().includes(needle) || r.phone_number.includes(needle));
  return (
    <>
      <p className="muted small">{t("desk_rewards_desc")}</p>
      <div className="filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("desk_rewards_search")} aria-label={t("desk_rewards_search")} />
      </div>
      {shown.length === 0 ? <p className="muted">{t("desk_rewards_empty")}</p> : (
        <ul className="list">
          {shown.map((r) => {
            const manual = r.kind === "free_class" || r.kind === "merch";
            return (
              <li key={r.redemption_id} className="row-item" data-redemption={r.redemption_id}>
                <div>
                  <b className="code">{r.code}</b> · <b>{r.reward_name}</b> <span className="muted small">({t(`rk_${r.kind}` as Key)})</span>
                  <div className="small muted">{r.member_fullname} · {r.phone_number} · {fmtDateTime(r.created_at, lang)}</div>
                </div>
                <div className="right">
                  <span className={`pill rs-${r.status.toLowerCase()}`}>{t(`rs_${r.status}` as Key)}</span>
                  {r.status === "Active" && manual && (
                    <button className="btn" disabled={busy === r.redemption_id} onClick={() => act(r.redemption_id, api.useRedemption)}>{t("desk_hand_out")}</button>
                  )}
                  {r.status === "Active" && (
                    <button className="btn ghost" disabled={busy === r.redemption_id} onClick={() => act(r.redemption_id, api.cancelRedemption)}>{t("redemption_cancel")}</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------- reviews list (trainer: anonymous; admin: with names and delete) ----------
export function ReviewsList({ rows, admin, onDelete }: { rows: Review[]; admin?: boolean; onDelete?: (r: Review) => void }) {
  const { t, lang } = useT();
  if (rows.length === 0) return <p className="muted">{t("reviews_empty")}</p>;
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.review_id} className="row-item col" data-review={r.review_id}>
          <div className="app-head">
            <span className="stars" aria-label={t("rating_aria", { value: r.rating })}>
              <span aria-hidden>{"★".repeat(r.rating)}<span className="stars-off">{"★".repeat(5 - r.rating)}</span></span>
            </span>
            <b>{r.class_name}</b>
            <span className="small muted">{fmtDayShort(r.start_time, lang)}, {fmtTime(r.start_time)}{admin ? ` · ${r.trainer_name}` : ""}</span>
          </div>
          {r.comment ? <p className="bio small">{r.comment}</p> : <p className="small muted">{t("review_no_comment")}</p>}
          <div className="small muted">
            {admin && r.member_fullname ? `${r.member_fullname} · ` : ""}{fmtDateTime(r.updated_at, lang)}
            {admin && onDelete && <> · <button className="link danger-text" onClick={() => onDelete(r)}>{t("review_delete")}</button></>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Admin tab: all reviews, remove one that breaks the rules. */
export function AdminReviews({ onResult }: { onResult: (r: Result) => void }) {
  const { t } = useT();
  const [rows, setRows] = useState<Review[] | null>(null);
  const [deleting, setDeleting] = useState<Review | null>(null);
  const load = useCallback(async () => setRows(await api.listReviews()), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <p className="muted">{t("loading")}</p>;
  return (
    <>
      <p className="muted small">{t("admin_reviews_desc")}</p>
      <ReviewsList rows={rows} admin onDelete={setDeleting} />
      {deleting && (
        <Modal title={t("review_delete_title")} onClose={() => setDeleting(null)} actions={<>
          <button className="btn ghost" onClick={() => setDeleting(null)}>{t("close")}</button>
          <button className="btn danger" onClick={async () => { const r = await api.deleteReview(deleting.review_id); setDeleting(null); onResult(r); if (r.ok) load(); }}>{t("review_delete")}</button>
        </>}>
          <p>{t("review_delete_body")}</p>
          <p className="small muted">{deleting.member_fullname} · {deleting.class_name} · {"★".repeat(deleting.rating)}</p>
        </Modal>
      )}
    </>
  );
}

// ---------- admin: reward catalog ----------
const sv = (v: unknown) => (v === null || v === undefined ? "" : String(v));
export function AdminRewards({ onResult }: { onResult: (r: Result) => void }) {
  const { t } = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(async () => setRows(await api.adminList("rewards")), []);
  useEffect(() => { load(); }, [load]);
  const done = useCallback((r: Result) => { onResult(r); if (r.ok) load(); }, [onResult, load]);
  if (!rows) return <p className="muted">{t("loading")}</p>;

  const cfg: CrudConfig = {
    rows: [...rows].sort((a, b) => Number(a.cost) - Number(b.cost)),
    id: (r) => Number(r.reward_id),
    columns: [
      { label: "f_name", cell: (r) => <><b>{sv(r.reward_name)}</b><div className="small muted">{sv(r.description)}</div></> },
      { label: "f_reward_kind", cell: (r) => t(`rk_${sv(r.kind)}` as Key) + (r.kind === "membership_days" ? ` (${sv(r.extend_days)})` : "") },
      { label: "f_cost", cell: (r) => <b>{sv(r.cost)}</b> },
      { label: "f_stock", cell: (r) => (r.stock === null || r.stock === undefined ? "∞" : sv(r.stock)) },
      { label: "f_active", cell: (r) => (r.active ? t("yes") : <span className="muted">{t("no")}</span>) },
    ],
    fields: [
      { key: "reward_name", label: "f_name", type: "text", required: true },
      { key: "kind", label: "f_reward_kind", type: "select", required: true, options: REWARD_KINDS.map((k) => ({ value: k, label: t(`rk_${k}` as Key) })) },
      { key: "cost", label: "f_cost", type: "number", required: true },
      { key: "stock", label: "f_stock_hint", type: "number" },
      { key: "extend_days", label: "f_extend_days", type: "number" },
      { key: "active", label: "f_active", type: "select", required: true, options: [{ value: "true", label: t("yes") }, { value: "false", label: t("no") }] },
      { key: "description", label: "f_description", type: "textarea" },
    ],
    blank: () => ({ reward_name: "", kind: "merch", cost: "100", stock: "", extend_days: "", active: "true", description: "" }),
    toForm: (r) => ({ reward_name: sv(r.reward_name), kind: sv(r.kind), cost: sv(r.cost), stock: sv(r.stock),
      extend_days: sv(r.extend_days), active: r.active ? "true" : "false", description: sv(r.description) }),
    fromForm: (f) => {
      const cost = Number(f.cost), stock = f.stock.trim() === "" ? null : Number(f.stock);
      const days = f.extend_days.trim() === "" ? null : Number(f.extend_days);
      if (!Number.isInteger(cost) || cost < 1 || (stock !== null && (!Number.isInteger(stock) || stock < 0))) return "invalid_value";
      if (f.kind === "membership_days" && days === null) return "reward_needs_days";
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return "invalid_value";
      return { reward_name: f.reward_name.trim(), kind: f.kind, cost, stock,
        extend_days: f.kind === "membership_days" ? days : null, active: f.active === "true", description: f.description.trim() || null };
    },
    save: (id, row) => (id === null ? api.adminInsert("rewards", row) : api.adminUpdate("rewards", id, row)),
    remove: (id) => api.adminDelete("rewards", id),
    toolbar: <span className="small muted">{t("admin_rewards_desc")}</span>,
  };
  return <CrudSection cfg={cfg} onResult={done} storageKey="admin.rewards" />;
}
