/**
 * Change detection between the loaded server state and the user's edits.
 *
 * Two jobs: decide which rows need a write at all, and for each of those,
 * which fields to name in the update's field mask. Sending only changed
 * fields is what keeps this app from clobbering schedule-item fields it
 * doesn't model.
 */

import { EDITABLE_FIELDS, type EditableField, type ScheduleRowFields } from './types';

/** True when a field differs between two versions of a row. */
function fieldChanged(
  field: EditableField,
  before: ScheduleRowFields,
  after: ScheduleRowFields,
): boolean {
  if (field === 'tags') {
    const a = before.tags ?? [];
    const b = after.tags ?? [];
    return a.length !== b.length || a.some((tag, i) => tag !== b[i]);
  }
  if (field === 'start' || field === 'end') {
    // Compare instants, not strings: the same moment can be spelled
    // several ways, and a reformat alone is not an edit.
    const a = Date.parse(before[field] ?? '');
    const b = Date.parse(after[field] ?? '');
    if (Number.isNaN(a) && Number.isNaN(b)) return false;
    return a !== b;
  }
  return before[field] !== after[field];
}

/** The editable fields that differ between two versions of a row. */
export function changedFields(
  before: ScheduleRowFields,
  after: ScheduleRowFields,
): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => fieldChanged(field, before, after));
}

/**
 * Builds the field mask for an update call.
 *
 * `timeSlot` is a single nested object on the server, so a change to start,
 * end, or the zone is expressed as one `timeSlot` path rather than three.
 */
export function toFieldMask(fields: EditableField[]): string[] {
  const paths = new Set<string>();
  for (const field of fields) {
    if (field === 'start' || field === 'end' || field === 'timeZoneId') {
      paths.add('timeSlot');
    } else {
      paths.add(field);
    }
  }
  return [...paths];
}

export interface PendingUpdate {
  id: string;
  fields: EditableField[];
  next: ScheduleRowFields;
}

/**
 * Rows that actually changed, with their per-row field lists.
 *
 * Rows the user opened but left alone produce no entry, so they generate no
 * network call.
 */
export function pendingUpdates(
  original: Map<string, ScheduleRowFields>,
  edited: Map<string, ScheduleRowFields>,
): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  for (const [id, next] of edited) {
    const before = original.get(id);
    if (!before) continue; // not an update; a create is handled separately
    const fields = changedFields(before, next);
    if (fields.length > 0) updates.push({ id, fields, next });
  }
  return updates;
}
