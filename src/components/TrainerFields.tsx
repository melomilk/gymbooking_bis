"use client";
// Extra fields a would-be trainer fills in. Used on the registration form and,
// as a standalone form, on the profile page (re-apply after a rejection or a
// failed upload).
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { CERT_MAX_FILES, CERT_TYPES, type Result, type TrainerApplicationInput } from "@/lib/types";
import { useT } from "./Providers";

export type TrainerForm = { email: string; specialization: string; experience: string; bio: string; files: File[]; consent: boolean };
export const emptyTrainerForm = (): TrainerForm => ({ email: "", specialization: "", experience: "", bio: "", files: [], consent: false });

/** Form -> API input. `experience` stays NaN when empty, so validation reports it. */
export const toApplicationInput = (f: TrainerForm): TrainerApplicationInput => ({
  email: f.email, specialization: f.specialization,
  experience_years: f.experience.trim() === "" ? NaN : Number(f.experience), bio: f.bio,
});

/** Sends the application. Checks the consent box first (UI-only rule). */
export async function sendApplication(f: TrainerForm): Promise<Result> {
  if (!f.consent) return { ok: false, code: "consent_required" };
  return api.submitTrainerApplication(toApplicationInput(f), f.files);
}

const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export default function TrainerFields({ value, onChange }: { value: TrainerForm; onChange: (f: TrainerForm) => void }) {
  const { t } = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (k: "email" | "specialization" | "experience" | "bio") =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value });

  function addFiles(list: FileList | null) {
    if (!list) return;
    // same file picked twice -> keep one
    const known = new Set(value.files.map((f) => `${f.name}|${f.size}`));
    const added = Array.from(list).filter((f) => !known.has(`${f.name}|${f.size}`));
    onChange({ ...value, files: [...value.files, ...added].slice(0, CERT_MAX_FILES) });
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <fieldset className="trainer-fields">
      <legend>{t("trainer_details")}</legend>
      <label>{t("f_email")}<input type="email" required value={value.email} onChange={set("email")} autoComplete="email" /></label>
      <div className="row">
        <label>{t("f_specialization")}<input required value={value.specialization} onChange={set("specialization")} maxLength={200} /></label>
        <label className="narrow">{t("f_experience")}<input type="number" min={0} max={60} required value={value.experience} onChange={set("experience")} /></label>
      </div>
      <label>{t("f_bio")}<textarea rows={3} maxLength={2000} value={value.bio} onChange={set("bio")} /></label>

      <label>{t("f_certificates")}
        <input ref={fileInput} type="file" multiple accept={CERT_TYPES.join(",")}
          disabled={value.files.length >= CERT_MAX_FILES} onChange={(e) => addFiles(e.target.files)} />
        <span className="small muted">{t("cert_hint")}</span>
      </label>
      {value.files.length > 0 && (
        <ul className="file-list">
          {value.files.map((f, i) => (
            <li key={`${f.name}-${f.size}`}>
              <span>{f.name} <span className="muted small">· {fmtSize(f.size)}</span></span>
              <button type="button" className="link" onClick={() => onChange({ ...value, files: value.files.filter((_, j) => j !== i) })}>
                {t("cert_remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="check">
        <input type="checkbox" checked={value.consent} onChange={(e) => onChange({ ...value, consent: e.target.checked })} />
        <span>{t("trainer_consent")}</span>
      </label>
    </fieldset>
  );
}

/** Standalone application form (profile page). */
export function TrainerApplyForm({ onDone }: { onDone: (r: Result) => void }) {
  const { t, tr } = useT();
  const [f, setF] = useState<TrainerForm>(emptyTrainerForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await sendApplication(f);
    setBusy(false);
    if (!r.ok) return setError(tr(r));
    onDone(r);
  }

  return (
    <form onSubmit={submit} className="form apply-form" noValidate>
      <TrainerFields value={f} onChange={setF} />
      {error && <div className="notice bad" role="alert">{error}</div>}
      <button className="btn" disabled={busy}>{busy ? t("please_wait") : t("send_application")}</button>
    </form>
  );
}
