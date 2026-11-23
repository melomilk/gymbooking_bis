// Business-rule checks shared by the pages and demo mode (demoApi.ts).
// In Supabase mode the same rules are enforced in SQL (supabase/schema.sql):
// keep both in sync when a rule changes.
import { CHECKIN_OPENS_MS, FREE_CANCEL_MS } from "./format";

const ms = (t: string | number) => (typeof t === "number" ? t : new Date(t).getTime());

/** FR-06: less than 3 h before the start, cancelling forfeits the booking fee. */
export const isLateCancel = (start: string | number, now = Date.now()) => ms(start) - now < FREE_CANCEL_MS;

/** Last moment a booking can be cancelled for free. */
export const freeCancelDeadline = (start: string | number) => new Date(ms(start) - FREE_CANCEL_MS);

/** Check-in (NFC tap) opens 30 min before the class starts. */
export const checkInOpen = (start: string | number, now = Date.now()) => ms(start) - now <= CHECKIN_OPENS_MS;

/** A Trainer account must be linked to a trainer profile. Empty form values count as "not linked". */
export const trainerLinkError = (role: string, trainerId: unknown) =>
  role === "Trainer" && (trainerId === null || trainerId === undefined || trainerId === "") ? "trainer_needs_link" : null;
