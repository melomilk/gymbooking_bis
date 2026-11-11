"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth, useRequireRole, useT } from "@/components/Providers";
import { fmtDayShort, fmtTime } from "@/lib/format";
import type { RosterRow } from "@/lib/types";

export default function TrainerPage() {
  const { allowed } = useRequireRole(["Trainer"]);
  const { me } = useAuth();
  const { t, lang } = useT();
  const [rows, setRows] = useState<RosterRow[] | null>(null);

  useEffect(() => { if (allowed) api.trainerRoster().then(setRows); }, [allowed]);
  if (!allowed || !rows) return <p className="muted">{t("loading")}</p>;
  if (!me?.trainer_id) return <div className="notice bad">{t("not_linked")}</div>;

  const sessions = Array.from(new Map(rows.map((r) => [r.session_id, r])).values());
  return (
    <>
      <h1>{t("trainer_title")}</h1>
      {sessions.length === 0 && <p className="muted">{t("no_upcoming_sessions")}</p>}
      <ul className="list">
        {sessions.map((s) => {
          const people = rows.filter((r) => r.session_id === s.session_id && r.member_fullname);
          return (
            <li key={s.session_id} className="row-item col">
              <div>
                <b>{s.class_name}</b> · {fmtDayShort(s.start_time, lang)}, {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
                <div className="small muted">{s.branch_name}, {s.room_name} · {t("spots_left", { left: s.capacity - people.length, cap: s.capacity })}</div>
              </div>
              <div className="small"><b>{t("attendees")}:</b>{" "}
                {people.length === 0 ? <span className="muted">{t("no_attendees")}</span>
                  : people.map((p) => `${p.member_fullname}${p.booking_status === "Attended" ? " ✓" : p.booking_status === "No-show" ? ` (${t("bs_No-show")})` : ""}`).join(", ")}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
