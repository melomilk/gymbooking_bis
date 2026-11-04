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

export const FREE_CANCEL_MS = 3 * 3600_000; // FR-06
