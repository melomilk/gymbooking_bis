// Shared by the browser, the demo store and the /api/register route.

/** Normalises a phone to +<digits>. Kazakh numbers: 8XXXXXXXXXX -> +7XXXXXXXXXX, 10 digits -> +7... */
export function normalizePhone(raw: string): string | null {
  let d = (raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length < 11 || d.length > 15) return null;
  return "+" + d;
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
): string | null {
  if (!validEmail(i.email)) return "invalid_email";
  if (!i.specialization.trim()) return "required";
  if (!Number.isInteger(i.experience_years) || i.experience_years < 0 || i.experience_years > 60) return "invalid_value";
  if (i.bio.length > 2000) return "invalid_value";
  if (files.length < 1 || files.length > limits.maxFiles) return "certificates_required";
  if (files.some((f) => !limits.types.includes(f.type))) return "bad_file_type";
  if (files.some((f) => f.size > limits.maxBytes)) return "file_too_large";
  return null;
}
