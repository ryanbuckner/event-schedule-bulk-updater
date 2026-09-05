/**
 * Row validation, shared by the grid, the bulk time shift, and CSV import.
 *
 * One implementation so all three paths reject the same things. Everything here
 * is client-side and advisory: the server is the final authority, and any
 * server rejection is surfaced verbatim rather than being second-guessed.
 */

import { durationMinutes, shiftMinutes } from './datetime';
import {
  LIMITS,
  MIN_ITEM_DURATION_MINUTES,
  type RowError,
  type ScheduleRowFields,
} from './types';

/**
 * Snaps `end` forward to satisfy the minimum item duration, the way the
 * native Wix schedule editor fixes this up for you rather than rejecting the
 * save — used everywhere start/end get set (the grid, Add Schedule Item, CSV
 * import, and the backend's own write path) so `validateRow`'s duration
 * check below is a safety net, not something a normal edit should ever hit.
 * Leaves fields alone when `start`/`end` aren't parseable dates; that's
 * `validateRow`'s job to catch.
 */
export function normalizeDuration(fields: ScheduleRowFields): ScheduleRowFields {
  const duration = durationMinutes(fields.start, fields.end);
  if (duration === null || duration >= MIN_ITEM_DURATION_MINUTES) return fields;
  const end = shiftMinutes(fields.start, MIN_ITEM_DURATION_MINUTES);
  return end ? { ...fields, end } : fields;
}

/** Validates one row's fields. Returns every problem found, not just the first. */
export function validateRow(
  rowId: string,
  fields: ScheduleRowFields,
): RowError[] {
  const errors: RowError[] = [];
  const fail = (field: RowError['field'], message: string) =>
    errors.push({ rowId, field, message });

  const name = fields.name?.trim() ?? '';
  if (!name) {
    fail('name', 'Name is required.');
  } else if (fields.name.length > LIMITS.NAME_MAX) {
    fail('name', `Name must be ${LIMITS.NAME_MAX} characters or fewer.`);
  }

  if ((fields.description?.length ?? 0) > LIMITS.DESCRIPTION_MAX) {
    fail(
      'description',
      `Description must be ${LIMITS.DESCRIPTION_MAX} characters or fewer.`,
    );
  }

  if ((fields.stageName?.length ?? 0) > LIMITS.STAGE_NAME_MAX) {
    fail(
      'stageName',
      `Location must be ${LIMITS.STAGE_NAME_MAX} characters or fewer.`,
    );
  }

  const tags = fields.tags ?? [];
  if (tags.length > LIMITS.TAGS_MAX) {
    fail('tags', `Use at most ${LIMITS.TAGS_MAX} tags.`);
  }
  const overlongTag = tags.find((t) => t.length > LIMITS.TAG_LENGTH_MAX);
  if (overlongTag !== undefined) {
    fail(
      'tags',
      `Tag "${overlongTag}" is longer than ${LIMITS.TAG_LENGTH_MAX} characters.`,
    );
  }
  if (tags.some((t) => t.trim() === '')) {
    fail('tags', 'Tags cannot be blank.');
  }

  const startValid = !Number.isNaN(Date.parse(fields.start ?? ''));
  const endValid = !Number.isNaN(Date.parse(fields.end ?? ''));
  if (!startValid) fail('start', 'Start date and time is not a valid date.');
  if (!endValid) fail('end', 'End date and time is not a valid date.');

  if (startValid && endValid) {
    const duration = durationMinutes(fields.start, fields.end);
    if (duration === null || duration <= 0) {
      fail('end', 'End time must be after start time.');
    } else if (duration < MIN_ITEM_DURATION_MINUTES) {
      fail(
        'end',
        `Items must last at least ${MIN_ITEM_DURATION_MINUTES} minutes (this one is ${duration}).`,
      );
    }
  }

  if (!fields.timeZoneId?.trim()) {
    fail('timeZoneId', 'Time zone is required.');
  }

  if (fields.status !== 'SCHEDULED' && fields.status !== 'CANCELED') {
    fail('status', 'Status must be either SCHEDULED or CANCELED.');
  }

  return errors;
}

/** Validates many rows, returning a flat list of every problem. */
export function validateRows(
  rows: { id: string; fields: ScheduleRowFields }[],
): RowError[] {
  return rows.flatMap(({ id, fields }) => validateRow(id, fields));
}

/** Groups errors by row ID, for per-row display in the grid. */
export function groupErrorsByRow(errors: RowError[]): Map<string, RowError[]> {
  const grouped = new Map<string, RowError[]>();
  for (const error of errors) {
    const existing = grouped.get(error.rowId);
    if (existing) existing.push(error);
    else grouped.set(error.rowId, [error]);
  }
  return grouped;
}
