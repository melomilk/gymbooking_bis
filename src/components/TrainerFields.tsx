"use client";
// Extra fields a would-be trainer fills in. Used on the registration form and,
// as a standalone form, on the profile page (apply, re-apply after a rejection
// or a failed upload, or edit an application that is still under review).
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { CERT_MAX_BYTES, CERT_MAX_FILES, CERT_TYPES, type CertificateFile, type Result, type TrainerApplication, type TrainerApplicationInput } from "@/lib/types";
import { checkTrainerApplication } from "@/lib/validate";
import { forgetSessionState, useSessionState } from "@/lib/useSessionState";
import { useT } from "./Providers";

/** `files` = new files picked now; `kept` = certificates uploaded earlier that stay (editing). */
export type TrainerForm = { email: string; specialization: string; experience: string; bio: string; files: File[]; kept: CertificateFile[]; consent: boolean };
export const emptyTrainerForm = (): TrainerForm => ({ email: "", specialization: "", experience: "", bio: "", files: [], kept: [], consent: false });

/** A sent application, back in the form for editing. The consent box must be ticked again. */
export const fromApplication = (a: TrainerApplication): TrainerForm => ({
  email: a.email, specialization: a.specialization, experience: String(a.experience_years), bio: a.bio ?? "",
  files: [], kept: a.certificates, consent: false,
});

/** Form -> API input. `experience` stays NaN when empty, so validation reports it. */
export const toApplicationInput = (f: TrainerForm): TrainerApplicationInput => ({
  email: f.email, specialization: f.specialization,
  experience_years: f.experience.trim() === "" ? NaN : Number(f.experience), bio: f.bio,
});

type FieldKey = "email" | "specialization" | "experience" | "files" | "consent";

/** Required fields that are still empty or unchecked. */
function emptyRequired(f: TrainerForm): FieldKey[] {
  const out: FieldKey[] = [];
  if (!f.email.trim()) out.push("email");
  if (!f.specialization.trim()) out.push("specialization");
  if (!f.experience.trim()) out.push("experience");
  if (f.files.length + f.kept.length === 0) out.push("files");
  if (!f.consent) out.push("consent");
  return out;
}

/** Fields to outline in red: empty required ones plus ones with a wrong value. */
export function trainerProblems(f: TrainerForm): Set<FieldKey> {
  const bad = new Set(emptyRequired(f));
  const code = checkTrainerApplication(toApplicationInput(f), f.files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES }, f.kept.length);
  if (code === "invalid_email") bad.add("email");
  if (code === "invalid_value" && f.experience.trim()) bad.add("experience");
  if (code === "certificates_required" || code === "bad_file_type" || code === "file_too_large") bad.add("files");
  return bad;
}

/** Error code for the whole form: "required" if anything required is empty, else the first wrong value. */
export function trainerFormError(f: TrainerForm): string | null {
  if (emptyRequired(f).length) return "required";
  return checkTrainerApplication(toApplicationInput(f), f.files, { maxFiles: CERT_MAX_FILES, maxBytes: CERT_MAX_BYTES, types: CERT_TYPES }, f.kept.length);
}

