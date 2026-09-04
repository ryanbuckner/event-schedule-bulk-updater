/**
 * Change detection between the loaded server state and the user's edits.
 *
 * Decides which rows need a write at all, and which fields changed on each.
 * The Schedule Items API's `fields` (field mask) parameter rejects every
 * value tried against it — a bare `timeSlot`, a dotted `timeSlot.start`,
 * even a plain top-level `name` — with the same "Invalid field mask" error,
 * so `schedule-client.ts` sends full updates instead and doesn't use a mask
 * built from the changed-fields list here.
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
