// Attendance maths shared by the admin report and the member's profile.
// Cancelled bookings don't count: the member released the place in time.

/** Attendance rate in %, or null when there is nothing to measure yet. */
export function attendanceRate(attended: number, noShow: number): number | null {
  const total = attended + noShow;
  return total === 0 ? null : Math.round((attended * 100) / total);
}

/** "85%" or "—" when there is no data. */
export const fmtRate = (rate: number | null) => (rate === null ? "—" : `${rate}%`);

/** Below this rate a session is highlighted in the admin report. */
export const LOW_ATTENDANCE = 70;
