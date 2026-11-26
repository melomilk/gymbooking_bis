"use client";
// "Going with a friend" (migration_buddy_invite.sql): invite a friend by phone,
// the place is held for 2 hours, both get bonus points when both are checked in.
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/components/Providers";
import Modal from "@/components/Modal";
import { fmtDayShort, fmtTime } from "@/lib/format";
import { formatPhone } from "@/lib/validate";
import { POINTS, type BookingRow, type BuddyInvite, type Result } from "@/lib/types";

/** Held-until time: today -> "14:30", another day -> "Tue, 3 Dec, 14:30". */
function untilText(iso: string, lang: Parameters<typeof fmtDayShort>[1]) {
  const sameDay = fmtDayShort(iso, lang) === fmtDayShort(new Date().toISOString(), lang);
  return sameDay ? fmtTime(iso) : `${fmtDayShort(iso, lang)}, ${fmtTime(iso)}`;
}

export function BuddyInviteModal({ booking, onClose, onDone }: {
  booking: BookingRow; onClose: () => void; onDone: (r: Result) => void;
}) {
  const { t, tr, lang } = useT();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    const r = await api.inviteBuddy(booking.booking_id, phone);
    setBusy(false);
    if (!r.ok) return setError(tr(r));
    onDone(r);
  }

  return (
    <Modal title={t("buddy_title")} onClose={onClose} actions={<>
      <button className="btn ghost" onClick={onClose}>{t("buddy_cancel")}</button>
      <button className="btn" disabled={busy || !phone.trim()} onClick={send}>{busy ? t("please_wait") : t("buddy_send")}</button>
    </>}>
      <p className="small muted">{booking.class_name} · {t("with_trainer", { name: booking.trainer_name })} · {fmtDayShort(booking.start_time, lang)}, {fmtTime(booking.start_time)}</p>
      <p className="small">{t("buddy_body")}</p>
      <label className="form">{t("buddy_phone_label")}
        <input type="tel" value={phone} placeholder="+7 701 123 45 67" autoComplete="off" autoFocus
          onChange={(e) => { setPhone(e.target.value); setError(null); }}
          onBlur={() => setPhone((p) => formatPhone(p))}
          onKeyDown={(e) => { if (e.key === "Enter" && phone.trim() && !busy) send(); }} />
      </label>
      <p className="small good-text">{t("buddy_bonus_hint", { n: POINTS.buddy_bonus })}</p>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Modal>
  );
}

/** Status of the invitation I sent for one of my bookings (under the booking in My Profile). */
export function SentInviteLine({ invite, onWithdraw }: { invite: BuddyInvite; onWithdraw: (i: BuddyInvite) => void }) {
  const { t, lang } = useT();
  const phone = formatPhone(invite.friend_phone ?? "");
  switch (invite.status) {
    case "Pending":
      return (
        <div className="small buddy-line warn-text">
          👥 {t("buddy_held_until", { phone, time: untilText(invite.expires_at, lang) })}{" "}
          <button className="link" onClick={() => onWithdraw(invite)}>{t("buddy_withdraw")}</button>
        </div>
      );
    case "Accepted":
      return (
        <div className="small buddy-line good-text">
          👥 {t("buddy_going_with", { name: invite.friend_name ?? phone })}
          {" · "}{invite.bonus_at ? t("buddy_bonus_got", { n: POINTS.buddy_bonus }) : t("buddy_bonus_hint", { n: POINTS.buddy_bonus })}
        </div>
      );
    default:
      return <div className="small buddy-line muted">{t(`buddy_st_${invite.status}`, { phone })}</div>;
  }
}

/** Under the friend's own booking: who invited them, and the bonus. */
export function ReceivedAcceptedLine({ invite }: { invite: BuddyInvite }) {
  const { t } = useT();
  return (
    <div className="small buddy-line good-text">
      👥 {t("buddy_going_with", { name: invite.inviter_name })}
      {" · "}{invite.bonus_at ? t("buddy_bonus_got", { n: POINTS.buddy_bonus }) : t("buddy_bonus_hint", { n: POINTS.buddy_bonus })}
    </div>
  );
}

/** Open invitations to my phone number, with Accept / Decline. */
export function ReceivedInvites({ invites, onResult }: { invites: BuddyInvite[]; onResult: (r: Result) => void }) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState<number | null>(null);
  if (invites.length === 0) return null;

  async function act(i: BuddyInvite, accept: boolean) {
    setBusy(i.invite_id);
    const r = accept ? await api.acceptBuddyInvite(i.invite_id) : await api.declineBuddyInvite(i.invite_id);
    setBusy(null);
    onResult(r);
  }

  return (
    <>
      <h2>{t("buddy_received_title")}</h2>
      <ul className="list" id="buddy-invites">
        {invites.map((i) => (
          <li key={i.invite_id} className="row-item buddy-invite" data-invite={i.invite_id}>
            <div>
              <b>{i.class_name}</b> <span className="muted">· {t("with_trainer", { name: i.trainer_name })}</span>
              <div className="small muted">{fmtDayShort(i.start_time, lang)} · {fmtTime(i.start_time)}–{fmtTime(i.end_time)} · {i.branch_name}, {i.room_name}</div>
              <div className="small">👥 {t("buddy_received_line", { name: i.inviter_name, time: untilText(i.expires_at, lang) })}</div>
              <div className="small good-text">{t("buddy_bonus_hint", { n: POINTS.buddy_bonus })}</div>
            </div>
            <div className="right">
              <button className="btn ghost" disabled={busy === i.invite_id} onClick={() => act(i, false)}>{t("buddy_decline")}</button>
              <button className="btn" disabled={busy === i.invite_id} onClick={() => act(i, true)}>{t("buddy_accept")}</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Home page: someone invited me and is waiting for an answer. */
export function BuddyBanner({ invites }: { invites: BuddyInvite[] }) {
  const { t, lang } = useT();
  const i = invites[0];
  if (!i) return null;
  return (
    <div className="notice good" id="buddy-banner">
      👥 {t("buddy_home_banner", { name: i.inviter_name, class: i.class_name,
        when: `${fmtDayShort(i.start_time, lang)}, ${fmtTime(i.start_time)}`, time: untilText(i.expires_at, lang) })}
      {invites.length > 1 ? ` (+${invites.length - 1})` : ""}{" "}
      <Link href="/profile#buddy-invites">{t("buddy_home_link")}</Link>
    </div>
  );
}
