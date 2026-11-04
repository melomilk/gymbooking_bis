"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth, useT } from "@/components/Providers";
import Toast, { type ToastMsg } from "@/components/Toast";
import Modal from "@/components/Modal";
import { dayKey, fmtDate, fmtDayLong, fmtDayShort, fmtTime } from "@/lib/format";
import type { Branch, SessionRow } from "@/lib/types";

type Alt = { session: SessionRow; options: SessionRow[]; reason: string };

export default function SchedulePage() {
  const { me, loading: authLoading } = useAuth();
  const { t, tr, lang } = useT();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [booked, setBooked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [alt, setAlt] = useState<Alt | null>(null);
  const [branch, setBranch] = useState("all");
  const [cls, setCls] = useState("all");
  const [day, setDay] = useState("all");

  const load = useCallback(async () => {
    const [s, b, mine] = await Promise.all([
      api.listSessions(), api.listBranches(), me ? api.myBookings(me.member_id) : Promise.resolve([]),
    ]);
    const bookedSet = new Set(mine.filter((x) => x.booking_status !== "Cancelled").map((x) => x.session_id));
    setSessions(s); setBranches(b); setBooked(bookedSet); setLoading(false);
    return { s, bookedSet };
  }, [me]);

  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);

  const classNames = useMemo(() => Array.from(new Set(sessions.map((s) => s.class_name))).sort(), [sessions]);
  const days = useMemo(() => Array.from(new Set(sessions.map((s) => dayKey(s.start_time)))), [sessions]);
  const shown = sessions.filter((s) =>
    (branch === "all" || String(s.branch_id) === branch) && (cls === "all" || s.class_name === cls) && (day === "all" || dayKey(s.start_time) === day));
  const groups = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    shown.forEach((s) => { const k = dayKey(s.start_time); m.set(k, [...(m.get(k) ?? []), s]); });
    return Array.from(m.entries());
  }, [shown]);

  async function book(session: SessionRow) {
    setBusy(session.session_id);
    const r = await api.book(session.session_id);
    const { s, bookedSet } = await load();
    setBusy(null);
    // FR-03: on "full" or "already booked", offer up to 3 other times of the same class
    if (r.code === "class_full" || r.code === "already_booked") {
      const options = s.filter((x) => x.class_id === session.class_id && x.session_id !== session.session_id
        && x.capacity - x.spots_taken > 0 && !bookedSet.has(x.session_id)).slice(0, 3);
      setAlt({ session, options, reason: tr(r) });
      return;
    }
    setAlt(null);
    setToast({ ok: r.ok, text: tr(r) });
  }

  const blocked = me && me.effective_status !== "Active";

  return (
    <>
      <section className="hero">
        <h1>{t("hero_title")}</h1>
        <p className="muted">{t("hero_sub")}</p>
      </section>

      {blocked && (
        <div className="notice bad">
          {t("membership_blocked", { status: t(`st_${me.effective_status}`) })}
          {me.effective_status === "Expired" && ` (${fmtDate(me.membership_expiry, lang)})`}
        </div>
      )}
      {!me && !authLoading && <div className="notice"><Link href="/login">{t("notice_login_to_book")}</Link></div>}

      <div className="filters">
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label={t("f_branch")}>
          <option value="all">{t("filter_all_branches")}</option>
          {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
        </select>
        <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label={t("f_class")}>
          <option value="all">{t("filter_all_classes")}</option>
          {classNames.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={day} onChange={(e) => setDay(e.target.value)} aria-label={t("f_date")}>
          <option value="all">{t("filter_any_day")}</option>
          {days.map((d) => <option key={d} value={d}>{fmtDayShort(sessions.find((s) => dayKey(s.start_time) === d)!.start_time, lang)}</option>)}
        </select>
      </div>

      {loading ? <p className="muted">{t("loading")}</p> : groups.length === 0 ? <p className="muted">{t("no_classes")}</p> : groups.map(([k, list]) => (
        <section key={k} className="day">
          <h2 className="cap">{fmtDayLong(list[0].start_time, lang)}</h2>
          <div className="grid">
            {list.map((s) => {
              const left = s.capacity - s.spots_taken;
              const full = left <= 0;
              const mine = booked.has(s.session_id);
              return (
                <article key={s.session_id} className="card" data-session={s.session_id}>
                  <div className="card-top">
                    <h3>{s.class_name}</h3>
                    <span className="time">{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</span>
                  </div>
                  <p className="muted small">{s.description}</p>
                  <p className="small">{t("with_trainer", { name: s.trainer_name })}</p>
                  <p className="small muted">{s.branch_name} · {s.room_name} · {t("minutes", { n: s.duration_min })}</p>
                  <div className="bar"><div style={{ width: `${Math.min(100, (s.spots_taken / s.capacity) * 100)}%` }} className={full ? "full" : ""} /></div>
                  <div className="card-bottom">
                    <span className={`small ${full ? "bad-text" : left <= 3 ? "warn-text" : "muted"}`}>
                      {full ? t("full") : t("spots_left", { left, cap: s.capacity })}
                    </span>
                    {mine ? (
                      <button className="btn done" disabled>{t("booked_mark")}</button>
                    ) : !me ? (
                      <Link className="btn" href="/login">{t("login_to_book_btn")}</Link>
                    ) : (
                      // a full class stays clickable: the system rejects it and offers alternatives (FR-01, FR-03)
                      <button className={`btn ${full ? "ghost" : ""}`} disabled={!!blocked || busy === s.session_id} onClick={() => book(s)}>
                        {busy === s.session_id ? t("booking_in_progress") : full ? t("full") : t("book")}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {alt && (
        <Modal title={alt.reason} onClose={() => setAlt(null)} actions={<button className="btn ghost" onClick={() => setAlt(null)}>{t("close")}</button>}>
          <p className="muted"><b>{t("alt_title", { class: alt.session.class_name })}</b></p>
          {alt.options.length === 0 ? (
            <p className="muted">{t("alt_none", { class: alt.session.class_name })}</p>
          ) : (
            <>
              <p className="small muted">{t("alt_hint")}</p>
              <ul className="list">
                {alt.options.map((o) => (
                  <li key={o.session_id} className="row-item alt-item">
                    <div>
                      <b>{fmtDayShort(o.start_time, lang)}, {fmtTime(o.start_time)}–{fmtTime(o.end_time)}</b>
                      <div className="small muted">{o.trainer_name} · {o.branch_name}, {o.room_name} · {t("spots_left", { left: o.capacity - o.spots_taken, cap: o.capacity })}</div>
                    </div>
                    <button className="btn" disabled={busy === o.session_id} onClick={() => book(o)}>{t("book")}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
