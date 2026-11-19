// Pulse points: levels and badges. Both are computed from data the member
// already has (lifetime points, bookings, reviews), so nothing extra is stored.
import type { BookingRow, PointsSummary } from "./types";

export type LevelId = "newbie" | "regular" | "athlete" | "pro" | "legend";
/** Level by lifetime points (spending points never lowers the level). */
export const LEVELS: { id: LevelId; from: number }[] = [
  { id: "newbie", from: 0 },
  { id: "regular", from: 100 },
  { id: "athlete", from: 300 },
  { id: "pro", from: 600 },
  { id: "legend", from: 1000 },
];

export function levelFor(lifetime: number) {
  let i = 0;
  while (i + 1 < LEVELS.length && lifetime >= LEVELS[i + 1].from) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1] ?? null;
  const progress = next ? Math.min(1, (lifetime - cur.from) / (next.from - cur.from)) : 1;
  return { level: cur, next, progress, toNext: next ? next.from - lifetime : 0 };
}

export type BadgeId = "first_class" | "ten_classes" | "twentyfive" | "streak" | "early_bird" | "all_rounder" | "reliable" | "critic";
export type Badge = { id: BadgeId; icon: string; earned: boolean; progress: string };

const ALMATY_OFFSET_MS = 5 * 3600_000;
const almatyHour = (iso: string) => new Date(new Date(iso).getTime() + ALMATY_OFFSET_MS).getUTCHours();

/** All badges with whether they are earned and a short "3/5" progress text. */
export function badgesFor(bookings: BookingRow[], points: PointsSummary | null, reviewsCount: number): Badge[] {
  const attended = bookings.filter((b) => b.booking_status === "Attended");
  const early = attended.filter((b) => almatyHour(b.start_time) < 9).length;
  const types = new Set(attended.map((b) => b.class_name)).size;
  // last 10 decided visits (came or missed; excused ones are Cancelled and don't count)
  const decided = bookings.filter((b) => b.booking_status === "Attended" || b.booking_status === "No-show")
    .sort((a, b) => b.start_time.localeCompare(a.start_time)).slice(0, 10);
  const reliable = decided.length === 10 && decided.every((b) => b.booking_status === "Attended");
  const streakDone = (points?.streak_bonuses ?? 0) > 0 || (points?.streak ?? 0) >= 4;
  const n = attended.length;
  const of = (have: number, need: number) => `${Math.min(have, need)}/${need}`;
  return [
    { id: "first_class", icon: "🎯", earned: n >= 1, progress: of(n, 1) },
    { id: "ten_classes", icon: "🔟", earned: n >= 10, progress: of(n, 10) },
    { id: "twentyfive", icon: "🏅", earned: n >= 25, progress: of(n, 25) },
    { id: "streak", icon: "🔥", earned: streakDone, progress: of(points?.streak ?? 0, 4) },
    { id: "early_bird", icon: "🌅", earned: early >= 5, progress: of(early, 5) },
    { id: "all_rounder", icon: "🧩", earned: types >= 4, progress: of(types, 4) },
    { id: "reliable", icon: "🛡️", earned: reliable, progress: of(decided.filter((b) => b.booking_status === "Attended").length, 10) },
    { id: "critic", icon: "💬", earned: reviewsCount >= 3, progress: of(reviewsCount, 3) },
  ];
}

/**
 * Weeks in a row (Asia/Almaty, Monday start) with at least one attended class,
 * counted only if the latest such week is this week or last week.
 * Same rule as attendance_streak() in migration_points_rewards.sql (used by demo mode).
 */
export function streakWeeks(attendedStartTimes: string[], now = Date.now()): number {
  const week = (ms: number) => {
    const d = new Date(ms + ALMATY_OFFSET_MS);
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  };
  const W = 7 * 86400_000;
  const thisWeek = week(now);
  const weeks = Array.from(new Set(attendedStartTimes.map((t) => week(new Date(t).getTime()))))
    .filter((w) => w <= thisWeek).sort((a, b) => b - a);
  if (!weeks.length || weeks[0] < thisWeek - W) return 0;
  let n = 1;
  while (n < weeks.length && weeks[n] === weeks[n - 1] - W) n++;
  return n;
}

/** Monday 00:00 (as a UTC timestamp) of the Almaty week containing `iso`. Used for streak bonuses in demo mode. */
export function almatyWeekStart(iso: string): number {
  const d = new Date(new Date(iso).getTime() + ALMATY_OFFSET_MS);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
