"use client";
// NFC check-in list, shared by the admin panel ("Check-in" tab) and the reception page.
import type { ReactNode } from "react";
import { api } from "@/lib/api";
import { useT } from "@/components/Providers";
import { fmtDayShort, fmtTime } from "@/lib/format";
import { checkInOpen } from "@/lib/rules";
import type { BookingRow, Reader, Result } from "@/lib/types";

type Props = {
  bookings: BookingRow[];
  readers: Reader[];
  readerId: string;
  onReaderChange: (id: string) => void;
  onResult: (r: Result) => void;
  /** extra controls shown next to the reader select (e.g. a search box) */
  children?: ReactNode;
};

export default function CheckInPanel({ bookings, readers, readerId, onReaderChange, onResult, children }: Props) {
  const { t, lang } = useT();
  const now = Date.now();

  return (
    <>
      <p className="muted small">{t("checkin_desc")}</p>
      <p className="muted small">{t("manual_desc")}</p>

      <div className="filters">
        <select value={readerId} onChange={(e) => onReaderChange(e.target.value)} aria-label={t("reader")}>
          {readers.map((r) => (
            <option key={r.reader_id} value={r.reader_id}>
              {r.reader_id} · {r.branch_name} ({r.check_in_method})
            </option>
          ))}
        </select>
        {children}
      </div>

      {bookings.length === 0 ? (
        <p className="muted">{t("no_checkins")}</p>
      ) : (
        <ul className="list">
          {bookings.map((b) => {
            const open = checkInOpen(b.start_time, now);
            return (
              <li key={b.booking_id} className="row-item">
                <div>
                  <b>{b.member_fullname}</b> <span className="muted">· {b.class_name}</span>
                  <div className="small muted">
                    {fmtDayShort(b.start_time, lang)}, {fmtTime(b.start_time)} · {b.branch_name}, {b.room_name}
                  </div>
                </div>
                <div className="right">
                  <span className={`pill ${b.booking_status.toLowerCase()}`}>{t(`bs_${b.booking_status}`)}</span>
                  {b.booking_status === "Confirmed" && !open && <span className="small muted">{t("checkin_opens_note")}</span>}
                  <button
                    className="btn"
                    disabled={b.booking_status !== "Confirmed" || !readerId || !open}
                    onClick={async () => onResult(await api.checkIn(b.booking_id, readerId))}
                  >
                    {t("tap")}
                  </button>
                  {/* Plan B: NFC failed. Only after the class has started (Task 7: no "Attended" for a future class). */}
                  {b.booking_status !== "Attended" && new Date(b.start_time).getTime() <= now && (
                    <button className="btn ghost" onClick={async () => onResult(await api.manualCheckIn(b.booking_id))}>
                      {t("manual_checkin")}
                    </button>
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
