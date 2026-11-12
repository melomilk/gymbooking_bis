"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useRequireRole, useT } from "@/components/Providers";
import Toast, { type ToastMsg } from "@/components/Toast";
import { fmtDayShort, fmtTime } from "@/lib/format";
import type { BookingRow, Reader, Result } from "@/lib/types";

export default function ReceptionistPage() {
  const { allowed } = useRequireRole(["Receptionist", "Admin"]); // FR-10
  const { t, tr, lang } = useT();
  const [bookings, setBookings] = useState<BookingRow[] | null>(null);
  const [readers, setReaders] = useState<Reader[]>([]);
  const [readerId, setReaderId] = useState("");
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<ToastMsg>(null);

  const load = useCallback(async () => {
    const [b, r] = await Promise.all([api.allBookings(), api.listReaders()]);
    setBookings(b);
    setReaders(r);
    setReaderId((cur) => cur || r[0]?.reader_id || "");
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const onResult = useCallback(
    (r: Result) => {
      setToast({ ok: r.ok, text: tr(r) });
      if (r.ok) load();
    },
    [tr, load]
  );

  if (!allowed || !bookings) return <p className="muted">{t("loading")}</p>;

  const now = Date.now();
  const q = filter.trim().toLowerCase();
  const visible = q
    ? bookings.filter(
        (b) =>
          b.member_fullname.toLowerCase().includes(q) ||
          b.class_name.toLowerCase().includes(q) ||
          b.branch_name.toLowerCase().includes(q)
      )
    : bookings;

  return (
    <>
      <h1>{t("receptionist_title")}</h1>
      <p className="muted small">{t("checkin_desc")}</p>
      <p className="muted small">{t("manual_desc")}</p>

      <div className="filters">
        <select value={readerId} onChange={(e) => setReaderId(e.target.value)} aria-label={t("reader")}>
          {readers.map((r) => (
            <option key={r.reader_id} value={r.reader_id}>
              {r.reader_id} · {r.branch_name} ({r.check_in_method})
            </option>
          ))}
        </select>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("search_placeholder")}
          aria-label={t("search_btn")}
        />
      </div>

      {visible.length === 0 ? (
        <p className="muted">{t("no_checkins")}</p>
      ) : (
        <ul className="list">
          {visible.map((b) => (
            <li key={b.booking_id} className="row-item">
              <div>
                <b>{b.member_fullname}</b> <span className="muted">· {b.class_name}</span>
                <div className="small muted">
                  {fmtDayShort(b.start_time, lang)}, {fmtTime(b.start_time)} · {b.branch_name}, {b.room_name}
                </div>
              </div>
              <div className="right">
                <span className={`pill ${b.booking_status.toLowerCase()}`}>{t(`bs_${b.booking_status}`)}</span>
                <button
                  className="btn"
                  disabled={b.booking_status !== "Confirmed" || !readerId}
                  onClick={async () => onResult(await api.checkIn(b.booking_id, readerId))}
                >
                  {t("tap")}
                </button>
                {b.booking_status !== "Attended" && new Date(b.start_time).getTime() <= now && (
                  <button className="btn ghost" onClick={async () => onResult(await api.manualCheckIn(b.booking_id))}>
                    {t("manual_checkin")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}