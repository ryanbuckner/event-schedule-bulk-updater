/**
 * Time zone conversion between an instant and wall-clock time in an IANA zone.
 *
 * Schedule items carry an explicit `timeSlot.timeZoneId`, and organizers think
 * in the event's local time — so the grid shows and accepts wall time in that
 * zone, not the browser's. Implemented with `Intl` rather than a date library
 * to avoid a dependency for ~60 lines of arithmetic.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const MINUTE_MS = 60_000;

/**
 * Formats an instant as wall-clock parts in the given zone.
 *
 * `'en-US'` here is deliberate, not a stray hardcoded locale to fix: this
 * reads back *numeric digits* (`Number(found.value)`), not display text, and
 * this file is imported by backend code too (`validation.ts` → here, reached
 * from `schedule.web.ts`) where the dashboard's `i18n` SDK module isn't
 * available anyway. A locale using non-Latin digits would break the
 * `Number()` parse below, so this stays fixed regardless. User-facing date
 * and time *display* is what follows the dashboard user's locale — see
 * `formatInZone` below and `cells.tsx`'s `i18n.getLocale()` usage.
 */
export function toWallTime(iso: string, timeZoneId: string): WallTime | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZoneId,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));

  const get = (type: string) => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : NaN;
  };

  const wall = {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };

  return Object.values(wall).some(Number.isNaN) ? null : wall;
}

/** Treats wall-clock parts as if they were UTC, giving a comparable scalar. */
function asPseudoUtc(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/**
 * Converts wall-clock time in a zone to a UTC instant.
 *
 * Two passes: the first estimates the zone's offset at roughly the right
 * instant, the second corrects it. The second pass matters across DST
 * boundaries, where the offset at the guessed instant differs from the offset
 * at the true instant.
 */
export function fromWallTime(wall: WallTime, timeZoneId: string): string | null {
  const target = asPseudoUtc(wall);
  let instant = target;

  for (let pass = 0; pass < 2; pass++) {
    const observed = toWallTime(new Date(instant).toISOString(), timeZoneId);
    if (!observed) return null;
    const drift = asPseudoUtc(observed) - instant;
    const next = target - drift;
    if (next === instant) break;
    instant = next;
  }

  return new Date(instant).toISOString();
}

/** Shifts an instant by a signed number of minutes. */
export function shiftMinutes(iso: string, minutes: number): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + minutes * MINUTE_MS).toISOString();
}

/** Duration between two instants, in whole minutes. Negative if end precedes start. */
export function durationMinutes(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.floor((end - start) / MINUTE_MS);
}

/** `YYYY-MM-DD` and `HH:MM` strings for date/time inputs, in the item's zone. */
export function toInputStrings(
  iso: string,
  timeZoneId: string,
): { date: string; time: string } | null {
  const w = toWallTime(iso, timeZoneId);
  if (!w) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
}

/** Inverse of toInputStrings. Returns null when either part is malformed. */
export function fromInputStrings(
  date: string,
  time: string,
  timeZoneId: string,
): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;

  return fromWallTime(
    {
      year: Number(dateMatch[1]),
      month: Number(dateMatch[2]),
      day: Number(dateMatch[3]),
      hour: Number(timeMatch[1]),
      minute: Number(timeMatch[2]),
    },
    timeZoneId,
  );
}

/**
 * Human-readable wall time in the item's zone, for read-only display.
 *
 * `locale` is left to the caller rather than read here via `i18n.getLocale()`
 * (the dashboard user's Language & Region preference): this file is shared
 * with backend code (`validation.ts` → here, reached from `schedule.web.ts`),
 * where that frontend-only SDK module isn't available. Frontend callers pass
 * `i18n.getLocale()` explicitly; omitting it falls back to the runtime's own
 * default, same as before this was made overridable.
 */
export function formatInZone(iso: string, timeZoneId: string, locale?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timeZoneId,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}
