// Shared by the browser, the demo store and the /api/register route.

/** Normalises a phone to +<digits>. Kazakh numbers: 8XXXXXXXXXX -> +7XXXXXXXXXX, 10 digits -> +7... */
export function normalizePhone(raw: string): string | null {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // international prefix: 007 701 ... = +7 701 ...
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length < 11 || d.length > 15) return null;
  return "+" + d;
}

/**
 * The phone as it is stored, grouped for reading: "87011234567" -> "+7 701 123 45 67".
 * Used when the user leaves the phone field, so every format ends up looking the same.
 * Text that isn't a valid number stays as typed.
 */
export function formatPhone(raw: string): string {
  const p = normalizePhone(raw);
  if (!p) return raw;
  const d = p.slice(1);
  if (d.length === 11 && d.startsWith("7")) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
  return p;
}

export function validName(s: string): boolean {
  return /^[\p{L}][\p{L}\s'’-]{0,99}$/u.test((s || "").trim());
}

export const MIN_PASSWORD = 6;

/**
 * Supabase Auth needs an email, but members log in with a phone (FR-04).
 * Each phone maps to a fixed internal address that never receives mail.
 */
export function phoneToAuthEmail(phone: string): string {
  const domain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "phone.pulsegym.app";
  return `${phone.replace(/\D/g, "")}@${domain}`;
}

/** Strip characters that have meaning in PostgREST filters. */
export function cleanQuery(q: string): string {
  return (q || "").replace(/[,()*%\\:."']/g, " ").trim().slice(0, 60);
}

export function validEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((s || "").trim());
}

/** Checks the trainer application before anything is uploaded. Returns an error code or null. */
export function checkTrainerApplication(
  i: { email: string; specialization: string; experience_years: number; bio: string },
  files: { size: number; type: string }[],
  limits: { maxFiles: number; maxBytes: number; types: string[] },
  /** certificates already uploaded earlier and kept (editing an application) */
  keptFiles = 0,
): string | null {
  if (!validEmail(i.email)) return "invalid_email";
  if (!i.specialization.trim()) return "required";
  if (!Number.isInteger(i.experience_years) || i.experience_years < 0 || i.experience_years > 60) return "invalid_value";
  if (i.bio.length > 2000) return "invalid_value";
  if (files.length + keptFiles < 1 || files.length + keptFiles > limits.maxFiles) return "certificates_required";
  if (files.some((f) => !limits.types.includes(f.type))) return "bad_file_type";
  if (files.some((f) => f.size > limits.maxBytes)) return "file_too_large";
  return null;
}

/** Excused no-show (same rules as excuse_no_show() in migration_excuse_no_show.sql). Returns an error code or null. */
export function checkExcuse(
  i: { reason: string; note: string; file: { size: number; type: string } | null },
  limits: { maxBytes: number; types: string[] },
): string | null {
  if (!["Illness", "Family", "Work", "Other"].includes(i.reason)) return "invalid_reason";
  if (i.reason === "Other" && !i.note.trim()) return "note_required";
  if (i.reason === "Illness" && !i.file) return "document_required";
  if (i.file) {
    if (!limits.types.includes(i.file.type)) return "pdf_only";
    if (i.file.size > limits.maxBytes) return "file_too_large";
  }
  return null;
}
