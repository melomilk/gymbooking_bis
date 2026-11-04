"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth, useT } from "@/components/Providers";
import { fmtDayShort, fmtTime } from "@/lib/format";
import type { BookingRow, Branch, SessionRow, Trainer } from "@/lib/types";

type Results = { trainers: (Trainer & { upcoming: SessionRow[] })[]; branches: (Branch & { upcoming: number })[]; bookings: BookingRow[] };

function SearchInner() {
  const params = useSearchParams();
  const router = useRouter();
  const q = (params.get("q") ?? "").trim();
  const { me, loading: authLoading } = useAuth();
  const { t, lang } = useT();
  const [input, setInput] = useState(q);
  const [res, setRes] = useState<Results | null>(null);

  useEffect(() => setInput(q), [q]);

  useEffect(() => {
    if (authLoading) return;
    if (!q) { setRes(null); return; }
    let cancelled = false;
    (async () => {
      const [trainers, branches, bookings, sessions] = await Promise.all([
        api.searchTrainers(q), api.searchBranches(q), me ? api.searchBookings(q) : Promise.resolve([]), api.listSessions(),
      ]);
      if (cancelled) return;
      setRes({
        trainers: trainers.map((tr) => ({ ...tr, upcoming: sessions.filter((s) => s.trainer_id === tr.trainer_id).slice(0, 5) })),
        branches: branches.map((b) => ({ ...b, upcoming: sessions.filter((s) => s.branch_id === b.branch_id).length })),
        bookings,
      });
    })();
    return () => { cancelled = true; };
  }, [q, me, authLoading]);

  const empty = res && !res.trainers.length && !res.branches.length && !res.bookings.length;

  return (
    <>
      <h1>{t("search_title")}</h1>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); router.push(`/search?q=${encodeURIComponent(input.trim())}`); }}>
        <input className="grow" type="search" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("search_placeholder")} aria-label={t("search_btn")} />
        <button className="btn">{t("search_btn")}</button>
      </form>
      {!q && <p className="muted">{t("search_hint")}</p>}
      {q && !res && <p className="muted">{t("loading")}</p>}
      {q && res && (
        <>
          <p className="muted small">{t("results_for", { q })}</p>
          {empty && <div className="notice" id="no-results">{t("no_results")}</div>}

          {res.trainers.length > 0 && (<section id="res-trainers">
            <h2>{t("trainers")}</h2>
            <ul className="list">{res.trainers.map((tr) => (
              <li key={tr.trainer_id} className="row-item col">
                <b>{tr.trainer_name}</b>
                {tr.upcoming.length === 0 ? <span className="small muted">{t("no_upcoming_sessions")}</span> : (
                  <ul className="sublist">{tr.upcoming.map((s) => (
                    <li key={s.session_id} className="small">
                      {fmtDayShort(s.start_time, lang)}, {fmtTime(s.start_time)} · <b>{s.class_name}</b> · {s.branch_name}, {s.room_name} · {t("spots_left", { left: s.capacity - s.spots_taken, cap: s.capacity })}
                    </li>))}
                  </ul>
                )}
              </li>))}
            </ul>
          </section>)}

          {res.branches.length > 0 && (<section id="res-branches">
            <h2>{t("branches")}</h2>
            <ul className="list">{res.branches.map((b) => (
              <li key={b.branch_id} className="row-item">
                <div><b>{b.branch_name}</b><div className="small muted">{b.address} · {b.phone_number}</div></div>
                <Link className="btn ghost" href="/">{t("nav_classes")}</Link>
              </li>))}
            </ul>
          </section>)}

          {res.bookings.length > 0 && (<section id="res-bookings">
            <h2>{t("bookings")}</h2>
            <ul className="list">{res.bookings.map((b) => (
              <li key={b.booking_id} className="row-item">
                <div>
                  <b>{b.class_name}</b> <span className="muted">· {t("with_trainer", { name: b.trainer_name })}</span>
                  {me?.role === "Admin" && <span> · {b.member_fullname}</span>}
                  <div className="small muted">{fmtDayShort(b.start_time, lang)}, {fmtTime(b.start_time)} · {b.branch_name}, {b.room_name}</div>
                </div>
                <span className={`pill ${b.booking_status.toLowerCase()}`}>{t(`bs_${b.booking_status}`)}</span>
              </li>))}
            </ul>
          </section>)}
          {!me && <p className="small muted">{t("login_to_search_bookings")}</p>}
        </>
      )}
    </>
  );
}

export default function SearchPage() {
  return <Suspense fallback={null}><SearchInner /></Suspense>;
}
