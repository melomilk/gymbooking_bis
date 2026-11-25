"use client";
// "Right now in the club": who is training (public profiles only) and how busy the branch is.
// The front desk marks arrivals and departures (StaffClubVisits below).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth, useT } from "./Providers";
import Modal from "./Modal";
import { fmtDate, fmtTime } from "@/lib/format";
import { LOAD_SEGMENTS, loadSegments } from "@/lib/club";
import type { Branch, ClubNow, ClubPerson, ClubVisit, MemberLookup, PublicProfile, Result } from "@/lib/types";
import { useSessionState } from "@/lib/useSessionState";

const REFRESH_MS = 60_000;

function PeopleIcon() {
  return (
    <svg className="club-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="7" r="3.2" /><circle cx="5" cy="9" r="2.4" /><circle cx="19" cy="9" r="2.4" />
      <path d="M6.5 19c0-3.3 2.5-5.6 5.5-5.6s5.5 2.3 5.5 5.6z" /><path d="M1 18.5c0-2.6 1.6-4.4 4-4.4 1 0 1.8.3 2.4.8-1 1-1.6 2.3-1.8 3.6z" />
      <path d="M23 18.5c0-2.6-1.6-4.4-4-4.4-1 0-1.8.3-2.4.8 1 1 1.6 2.3 1.8 3.6z" />
    </svg>
  );
}

/** 10 segments; colour by level (low / medium / high). */
export function LoadBar({ present, capacity, level }: { present: number; capacity: number; level: ClubNow["load"] }) {
  const lit = loadSegments(present, capacity);
  return (
    <div className={`load-bar ${level}`} role="img" aria-label={`${present} / ${capacity}`}>
      {Array.from({ length: LOAD_SEGMENTS }, (_, i) => <span key={i} className={i < lit ? "on" : ""} />)}
    </div>
  );
}

export function ClubNowWidget() {
  const { me } = useAuth();
  const { t } = useT();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchSel, setBranch] = useSessionState("club.branch", "");
  const [now, setNow] = useState<ClubNow | null | undefined>(undefined); // undefined = loading
  const [updated, setUpdated] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<ClubPerson | null>(null);

  useEffect(() => { api.listBranches().then(setBranches).catch(() => setBranches([])); }, []);
  const branchId = branches.some((b) => String(b.branch_id) === branchSel) ? Number(branchSel) : branches[0]?.branch_id;

  const load = useCallback(async () => {
    if (!branchId) return;
    const r = await api.clubNow(branchId).catch(() => null);
    setNow(r);
    setUpdated(new Date().toISOString());
  }, [branchId]);

  // refresh every minute while the page is open (people come and go)
  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, me]);

  if (!branchId || now === null) return null; // no branches, or the migration isn't applied yet
  const branchName = branches.find((b) => b.branch_id === branchId)?.branch_name ?? "";

  return (
    <section className="club" aria-labelledby="club-title">
      <div className="club-head">
        <div>
          <h2 id="club-title">
            {t("club_title")} <span className="info" title={t("club_info")} aria-label={t("club_info")} tabIndex={0}>i</span>
          </h2>
          <p className="muted small">{t("club_sub")}</p>
        </div>
        {branches.length > 1 && (
          <select value={branchId} onChange={(e) => setBranch(e.target.value)} aria-label={t("f_branch")}>
            {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
          </select>
        )}
      </div>

      {now === undefined ? <p className="muted small">{t("loading")}</p> : (
        <>
          {!me ? (
            <p className="small"><Link href="/login">{t("club_login_to_see")}</Link></p>
          ) : now.people.length === 0 && now.hidden === 0 ? (
            <p className="muted small">{t("club_nobody_public")}</p>
          ) : (
            <ul className="club-people">
              {now.people.map((p) => (
                <li key={p.member_id}>
                  <button className="club-person" onClick={() => setPerson(p)} title={p.name}>
                    <span className="avatar">{p.initials}</span>
                    <span className="visits" title={t("club_visits_n", { n: p.visits })}>{p.visits}</span>
                    <span className="club-name">{p.name}</span>
                  </button>
                </li>
              ))}
              {now.hidden > 0 && (
                <li>
                  <div className="club-person" title={t("club_hidden_more", { n: now.hidden })}>
                    <span className="avatar more">+{now.hidden}</span>
                    <span className="club-name muted">{t("visit_private")}</span>
                  </div>
                </li>
              )}
            </ul>
          )}

          <div className="club-load">
            <PeopleIcon />
            <div className="club-load-text">
              <b>{t("club_load_title")}</b>
              <span className={`muted load-word ${now.load}`}>{t(`load_${now.load}`)}</span>
            </div>
            <LoadBar present={now.present} capacity={now.capacity} level={now.load} />
          </div>
          {open && (
            <div className="club-details small">
              <p>{t("club_present", { n: now.present })} · {branchName}</p>
              <p className="muted">{t("club_capacity_note", { cap: now.capacity })}</p>
              <p className="muted">{t("club_load_rule")}</p>
              {updated && <p className="muted">{t("club_updated", { time: fmtTime(updated) })}</p>}
            </div>
          )}
          <div className="center">
            <button className="btn ghost sm" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
              {open ? t("club_collapse") : t("club_expand")}
            </button>
          </div>
        </>
      )}
      {person && <PublicProfileModal person={person} onClose={() => setPerson(null)} />}
    </section>
  );
}

