"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth, useT } from "@/components/Providers";
import Toast, { type ToastMsg } from "@/components/Toast";
import Modal from "@/components/Modal";
import { FREE_CANCEL_MS, fmtDate, fmtDayShort, fmtTime } from "@/lib/format";
import type { BookingRow } from "@/lib/types";

export default function ProfilePage() {
  const router = useRouter();
  const { me, loading: authLoading } = useAuth();
  const { t, tr, lang } = useT();
  const [list, setList] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [confirmLate, setConfirmLate] = useState<BookingRow | null>(null);

  const load = useCallback(async () => {
    if (!me) return;
    setList(await api.myBookings(me.member_id));
    setLoading(false);
  }, [me]);

  useEffect(() => {
    if (authLoading) return;
    if (!me) router.replace("/login");
    else load();
  }, [authLoading, me, load, router]);

  // FR-06: free until 3 h before the start; later -> warn and ask to confirm
  async function cancel(b: BookingRow, acceptFee = false) {
    const r = await api.cancel(b.booking_id, acceptFee);
    if (r.code === "late_cancel_needs_confirm") { setConfirmLate(b); return; }
    setConfirmLate(null);
    setToast({ ok: r.ok, text: tr(r) });
    load();
  }

  if (authLoading || !me || loading) return <p className="muted">{t("loading")}</p>;

  const now = Date.now();
  const upcoming = list.filter((b) => b.booking_status === "Confirmed" && new Date(b.start_time).getTime() > now)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const history = list.filter((b) => !upcoming.includes(b));

  const row = (b: BookingRow, canCancel: boolean) => {
    const freeUntil = new Date(new Date(b.start_time).getTime() - FREE_CANCEL_MS);
    const isLate = freeUntil.getTime() <= now;
    return (
      <li key={b.booking_id} className="row-item" data-booking={b.booking_id}>
        <div>
          <b>{b.class_name}</b> <span className="muted">· {t("with_trainer", { name: b.trainer_name })}</span>
          <div className="small muted">{fmtDayShort(b.start_time, lang)} · {fmtTime(b.start_time)}–{fmtTime(b.end_time)} · {b.branch_name}, {b.room_name}</div>
          {canCancel && (
            <div className={`small ${isLate ? "warn-text" : "muted"}`}>
              {isLate ? t("late_cancel_note") : t("free_cancel_until", { time: `${fmtDayShort(freeUntil.toISOString(), lang)}, ${fmtTime(freeUntil.toISOString())}` })}
            </div>
          )}
        </div>
        <div className="right">
          <span className={`pill ${b.booking_status.toLowerCase()}`}>
            {t(`bs_${b.booking_status}`)}{b.fee_forfeited ? ` · ${t("fee_forfeited")}` : ""}
          </span>
          {canCancel && <button className="btn ghost" onClick={() => cancel(b)}>{t("cancel_booking")}</button>}
        </div>
      </li>
    );
  };

  return (
    <>
      <h1>{t("profile_title")}</h1>
      <dl className="profile">
        <div><dt>{t("full_name")}</dt><dd>{me.member_name} {me.member_surname}</dd></div>
        <div><dt>{t("phone")}</dt><dd>{me.phone_number}</dd></div>
        <div><dt>{t("membership_status")}</dt><dd><span className={`pill st-${me.effective_status.toLowerCase()}`}>{t(`st_${me.effective_status}`)}</span></dd></div>
        <div><dt>{t("expiry_date")}</dt><dd>{fmtDate(me.membership_expiry, lang)}</dd></div>
        {me.role !== "Member" && <div><dt>{t("role")}</dt><dd>{t(`role_${me.role}`)}</dd></div>}
      </dl>

      <h2>{t("upcoming_bookings")}</h2>
      {upcoming.length === 0
        ? <p className="muted">{t("no_upcoming_bookings")} <Link href="/">{t("browse_classes")}</Link></p>
        : <ul className="list" id="upcoming">{upcoming.map((b) => row(b, true))}</ul>}
      {history.length > 0 && (<><h2>{t("history")}</h2><ul className="list" id="history">{history.map((b) => row(b, false))}</ul></>)}

      {confirmLate && (
        <Modal title={t("late_cancel_title")} onClose={() => setConfirmLate(null)} actions={<>
          <button className="btn ghost" onClick={() => setConfirmLate(null)}>{t("keep_booking")}</button>
          <button className="btn danger" onClick={() => cancel(confirmLate, true)}>{t("late_cancel_yes")}</button>
        </>}>
          <p>{t("late_cancel_body")}</p>
          <p className="small muted">{confirmLate.class_name} · {fmtDayShort(confirmLate.start_time, lang)}, {fmtTime(confirmLate.start_time)}</p>
        </Modal>
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}
