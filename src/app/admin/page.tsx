"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useRequireRole, useT } from "@/components/Providers";
import CrudSection, { type CrudConfig, type Form } from "@/components/CrudSection";
import Toast, { type ToastMsg } from "@/components/Toast";
import { dayKey, fmtDate, fmtDayShort, fmtTime, toIso } from "@/lib/format";
import Modal from "@/components/Modal";
import type { TrainerApplication } from "@/lib/types";
import type { AttendanceRow, BookingRow, Branch, ClassType, Entity, MemberRow, Reader, Result, Room, Row, SessionRow, Trainer } from "@/lib/types";
import type { Key } from "@/lib/i18n";
import { attendanceRate, fmtRate, LOW_ATTENDANCE } from "@/lib/stats";

type Tab = "sessions" | "classes" | "trainers" | "branches" | "rooms" | "members" | "applications" | "checkin" | "report";
const TABS: { id: Tab; label: Key }[] = [
  { id: "sessions", label: "tab_sessions" }, { id: "classes", label: "tab_classes" }, { id: "trainers", label: "tab_trainers" },
  { id: "branches", label: "tab_branches" }, { id: "rooms", label: "tab_rooms" }, { id: "members", label: "tab_members" },
  { id: "applications", label: "tab_applications" },
  { id: "checkin", label: "tab_checkin" }, { id: "report", label: "tab_report" },
];

type Data = {
  sessions: SessionRow[]; classes: ClassType[]; trainers: Trainer[]; branches: Branch[]; rooms: Room[];
  members: MemberRow[]; bookings: BookingRow[]; readers: Reader[]; report: AttendanceRow[];
  applications: TrainerApplication[];
};

