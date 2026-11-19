"use client";
// Trainer class requests: the trainer proposes a class, the admin approves
// (the class appears in the schedule) or rejects it with a reason.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { dayKey, fmtDateTime, fmtDayShort, fmtTime, toIso } from "@/lib/format";
import type { Key } from "@/lib/i18n";
import {
  REQUEST_MAX_DAYS, REQUEST_NOTE_MAX, type ClassTypeOption, type Result, type RoomOption, type SessionRequest, type SessionRow,
} from "@/lib/types";
import Modal from "./Modal";
import { useT } from "./Providers";

const plusDaysKey = (n: number) => dayKey(new Date(Date.now() + n * 86400_000).toISOString());
const addMinutes = (hhmm: string, mins: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

function StatusPill({ s }: { s: SessionRequest["status"] }) {
  const { t } = useT();
  const cls = s === "Pending" ? "st-pending" : s === "Approved" ? "st-active" : s === "Rejected" ? "st-suspended" : "";
  return <span className={`pill ${cls}`}>{t(`sr_${s}` as Key)}</span>;
}

// ---------- trainer: form + own requests ----------
export function TrainerSessionRequests({ trainerId, onResult }: { trainerId: number; onResult: (r: Result) => void }) {
  const { t, tr, lang } = useT();
  const [opts, setOpts] = useState<{ classes: ClassTypeOption[]; rooms: RoomOption[] } | null>(null);
  const [mine, setMine] = useState<SessionRequest[]>([]);
  const [schedule, setSchedule] = useState<SessionRow[]>([]);
  const [f, setF] = useState({ class_id: "", room_id: "", date: plusDaysKey(1), start: "18:00", capacity: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const [o, m, s] = await Promise.all([api.requestOptions(), api.listSessionRequests(), api.listSessions()]);
    setOpts(o); setMine(m); setSchedule(s);
    setF((cur) => cur.class_id ? cur : {
      ...cur, class_id: String(o.classes[0]?.class_id ?? ""), room_id: String(o.rooms[0]?.room_id ?? ""),
      capacity: String(o.rooms[0]?.max_capacity ?? ""),
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const cls = opts?.classes.find((c) => String(c.class_id) === f.class_id);
  const room = opts?.rooms.find((r) => String(r.room_id) === f.room_id);
  // what is already planned that day: in this room, and the trainer's own classes
  const sameDay = useMemo(() => schedule.filter((s) => dayKey(s.start_time) === f.date
    && (String(s.room_id) === f.room_id || s.trainer_id === trainerId)).sort((a, b) => a.start_time.localeCompare(b.start_time)),
  [schedule, f.date, f.room_id, trainerId]);

  if (!opts) return null;
  if (opts.classes.length === 0) return null; // migration not applied yet

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.value;
    setError(null);
    setF((cur) => {
      const next = { ...cur, [k]: v };
      // a smaller room lowers the capacity to fit
      if (k === "room_id") {
        const r = opts.rooms.find((x) => String(x.room_id) === v);
        if (r && (!cur.capacity || Number(cur.capacity) > r.max_capacity)) next.capacity = String(r.max_capacity);
      }
      return next;
    });
  };

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!cls || !room || !f.date || !f.start || !f.capacity) return setError(tr({ code: "required" }));
    setBusy(true);
    const r = await api.submitSessionRequest({ class_id: cls.class_id, room_id: room.room_id, start_time: toIso(f.date, f.start),
      capacity: Number(f.capacity), note: f.note });
    setBusy(false);
    if (!r.ok) return setError(tr(r));
    onResult(r);
    setF((cur) => ({ ...cur, note: "" }));
    setOpen(false);
    load();
  }

  async function withdraw(q: SessionRequest) {
    const r = await api.withdrawSessionRequest(q.request_id);
    onResult(r);
    load();
  }

  return (
    <section id="session-requests">
      <h2>{t("sr_title")}</h2>
      <p className="small muted">{t("sr_desc")}</p>
      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>+ {t("sr_new")}</button>
      ) : (
        <form className="editor sr-form" onSubmit={submit} noValidate>
          <div className="editor-grid">
            <label>{t("f_class")} *
              <select value={f.class_id} onChange={set("class_id")}>
                {opts.classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name} ({t("minutes", { n: c.duration_min })})</option>)}
              </select>
            </label>
            <label>{t("f_room")} *
              <select value={f.room_id} onChange={set("room_id")}>
                {opts.rooms.map((r) => <option key={r.room_id} value={r.room_id}>{r.branch_name} · {r.room_name} ({t("sr_up_to", { n: r.max_capacity })})</option>)}
              </select>
            </label>
            <label>{t("f_date")} *
              <input type="date" value={f.date} min={plusDaysKey(0)} max={plusDaysKey(REQUEST_MAX_DAYS)} onChange={set("date")} />
            </label>
            <label>{t("f_start")} *
              <input type="time" value={f.start} step={300} onChange={set("start")} />
              {cls && <span className="small muted">{t("sr_ends_at", { time: addMinutes(f.start, cls.duration_min) })}</span>}
            </label>
            <label>{t("f_capacity")} *
              <input type="number" min={1} max={room?.max_capacity} value={f.capacity} onChange={set("capacity")} />
            </label>
            <label className="wide">{t("sr_note")}
              <textarea rows={2} maxLength={REQUEST_NOTE_MAX} value={f.note} onChange={set("note")} placeholder={t("sr_note_hint")} />
            </label>
          </div>
          <div className="sr-day small">
            <b>{t("sr_that_day", { day: fmtDayShort(toIso(f.date || plusDaysKey(1), "12:00"), lang) })}</b>{" "}
            {sameDay.length === 0 ? <span className="muted">{t("sr_day_free")}</span> : (
              <ul className="sublist">
                {sameDay.map((s) => (
                  <li key={s.session_id}>
                    {fmtTime(s.start_time)}–{fmtTime(s.end_time)} · {s.class_name} · {s.room_name}
                    {s.trainer_id === trainerId ? ` · ${t("sr_yours")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <div className="editor-actions">
            <button type="button" className="btn ghost" onClick={() => { setOpen(false); setError(null); }}>{t("close")}</button>
            <button className="btn" disabled={busy}>{busy ? t("please_wait") : t("sr_send")}</button>
          </div>
        </form>
      )}

      {mine.length > 0 && (
        <ul className="list sr-list">
          {mine.map((q) => (
            <li key={q.request_id} className="row-item" data-request={q.request_id}>
              <div>
                <b>{q.class_name}</b> · {fmtDayShort(q.start_time, lang)}, {fmtTime(q.start_time)}–{fmtTime(q.end_time)}
                <div className="small muted">{q.branch_name}, {q.room_name} · {t("sr_capacity", { n: q.capacity })}{q.note ? ` · “${q.note}”` : ""}</div>
                {q.status === "Rejected" && q.reject_reason && <div className="small bad-text">{t("app_reason", { reason: q.reject_reason })}</div>}
                {q.status === "Approved" && <div className="small good-text">{t("sr_in_schedule")}</div>}
              </div>
              <div className="right">
                <StatusPill s={q.status} />
                {q.status === "Pending" && <button className="btn ghost" onClick={() => withdraw(q)}>{t("sr_withdraw")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- admin tab ----------
export function AdminSessionRequests({ onResult }: { onResult: (r: Result) => void }) {
  const { t, lang } = useT();
  const [rows, setRows] = useState<SessionRequest[] | null>(null);
  const [rejecting, setRejecting] = useState<SessionRequest | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => setRows(await api.listSessionRequests()), []);
  useEffect(() => { load(); }, [load]);

  async function decide(q: SessionRequest, approve: boolean, why?: string) {
    setBusy(q.request_id);
    const r = await api.reviewSessionRequest(q.request_id, approve, why);
    setBusy(null);
    setRejecting(null); setReason("");
    onResult(r);
    load();
  }

  if (!rows) return <p className="muted">{t("loading")}</p>;
  if (rows.length === 0) return <p className="muted">{t("sr_admin_empty")}</p>;
  return (
    <>
      <p className="muted small">{t("sr_admin_desc")}</p>
      <ul className="list">
        {rows.map((q) => (
          <li key={q.request_id} className="row-item col" data-request={q.request_id}>
            <div className="app-head">
              <b>{q.class_name}</b> · {fmtDayShort(q.start_time, lang)}, {fmtTime(q.start_time)}–{fmtTime(q.end_time)}
              <StatusPill s={q.status} />
            </div>
            <div className="small">{t("with_trainer", { name: q.trainer_name })} · {q.branch_name}, {q.room_name} · {t("sr_capacity_of", { n: q.capacity, max: q.max_capacity })}</div>
            {q.note && <div className="small bio">“{q.note}”</div>}
            <div className="small muted">{t("app_submitted")}: {fmtDateTime(q.created_at, lang)}{q.reject_reason ? ` · ${t("app_reason", { reason: q.reject_reason })}` : ""}</div>
            {q.status === "Pending" && (
              <div className="right">
                <button className="btn" disabled={busy === q.request_id} onClick={() => decide(q, true)}>{t("sr_approve")}</button>
                <button className="btn ghost" disabled={busy === q.request_id} onClick={() => setRejecting(q)}>{t("reject")}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rejecting && (
        <Modal title={t("sr_reject_title")} onClose={() => setRejecting(null)} actions={<>
          <button className="btn ghost" onClick={() => setRejecting(null)}>{t("close")}</button>
          <button className="btn danger" disabled={busy !== null} onClick={() => decide(rejecting, false, reason)}>{t("reject")}</button>
        </>}>
          <p><b>{rejecting.class_name}</b> · {rejecting.trainer_name} · {fmtDayShort(rejecting.start_time, lang)}, {fmtTime(rejecting.start_time)}</p>
          <label className="form">{t("sr_reject_reason")}
            <textarea rows={3} maxLength={REQUEST_NOTE_MAX} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("sr_reject_hint")} />
          </label>
        </Modal>
      )}
    </>
  );
}

/** Pending count for the admin tab badge. */
export function usePendingRequests(enabled: boolean, refresh: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    api.listSessionRequests().then((r) => setN(r.filter((q) => q.status === "Pending").length)).catch(() => {});
  }, [enabled, refresh]);
  return n;
}