export function PublicProfileModal({ person, onClose }: { person: ClubPerson; onClose: () => void }) {
  const { t, lang } = useT();
  const [p, setP] = useState<PublicProfile | null | undefined>(undefined);
  useEffect(() => { api.publicProfile(person.member_id).then(setP).catch(() => setP(null)); }, [person.member_id]);
  return (
    <Modal title={person.name} onClose={onClose} actions={<button className="btn ghost" onClick={onClose}>{t("close")}</button>}>
      {p === undefined ? <p className="muted">{t("loading")}</p> : p === null ? <p className="muted">{t("pp_private")}</p> : (
        <>
          <div className="pp-head">
            <span className="avatar big">{p.initials}</span>
            {p.in_club && <span className="small good-text">{t("pp_in_club", { branch: p.in_club.branch_name, time: fmtTime(p.in_club.entered_at) })}</span>}
          </div>
          <dl className="profile">
            <div><dt>{t("pp_visits_total")}</dt><dd>{p.visits_total}</dd></div>
            <div><dt>{t("pp_visits_month")}</dt><dd>{p.visits_month}</dd></div>
            <div><dt>{t("pp_classes")}</dt><dd>{p.classes_attended}</dd></div>
            {p.favourite_class && <div><dt>{t("pp_favourite")}</dt><dd>{p.favourite_class}</dd></div>}
            {p.first_visit && <div><dt>{t("pp_first_visit")}</dt><dd>{fmtDate(p.first_visit.slice(0, 10), lang)}</dd></div>}
          </dl>
        </>
      )}
    </Modal>
  );
}

/** Profile page: switch between a public and a private profile. */
export function PublicProfileToggle({ value, onResult }: { value: boolean; onResult: (r: Result) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="notice public-toggle" id="public-profile">
      <label className="check">
        <input type="checkbox" checked={value} disabled={busy}
          onChange={async (e) => { setBusy(true); onResult(await api.setProfilePublic(e.target.checked)); setBusy(false); }} />
        <b>{t("profile_public_label")}</b>
      </label>
      <p className="small muted">{t("profile_public_hint")}</p>
    </div>
  );
}

/** Admin / reception tab: mark arrivals and departures, see who is in the branch. */
export function StaffClubVisits({ onResult }: { onResult: (r: Result) => void }) {
  const { t } = useT();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchSel, setBranch] = useSessionState("staff.club.branch", "");
  const [q, setQ] = useSessionState("staff.club.q", "");
  const [found, setFound] = useState<MemberLookup[]>([]);
  const [visits, setVisits] = useState<ClubVisit[]>([]);
  const [now, setNow] = useState<ClubNow | null>(null);

  useEffect(() => { api.listBranches().then(setBranches); }, []);
  const branchId = branches.some((b) => String(b.branch_id) === branchSel) ? Number(branchSel) : branches[0]?.branch_id;
  const branchName = (id: number | null) => branches.find((b) => b.branch_id === id)?.branch_name ?? "";

  const load = useCallback(async () => {
    if (!branchId) return;
    const [v, n, f] = await Promise.all([api.clubVisitsNow(branchId), api.clubNow(branchId), api.staffFindMembers(q)]);
    setVisits(v); setNow(n); setFound(f);
  }, [branchId, q]);
  useEffect(() => { load(); }, [load]);

  async function act(r: Promise<Result>) {
    const res = await r;
    onResult(res);
    if (res.ok) load();
  }

  if (!branchId) return <p className="muted">{t("loading")}</p>;
  return (
    <>
      <p className="muted small">{t("visit_desc")}</p>
      <div className="filters">
        <select value={branchId} onChange={(e) => setBranch(e.target.value)} aria-label={t("f_branch")}>
          {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
        </select>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("visit_search")} aria-label={t("visit_search")} />
      </div>

      {q.trim() !== "" && (found.length === 0 ? <p className="muted small">{t("visit_no_match")}</p> : (
        <ul className="list">
          {found.map((m) => (
            <li key={m.member_id} className="row-item">
              <div>
                <b>{m.member_fullname}</b> <span className="muted small">· {m.phone_number}</span>
                {m.effective_status !== "Active" && <> <span className="pill st-expired">{t(`st_${m.effective_status}`)}</span></>}
              </div>
              <div className="right">
                {m.in_club_branch_id === branchId ? <span className="pill attended">{t("visit_here")}</span>
                  : m.in_club_branch_id ? <span className="pill">{t("visit_other_branch", { branch: branchName(m.in_club_branch_id) })}</span>
                  : <button className="btn sm" onClick={() => act(api.visitEnter(m.member_id, branchId))}>{t("visit_arrived")}</button>}
              </div>
            </li>
          ))}
        </ul>
      ))}

      {now && (
        <div className="club-load staff">
          <PeopleIcon />
          <div className="club-load-text">
            <b>{t("club_present", { n: now.present })}</b>
            <span className={`muted load-word ${now.load}`}>{t("club_load_title")}: {t(`load_${now.load}`)} · {t("club_capacity_note", { cap: now.capacity })}</span>
          </div>
          <LoadBar present={now.present} capacity={now.capacity} level={now.load} />
        </div>
      )}

      <h2>{t("visit_now_title", { branch: branchName(branchId) })}</h2>
      {visits.length === 0 ? <p className="muted">{t("visit_none")}</p> : (
        <ul className="list" id="club-visits">
          {visits.map((v) => (
            <li key={v.visit_id} className="row-item">
              <div>
                <b>{v.member_fullname}</b> <span className="muted small">· {t("visit_since", { time: fmtTime(v.entered_at) })}</span>
                <div className="small muted">{v.phone_number}</div>
              </div>
              <div className="right">
                <span className="pill">{v.is_public ? t("visit_public") : t("visit_private")}</span>
                <button className="btn ghost sm" onClick={() => act(api.visitLeave(v.visit_id))}>{t("visit_left")}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
