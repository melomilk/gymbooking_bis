import { LANGS, type Lang } from "./i18n";

const TZ = "Asia/Almaty";
const loc = (l: Lang) => LANGS.find((x) => x.code === l)!.locale;

export const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

// Many browsers ship without Kazakh date data (they print "M11 4, Wed"),
// so Kazakh dates are formatted here instead of relying on Intl.
const KK_MONTHS = ["қаңтар", "ақпан", "наурыз", "сәуір", "мамыр", "маусым", "шілде", "тамыз", "қыркүйек", "қазан", "қараша", "желтоқсан"];
const KK_MONTHS_SHORT = ["қаң.", "ақп.", "нау.", "сәу.", "мам.", "мау.", "шіл.", "там.", "қыр.", "қаз.", "қар.", "жел."];
const KK_DAYS = ["жексенбі", "дүйсенбі", "сейсенбі", "сәрсенбі", "бейсенбі", "жұма", "сенбі"];
const KK_DAYS_SHORT = ["Жс", "Дс", "Сс", "Ср", "Бс", "Жм", "Сб"];
/** calendar parts in Almaty time */
const parts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 5 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay() };
};

export const fmtDayLong = (iso: string, l: Lang) => {
  if (l === "kk") { const p = parts(iso); return `${p.day} ${KK_MONTHS[p.m]}, ${KK_DAYS[p.wd]}`; }
  return new Intl.DateTimeFormat(loc(l), { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
};

export const fmtDayShort = (iso: string, l: Lang) => {
  if (l === "kk") { const p = parts(iso); return `${KK_DAYS_SHORT[p.wd]}, ${p.day} ${KK_MONTHS_SHORT[p.m]}`; }
  return new Intl.DateTimeFormat(loc(l), { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
};

export const fmtDateTime = (iso: string, l: Lang) => `${fmtDayShort(iso, l)}, ${fmtTime(iso)}`;

/** YYYY-MM-DD in the gym's time zone */
export const dayKey = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export const fmtDate = (ymd: string, l: Lang) => {
  if (l === "kk") { const [y, m, d] = ymd.split("-").map(Number); return `${y} ж. ${d} ${KK_MONTHS[m - 1]}`; }
  return new Intl.DateTimeFormat(loc(l), { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(ymd + "T00:00:00Z"));
};

/** Admin form date + time (Almaty, UTC+5) -> ISO timestamp */
export const toIso = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`).toISOString();

/** +77015550101 -> +7 701 ***-**-01 (for "we sent a code to …") */
export function maskPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length < 11) return p;
  // non-breaking space and hyphens, so the number never wraps in the middle
  return `+${d.slice(0, d.length - 10)}\u00a0${d.slice(-10, -7)}\u00a0***\u2011**\u2011${d.slice(-2)}`;
}

export const FREE_CANCEL_MS = 3 * 3600_000; // FR-06
/** Check-in (NFC tap) opens this long before the class starts. */
export const CHECKIN_OPENS_MS = 30 * 60_000;

/** Adds calendar months to YYYY-MM-DD, clamping to month-end like PostgreSQL make_interval(months => n). */
export function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** New expiry date: extends active membership from current expiry, or from today if expired/missing. */
export function nextMembershipExpiry(
  currentExpiry: string | null | undefined,
  months: number,
  today = dayKey(new Date().toISOString()),
): string {
  const base = currentExpiry && currentExpiry > today ? currentExpiry : today;
  return addMonthsYmd(base, months);
}

/** Formats an amount in tenge, e.g. 15 000 ₸. */
export const fmtKzt = (amount: number) => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")}\u00a0₸`;