const addMinutes = (hhmm: string, mins: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const total = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const tomorrow = () => dayKey(new Date(Date.now() + 86400_000).toISOString());
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const n = (v: string) => (v.trim() === "" ? null : Number(v));

export default function AdminPage() {
  const { allowed } = useRequireRole(["Admin"]); // FR-10
  const { t, tr, lang } = useT();
  const [tab, setTab] = useState<Tab>("sessions");
  const [data, setData] = useState<Data | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [readerId, setReaderId] = useState("");
  const [toast, setToast] = useState<ToastMsg>(null);

  const load = useCallback(async () => {
    const [sessions, classes, trainers, branches, rooms, members, bookings, readers, report, applications] = await Promise.all([
      api.listSessions({ includePast: true }), api.adminList("classes"), api.adminList("trainers"), api.adminList("branches"),
      api.adminList("rooms"), api.adminList("members"), api.allBookings(), api.listReaders(), api.attendanceReport(),
      api.listTrainerApplications(),
    ]);
    setData({ sessions, classes: classes as ClassType[], trainers: trainers as Trainer[], branches: branches as Branch[],
      rooms: rooms as Room[], members: members as MemberRow[], bookings, readers, report, applications });
    setReaderId((cur) => cur || readers[0]?.reader_id || "");
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const onResult = useCallback((r: Result) => {
    setToast({ ok: r.ok, text: tr(r) });
    if (r.ok) load();
  }, [tr, load]);

  if (!allowed || !data) return <p className="muted">{t("loading")}</p>;

  const crud = (entity: Entity) => ({
    save: (id: number | null, row: Row) => (id === null ? api.adminInsert(entity, row) : api.adminUpdate(entity, id, row)),
    remove: (id: number) => api.adminDelete(entity, id),
  });
  const branchName = (id: unknown) => data.branches.find((b) => b.branch_id === Number(id))?.branch_name ?? t("none");
  const roomLabel = (r: Room) => `${branchName(r.branch_id)} · ${r.room_name} (${r.max_capacity})`;
  const opts = <T,>(list: T[], v: (x: T) => unknown, l: (x: T) => string) => list.map((x) => ({ value: s(v(x)), label: l(x) }));

  // ---------- Sessions (FR-09 example: new Pilates session, capacity 15) ----------
  const durationOf = (classId: string) => data.classes.find((c) => c.class_id === Number(classId))?.duration_min ?? 60;
  const roomMax = (roomId: string) => data.rooms.find((r) => r.room_id === Number(roomId))?.max_capacity ?? 0;
  const now = Date.now();
  const sessionsCfg: CrudConfig = {
    rows: data.sessions.filter((x) => showPast || new Date(x.end_time).getTime() > now) as unknown as Row[],
    id: (r) => Number(r.session_id),
    columns: [
      { label: "f_date", cell: (r) => <span className="nowrap">{fmtDayShort(s(r.start_time), lang)}, {fmtTime(s(r.start_time))}–{fmtTime(s(r.end_time))}</span> },
      { label: "f_class", cell: (r) => <b>{s(r.class_name)}</b> },
      { label: "f_trainer", cell: (r) => s(r.trainer_name) },
      { label: "f_room", cell: (r) => `${s(r.branch_name)} · ${s(r.room_name)}` },
      { label: "f_capacity", cell: (r) => s(r.capacity) },
      { label: "booked_col", cell: (r) => s(r.spots_taken) },
    ],
    fields: [
      { key: "class_id", label: "f_class", type: "select", required: true, options: opts(data.classes, (c) => c.class_id, (c) => c.class_name) },
      { key: "trainer_id", label: "f_trainer", type: "select", required: true, options: opts(data.trainers, (x) => x.trainer_id, (x) => x.trainer_name) },
      { key: "room_id", label: "f_room", type: "select", required: true, options: opts(data.rooms, (r) => r.room_id, roomLabel) },
      { key: "date", label: "f_date", type: "date", required: true },
      { key: "start", label: "f_start", type: "time", required: true },
      { key: "end", label: "f_end", type: "time", required: true },
      { key: "capacity", label: "f_capacity", type: "number", required: true },
    ],
    blank: () => {
      const c = s(data.classes[0]?.class_id), r = s(data.rooms[0]?.room_id);
      return { class_id: c, trainer_id: s(data.trainers[0]?.trainer_id), room_id: r, date: tomorrow(), start: "10:00",
        end: addMinutes("10:00", durationOf(c)), capacity: s(roomMax(r)) };
    },
    toForm: (r) => ({ class_id: s(r.class_id), trainer_id: s(r.trainer_id), room_id: s(r.room_id), date: dayKey(s(r.start_time)),
      start: fmtTime(s(r.start_time)), end: fmtTime(s(r.end_time)), capacity: s(r.capacity) }),
    onChange: (f, key) => {
      if (key === "class_id" || key === "start") return { ...f, end: addMinutes(f.start, durationOf(f.class_id)) };
      if (key === "room_id") {
        const max = roomMax(f.room_id);
        return { ...f, capacity: !f.capacity || Number(f.capacity) > max ? s(max) : f.capacity };
      }
      return f;
    },
    fromForm: (f: Form) => {
      const room = data.rooms.find((r) => r.room_id === Number(f.room_id));
      if (!room) return "required";
      if (!(Number(f.capacity) > 0)) return "invalid_value";
      return { class_id: Number(f.class_id), trainer_id: Number(f.trainer_id), room_id: room.room_id, branch_id: room.branch_id,
        start_time: toIso(f.date, f.start), end_time: toIso(f.date, f.end), capacity: Number(f.capacity) };
    },
    ...crud("class_sessions"),
    toolbar: <label className="check"><input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> {t("show_past")}</label>,
  };

  const classesCfg: CrudConfig = {
    rows: data.classes as unknown as Row[], id: (r) => Number(r.class_id),
    columns: [
      { label: "f_name", cell: (r) => <b>{s(r.class_name)}</b> },
      { label: "f_description", cell: (r) => <span className="small muted">{s(r.description)}</span> },
      { label: "f_duration", cell: (r) => s(r.duration_min) },
    ],
    fields: [
      { key: "class_name", label: "f_name", type: "text", required: true },
      { key: "duration_min", label: "f_duration", type: "number", required: true },
      { key: "description", label: "f_description", type: "textarea" },
    ],
    blank: () => ({ class_name: "", duration_min: "60", description: "" }),
    toForm: (r) => ({ class_name: s(r.class_name), duration_min: s(r.duration_min), description: s(r.description) }),
    fromForm: (f) => (Number(f.duration_min) > 0
      ? { class_name: f.class_name.trim(), duration_min: Number(f.duration_min), description: f.description.trim() || null } : "invalid_value"),
    ...crud("classes"),
  };

  const trainersCfg: CrudConfig = {
    rows: data.trainers as unknown as Row[], id: (r) => Number(r.trainer_id),
    columns: [
      { label: "f_name", cell: (r) => <b>{s(r.trainer_name)}</b> },
      { label: "f_phone", cell: (r) => s(r.phone) || t("none") },
      { label: "f_email", cell: (r) => s(r.email) || t("none") },
    ],
    fields: [
      { key: "trainer_name", label: "f_name", type: "text", required: true },
      { key: "phone", label: "f_phone", type: "tel" },
      { key: "email", label: "f_email", type: "email" },
    ],
    blank: () => ({ trainer_name: "", phone: "", email: "" }),
    toForm: (r) => ({ trainer_name: s(r.trainer_name), phone: s(r.phone), email: s(r.email) }),
    fromForm: (f) => ({ trainer_name: f.trainer_name.trim(), phone: f.phone.trim() || null, email: f.email.trim() || null }),
    ...crud("trainers"),
  };

  const branchesCfg: CrudConfig = {
    rows: data.branches as unknown as Row[], id: (r) => Number(r.branch_id),
    columns: [
      { label: "f_name", cell: (r) => <b>{s(r.branch_name)}</b> },
      { label: "f_address", cell: (r) => s(r.address) },
      { label: "f_phone", cell: (r) => s(r.phone_number) },
    ],
    fields: [
      { key: "branch_name", label: "f_name", type: "text", required: true },
      { key: "address", label: "f_address", type: "text", required: true },
      { key: "phone_number", label: "f_phone", type: "tel", required: true },
    ],
    blank: () => ({ branch_name: "", address: "", phone_number: "" }),
    toForm: (r) => ({ branch_name: s(r.branch_name), address: s(r.address), phone_number: s(r.phone_number) }),
    fromForm: (f) => ({ branch_name: f.branch_name.trim(), address: f.address.trim(), phone_number: f.phone_number.trim() }),
    ...crud("branches"),
  };

  const roomsCfg: CrudConfig = {
    rows: data.rooms as unknown as Row[], id: (r) => Number(r.room_id),
    columns: [
      { label: "f_branch", cell: (r) => branchName(r.branch_id) },
      { label: "f_name", cell: (r) => <b>{s(r.room_name)}</b> },
      { label: "f_max_capacity", cell: (r) => s(r.max_capacity) },
    ],
    fields: [
      { key: "branch_id", label: "f_branch", type: "select", required: true, options: opts(data.branches, (b) => b.branch_id, (b) => b.branch_name) },
      { key: "room_name", label: "f_name", type: "text", required: true },
      { key: "max_capacity", label: "f_max_capacity", type: "number", required: true },
    ],
    blank: () => ({ branch_id: s(data.branches[0]?.branch_id), room_name: "", max_capacity: "20" }),
    toForm: (r) => ({ branch_id: s(r.branch_id), room_name: s(r.room_name), max_capacity: s(r.max_capacity) }),
    fromForm: (f) => (Number(f.max_capacity) > 0
      ? { branch_id: Number(f.branch_id), room_name: f.room_name.trim(), max_capacity: Number(f.max_capacity) } : "invalid_value"),
    ...crud("rooms"),
  };

  const today = dayKey(new Date().toISOString());
  const effective = (m: Row) => (m.membership_status === "Suspended" ? "Suspended" : s(m.membership_expiry) < today ? "Expired" : "Active");
  const membersCfg: CrudConfig = {
    rows: data.members as unknown as Row[], id: (r) => Number(r.member_id), canCreate: false, canDelete: false,
    columns: [
      { label: "f_member", cell: (r) => <b>{s(r.member_name)} {s(r.member_surname)}</b> },
      { label: "f_phone", cell: (r) => s(r.phone_number) },
      { label: "role", cell: (r) => t(`role_${s(r.role)}` as Key) + (r.trainer_id ? ` (${data.trainers.find((x) => x.trainer_id === r.trainer_id)?.trainer_name ?? ""})` : "") },
      { label: "f_status", cell: (r) => <span className={`pill st-${effective(r).toLowerCase()}`}>{t(`st_${effective(r)}` as Key)}</span> },
      { label: "f_expiry", cell: (r) => fmtDate(s(r.membership_expiry), lang) },
    ],
    fields: [
      { key: "role", label: "role", type: "select", required: true,
        options: (["Member", "Trainer", "Receptionist", "Admin"] as const).map((x) => ({ value: x, label: t(`role_${x}`) })) },
      { key: "trainer_id", label: "f_linked_trainer", type: "select",
        options: [{ value: "", label: t("none") }, ...opts(data.trainers, (x) => x.trainer_id, (x) => x.trainer_name)] },
      { key: "membership_status", label: "f_status", type: "select", required: true,
        options: (["Active", "Suspended"] as const).map((x) => ({ value: x, label: t(`st_${x}`) })) },
      { key: "membership_expiry", label: "f_expiry", type: "date", required: true },
    ],
    toForm: (r) => ({ role: s(r.role), trainer_id: s(r.trainer_id), membership_status: s(r.membership_status), membership_expiry: s(r.membership_expiry) }),
    fromForm: (f) => {
      if (f.role === "Trainer" && !f.trainer_id) return "trainer_needs_link";
      return { role: f.role, trainer_id: f.role === "Trainer" ? n(f.trainer_id) : null,
        membership_status: f.membership_status, membership_expiry: f.membership_expiry };
    },
    save: (id, row) => api.adminUpdate("members", id!, row),
  };

  const configs: Partial<Record<Tab, CrudConfig>> = {
    sessions: sessionsCfg, classes: classesCfg, trainers: trainersCfg, branches: branchesCfg, rooms: roomsCfg, members: membersCfg,
  };

  const pending = data.applications.filter((a) => a.status === "Pending").length;

  return (
    <>
      <h1>{t("admin_title")}</h1>
      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "active" : ""} onClick={() => setTab(x.id)}>
            {t(x.label)}
            {x.id === "applications" && pending > 0 && <span className="count">{pending}</span>}
          </button>
        ))}
      </div>

      {tab === "report" ? (
        <AttendanceReport rows={data.report} />
      ) : tab === "applications" ? (
        <TrainerApplications rows={data.applications} onResult={onResult} />
      ) : tab !== "checkin" ? (
        <CrudSection key={tab} cfg={configs[tab]!} onResult={onResult} />
      ) : (
        <>
          <p className="muted small">{t("checkin_desc")}</p>
          <p className="muted small">{t("manual_desc")}</p>
          <div className="filters">
            <select value={readerId} onChange={(e) => setReaderId(e.target.value)} aria-label={t("reader")}>
              {data.readers.map((r) => <option key={r.reader_id} value={r.reader_id}>{r.reader_id} · {r.branch_name} ({r.check_in_method})</option>)}
            </select>
          </div>
          {data.bookings.length === 0 ? <p className="muted">{t("no_checkins")}</p> : (
            <ul className="list">
              {data.bookings.map((b) => (
                <li key={b.booking_id} className="row-item">
                  <div>
                    <b>{b.member_fullname}</b> <span className="muted">· {b.class_name}</span>
                    <div className="small muted">{fmtDayShort(b.start_time, lang)}, {fmtTime(b.start_time)} · {b.branch_name}, {b.room_name}</div>
                  </div>
                  <div className="right">
                    <span className={`pill ${b.booking_status.toLowerCase()}`}>{t(`bs_${b.booking_status}`)}</span>
                    <button className="btn" disabled={b.booking_status !== "Confirmed" || !readerId}
                      onClick={async () => onResult(await api.checkIn(b.booking_id, readerId))}>{t("tap")}</button>
                    {/* Plan B: NFC failed. Only after the class has started (Task 7: no "Attended" for a future class). */}
                    {b.booking_status !== "Attended" && new Date(b.start_time).getTime() <= now && (
                      <button className="btn ghost" onClick={async () => onResult(await api.manualCheckIn(b.booking_id))}>{t("manual_checkin")}</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Toast msg={toast} onDone={() => setToast(null)} />
    </>
  );
}

// ---------- Attendance report: finished classes, came vs. missed ----------
function AttendanceReport({ rows }: { rows: AttendanceRow[] }) {
  const { t, lang } = useT();
  if (rows.length === 0) return <p className="muted">{t("report_empty")}</p>;

  const attended = rows.reduce((sum, r) => sum + r.attended, 0);
  const noShow = rows.reduce((sum, r) => sum + r.no_show, 0);
  return (
    <>
      <p className="muted small">{t("report_desc")}</p>
      <div className="notice">
        <b>{t("report_total", { rate: fmtRate(attendanceRate(attended, noShow)), attended, no_show: noShow })}</b>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{t("f_date")}</th><th>{t("f_class")}</th><th>{t("f_trainer")}</th><th>{t("f_branch")}</th>
            <th>{t("booked_col")}</th><th>{t("col_attended")}</th><th>{t("col_no_show")}</th><th>{t("col_rate")}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const rate = attendanceRate(r.attended, r.no_show);
              return (
                <tr key={r.session_id}>
                  <td className="nowrap">{fmtDayShort(r.start_time, lang)}, {fmtTime(r.start_time)}</td>
                  <td><b>{r.class_name}</b></td>
                  <td>{r.trainer_name}</td>
                  <td>{r.branch_name}</td>
                  <td>{r.booked} / {r.capacity}</td>
                  <td>{r.attended}</td>
                  <td>{r.no_show}</td>
                  <td className={rate !== null && rate < LOW_ATTENDANCE ? "bad-text" : ""}><b>{fmtRate(rate)}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- Trainer applications: check certificates, approve or reject ----------
function TrainerApplications({ rows, onResult }: { rows: TrainerApplication[]; onResult: (r: Result) => void }) {
  const { t, lang } = useT();
  const [rejecting, setRejecting] = useState<TrainerApplication | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  async function decide(a: TrainerApplication, approve: boolean, why?: string) {
    setBusy(a.application_id);
    const r = await api.reviewTrainerApplication(a.application_id, approve, why);
    setBusy(null);
    setRejecting(null); setReason("");
    onResult(r);
  }

  async function openFile(path: string) {
    // open the tab first (popup blockers), then point it at the short-lived link
    const w = window.open("", "_blank");
    let url = await api.certificateUrl(path);
    // demo mode keeps files as data: URLs, which browsers won't open directly
    if (url?.startsWith("data:")) url = URL.createObjectURL(await (await fetch(url)).blob());
    if (url && w) w.location.href = url;
    else { w?.close(); onResult({ ok: false, code: "error", message: t("app_no_file") }); }
  }

  if (rows.length === 0) return <p className="muted">{t("app_empty")}</p>;
  return (
    <>
      <p className="muted small">{t("approve_note")}</p>
      <ul className="list">
        {rows.map((a) => (
          <li key={a.application_id} className="row-item col" data-application={a.application_id}>
            <div className="app-head">
              <b>{a.member_fullname}</b>
              <span className={`pill ${a.status === "Pending" ? "st-pending" : a.status === "Approved" ? "st-active" : "st-suspended"}`}>
                {t(`app_status_${a.status}`)}
              </span>
            </div>
            <div className="small muted">
              {a.phone_number} · {a.email} · {t("app_submitted")}: {fmtDayShort(a.created_at, lang)}, {fmtTime(a.created_at)}
            </div>
            <div className="small"><b>{t("f_specialization_short")}:</b> {a.specialization} · <b>{t("f_experience")}:</b> {a.experience_years}</div>
            {a.bio && <div className="small bio">{a.bio}</div>}
            <div className="small"><b>{t("app_files")}:</b>{" "}
              {a.certificates.map((c, i) => (
                <span key={c.path}>{i > 0 && ", "}
                  <button className="link" onClick={() => openFile(c.path)}>{c.name}</button>
                </span>
              ))}
            </div>
            {a.status === "Rejected" && a.reject_reason && <div className="small muted">{t("app_reason", { reason: a.reject_reason })}</div>}
            {a.status === "Pending" && (
              <div className="right">
                <button className="btn" disabled={busy === a.application_id} onClick={() => decide(a, true)}>{t("approve")}</button>
                <button className="btn ghost" disabled={busy === a.application_id} onClick={() => setRejecting(a)}>{t("reject")}</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {rejecting && (
        <Modal title={t("reject_title")} onClose={() => setRejecting(null)} actions={<>
          <button className="btn ghost" onClick={() => setRejecting(null)}>{t("close")}</button>
          <button className="btn danger" disabled={busy !== null} onClick={() => decide(rejecting, false, reason)}>{t("reject")}</button>
        </>}>
          <p><b>{rejecting.member_fullname}</b> · {rejecting.specialization}</p>
          <label className="form">{t("reject_reason_label")}
            <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Modal>
      )}
    </>
  );
}
