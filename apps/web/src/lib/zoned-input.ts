import { formattingContext } from './format';

/**
 * `datetime-local` values in the ORGANIZATION's timezone, not the browser's.
 *
 * THE DEFECT THIS FIXES. Every schedule on screen is DISPLAYED in the
 * organization's timezone (see format.ts), but every schedule TYPED was read
 * with `new Date(value)`, which uses the browser's. The two agreed only when
 * the agent's device happened to be set to the organization's zone. An Android
 * phone left on UTC, or a manager travelling, typed "11:00" for an IST team and
 * saved 16:30 IST — and the lead then showed up in the wrong bucket, on the
 * wrong day, with nothing on screen explaining why.
 *
 * A `datetime-local` value is a wall-clock reading with no zone attached. These
 * helpers attach the organization's zone explicitly, in both directions, so
 * what an agent types is exactly what every queue and every timestamp shows.
 */

const INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** Offset of `timezone` from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));

  // Seconds are dropped from `instant` so a sub-second remainder cannot skew
  // the offset by a millisecond and land the result a minute early.
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * "2026-10-21T11:00", read as wall-clock time in `timezone` → ISO instant.
 *
 * Two passes, because the offset to use depends on the instant being solved
 * for: on a daylight-saving changeover the first guess can sit on the wrong
 * side of the switch. The second pass corrects it.
 */
export function zonedInputToIso(value: string, timezone = formattingContext().timezone): string {
  const match = INPUT_PATTERN.exec(value);
  if (!match) throw new RangeError(`Not a datetime-local value: ${value}`);

  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);

  let instant = wallClock - offsetAt(wallClock, timezone);
  instant = wallClock - offsetAt(instant, timezone);

  return new Date(instant).toISOString();
}

/** An instant → the `datetime-local` value showing it in `timezone`. */
export function toZonedInput(date: Date, timezone = formattingContext().timezone): string {
  const shifted = new Date(date.getTime() + offsetAt(date.getTime(), timezone));
  return shifted.toISOString().slice(0, 16);
}

/**
 * `days` from today, at `hour`:00 in the organization's timezone.
 *
 * The default the scheduling dialogs open with. Computed on the organization's
 * calendar, so "tomorrow 11:00" means tomorrow for the team, not for whatever
 * zone the device is in.
 */
export function zonedDefault(days: number, hour = 11, timezone = formattingContext().timezone): string {
  const today = toZonedInput(new Date(), timezone).slice(0, 10);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1, day + days));

  return `${target.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}

/** Now plus `hours`, as a `datetime-local` value in the organization's timezone. */
export function zonedFromNow(hours: number, timezone = formattingContext().timezone): string {
  return toZonedInput(new Date(Date.now() + hours * 3_600_000), timezone);
}
