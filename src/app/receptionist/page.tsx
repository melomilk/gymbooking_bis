"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useRequireRole, useT } from "@/components/Providers";
import Toast, { type ToastMsg } from "@/components/Toast";
import CheckInPanel from "@/components/CheckInPanel";
import type { BookingRow, Reader, Result } from "@/lib/types";
import { useSessionState } from "@/lib/useSessionState";

export default function ReceptionistPage() {
  const { allowed } = useRequireRole(["Receptionist", "Admin"]); // FR-10
  const { t, tr } = useT();
  const [bookings, setBookings] = useState<BookingRow[] | null>(null);
  const [readers, setReaders] = useState<Reader[]>([]);
  // remembered while the receptionist visits other pages (bug 19)
  const [readerId, setReaderId] = useSessionState("reception.reader", "");
  const [filter, setFilter] = useSessionState("reception.filter", "");
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
      <CheckInPanel bookings={visible} readers={readers} readerId={readerId} onReaderChange={setReaderId} onResult={onResult}>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("search_placeholder")}
          aria-label={t("search_btn")}
        />
      </CheckInPanel>
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}