/** Moves the cursor to the first field outlined in red. */
export function focusFirstInvalid(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

/** Sends the application. Checks the form first (consent box is a UI-only rule). */
export async function sendApplication(f: TrainerForm): Promise<Result> {
  const err = trainerFormError(f);
  if (err) return { ok: false, code: err };
  return api.submitTrainerApplication(toApplicationInput(f), f.files);
}

const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** Red star after the label of a required field. */
const Req = () => <span className="req" aria-hidden> *</span>;
/** Label text + red star, kept on one line (labels stack their children). */
const ReqLabel = ({ text }: { text: string }) => <span>{text}<Req /></span>;

export default function TrainerFields({ value, onChange, showErrors = false, disabled = false }: {
  value: TrainerForm; onChange: (f: TrainerForm) => void;
  /** outline missing / wrong fields in red (after the first "Send" attempt) */
  showErrors?: boolean;
  /** locks every field while the application is being sent */
  disabled?: boolean;
}) {
  const { t } = useT();
  const problems = showErrors ? trainerProblems(value) : new Set<FieldKey>();
  const inv = (k: FieldKey) => (problems.has(k) ? { "aria-invalid": true as const, className: "invalid" } : {});
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (k: "email" | "specialization" | "experience" | "bio") =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value });

  function addFiles(list: FileList | null) {
    if (!list) return;
    // same file picked twice -> keep one
    const known = new Set(value.files.map((f) => `${f.name}|${f.size}`));
    const added = Array.from(list).filter((f) => !known.has(`${f.name}|${f.size}`));
    onChange({ ...value, files: [...value.files, ...added].slice(0, CERT_MAX_FILES - value.kept.length) });
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <fieldset className="trainer-fields" disabled={disabled}>
      <legend>{t("trainer_details")}</legend>
      <span className="small muted"><span className="req">*</span> {t("required_legend")}</span>
      <label><ReqLabel text={t("f_email")} /><input type="email" required value={value.email} onChange={set("email")} autoComplete="email" {...inv("email")} /></label>
      <div className="row">
        <label><ReqLabel text={t("f_specialization")} /><input required value={value.specialization} onChange={set("specialization")} maxLength={200} {...inv("specialization")} /></label>
        <label className="narrow"><ReqLabel text={t("f_experience")} /><input type="number" min={0} max={60} required value={value.experience} onChange={set("experience")} {...inv("experience")} /></label>
      </div>
      <label>{t("f_bio")}<textarea rows={3} maxLength={2000} value={value.bio} onChange={set("bio")} /></label>

      <label><ReqLabel text={t("f_certificates")} />
        <input ref={fileInput} type="file" multiple accept={CERT_TYPES.join(",")}
          disabled={value.files.length + value.kept.length >= CERT_MAX_FILES} onChange={(e) => addFiles(e.target.files)} {...inv("files")} />
        <span className="small muted">{t("cert_hint")}</span>
      </label>
      {value.files.length + value.kept.length > 0 && (
        <ul className="file-list">
          {value.kept.map((c) => (
            <li key={c.path}>
              <span>{c.name} <span className="muted small">· {t("cert_uploaded")}</span></span>
              <button type="button" className="link" onClick={() => onChange({ ...value, kept: value.kept.filter((k) => k.path !== c.path) })}>
                {t("cert_remove")}
              </button>
            </li>
          ))}
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

      <label className={`check ${problems.has("consent") ? "invalid-check" : ""}`}>
        <input type="checkbox" checked={value.consent} onChange={(e) => onChange({ ...value, consent: e.target.checked })}
          aria-invalid={problems.has("consent") || undefined} />
        <span>{t("trainer_consent")}<Req /></span>
      </label>
    </fieldset>
  );
}

const DRAFT_KEY = "trainer.applyDraft";
type Draft = Omit<TrainerForm, "files" | "kept">;

/**
 * Standalone application form (profile page). With `existing` it edits that
 * pending application; without it, it sends a new one and remembers the typed
 * text while the user visits other pages (files can't be remembered by a browser).
 */
export function TrainerApplyForm({ onDone, existing, onCancel }: {
  onDone: (r: Result) => void; existing?: TrainerApplication; onCancel?: () => void;
}) {
  const { t, tr } = useT();
  const start = existing ? fromApplication(existing) : emptyTrainerForm();
  const [draft, setDraft] = useSessionState<Draft>(existing ? null : DRAFT_KEY,
    { email: start.email, specialization: start.specialization, experience: start.experience, bio: start.bio, consent: start.consent });
  const [files, setFiles] = useState<File[]>([]);
  const [kept, setKept] = useState<CertificateFile[]>(start.kept);
  const f: TrainerForm = { ...draft, files, kept };
  const setF = (n: TrainerForm) => {
    const { files: nf, kept: nk, ...rest } = n;
    setDraft(rest); setFiles(nf); setKept(nk);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (busy) return;
    const bad = trainerFormError(f);
    if (bad) {
      setShowErrors(true);
      setError(tr({ code: bad }));
      setTimeout(() => focusFirstInvalid(formRef.current), 0); // after the red outlines are drawn
      return;
    }
    setBusy(true); setError(null);
    const r = existing
      ? await api.updateTrainerApplication(toApplicationInput(f), f.kept, f.files)
      : await sendApplication(f);
    setBusy(false);
    if (!r.ok) return setError(tr(r));
    if (!existing) forgetSessionState(DRAFT_KEY); // sent: start empty next time
    onDone(r);
  }

  return (
    <form ref={formRef} onSubmit={submit} className="form apply-form" noValidate>
      {existing && <p className="small muted">{t("app_edit_note")}</p>}
      <TrainerFields value={f} onChange={setF} showErrors={showErrors} disabled={busy} />
      {error && <div className="notice bad" role="alert">{error}</div>}
      <div className="right">
        {onCancel && <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>{t("discard")}</button>}
        <button className="btn" disabled={busy}>{busy ? t("please_wait") : existing ? t("app_update_btn") : t("send_application")}</button>
      </div>
    </form>
  );
}
