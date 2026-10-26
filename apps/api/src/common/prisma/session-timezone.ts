/**
 * Whether the database session's time zone is safe for how timestamps are written.
 *
 * `@prisma/adapter-pg` sends every DateTime as a UTC wall-clock string with NO
 * offset ("2026-10-28 06:00:00") and PostgreSQL reads an offset-less value in
 * the SESSION time zone. On a UTC session that is exact. On any other zone
 * every write is shifted by that zone's offset, and nothing in the application
 * notices: reads are normalised the same way, so the API round-trips its own
 * values while the stored instants — and every SQL comparison with now() — are
 * hours out.
 *
 * Measured on 2026-10-26 against a restored production copy on an Asia/Kolkata
 * session: a follow-up sent as 06:00Z was stored as 00:30Z. Production runs on
 * UTC (its stored 11:00-India follow-ups are exactly 05:30Z), so this is a
 * guard, not a repair.
 *
 * Checked at two dates so a zone that is UTC+0 only in winter (Europe/London)
 * is not mistaken for UTC.
 */
export interface SessionTimezone {
  timezone: string;
  /** EXTRACT(TIMEZONE …) in seconds, for a January and a July instant. */
  winterOffsetSeconds: number;
  summerOffsetSeconds: number;
}

/** A message describing the problem, or null when the session is UTC. */
export function sessionTimezoneProblem(session: SessionTimezone): string | null {
  if (session.winterOffsetSeconds === 0 && session.summerOffsetSeconds === 0) return null;

  return (
    `Database session time zone is "${session.timezone}", not UTC. Timestamps are ` +
    'written without an offset and will be stored shifted by this zone. Set the ' +
    "database's TimeZone to UTC (ALTER DATABASE … SET timezone TO 'UTC')."
  );
}
