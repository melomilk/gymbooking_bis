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
