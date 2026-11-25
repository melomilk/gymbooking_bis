// "Right now in the club": load level from the number of people present.
// The SQL function club_load() in migration_club_presence.sql uses the same numbers.
import type { ClubLoad } from "./types";

/** Share of the branch's club_capacity from which the load is medium / high. */
export const LOAD_MEDIUM_FROM = 0.4;
export const LOAD_HIGH_FROM = 0.75;
export const LOAD_SEGMENTS = 10;

export function clubLoad(present: number, capacity: number): ClubLoad {
  const share = present / Math.max(capacity, 1);
  if (share >= LOAD_HIGH_FROM) return "high";
  if (share >= LOAD_MEDIUM_FROM) return "medium";
  return "low";
}

/** How many of the 10 bar segments are lit (at least 1 when someone is there). */
export function loadSegments(present: number, capacity: number): number {
  if (present <= 0) return 0;
  return Math.min(LOAD_SEGMENTS, Math.max(1, Math.round((present / Math.max(capacity, 1)) * LOAD_SEGMENTS)));
}

/** "Aruzhan Bekova" -> "AB" */
export const initialsOf = (name: string, surname: string) =>
  (name.trim().slice(0, 1) + surname.trim().slice(0, 1)).toLocaleUpperCase();

/** Shown to other members: first name + surname initial (same as the leaderboard). */
export const shortName = (name: string, surname: string) => `${name.trim()} ${surname.trim().slice(0, 1)}.`;
