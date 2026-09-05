/**
 * Edit state for the bulk grid.
 *
 * The patterns collection hook owns the rows as the server returned them; this
 * hook owns the user's unsaved changes on top of them. Keeping the two separate
 * is what lets the grid stay a normal collection (selection, toolbar, empty and
 * error states all come for free) while still being fully editable, and it
 * makes "which rows actually changed" a straight comparison rather than a guess.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { changedFields } from '../../../lib/diff';
import {
  type EditableField,
  type RowError,
  type ScheduleRow,
  type ScheduleRowFields,
} from '../../../lib/types';
import { groupErrorsByRow, normalizeDuration, validateRow } from '../../../lib/validation';

/** Strips the read-only parts of a row, leaving just the editable fields. */
export function toFields(row: ScheduleRow): ScheduleRowFields {
  return {
    name: row.name,
    description: row.description,
    stageName: row.stageName,
    start: row.start,
    end: row.end,
    timeZoneId: row.timeZoneId,
    tags: row.tags,
    hidden: row.hidden,
    status: row.status,
  };
}

export interface ScheduleEdits {
  /** Current values for a row: the user's edits if any, else the server's. */
  valueOf: (row: ScheduleRow) => ScheduleRowFields;
  setField: <K extends EditableField>(
    row: ScheduleRow,
    field: K,
    value: ScheduleRowFields[K],
  ) => void;
  /** Applies a change to many rows at once, e.g. a bulk time shift. */
  applyToRows: (
    rows: ScheduleRow[],
    change: (current: ScheduleRowFields, row: ScheduleRow) => ScheduleRowFields,
  ) => void;
  /** Rows the user has actually changed, with their changed field lists. */
  pending: { id: string; fields: EditableField[]; next: ScheduleRowFields }[];
  dirtyCount: number;
  isDirty: (rowId: string) => boolean;
  /** Validation problems, keyed by row ID. Only dirty rows are checked. */
  errorsByRow: Map<string, RowError[]>;
  errorCount: number;
  /** Discards all unsaved changes. */
  reset: () => void;
  /** Forgets edits for rows that were saved, keeping any that failed. */
  clearSaved: (savedRowIds: string[]) => void;
}

export function useScheduleEdits(rows: ScheduleRow[]): ScheduleEdits {
  const [edits, setEdits] = useState<Map<string, ScheduleRowFields>>(new Map());

  // Baselines are captured per row ID the first time a row is seen, so a
  // background refetch of unrelated rows can't silently redefine what "changed"
  // means for a row the user is editing.
  const baselines = useRef<Map<string, ScheduleRowFields>>(new Map());
  for (const row of rows) {
    if (!baselines.current.has(row.id)) {
      baselines.current.set(row.id, toFields(row));
    }
  }

  const valueOf = useCallback(
    (row: ScheduleRow): ScheduleRowFields => edits.get(row.id) ?? toFields(row),
    [edits],
  );

  const setField = useCallback(
    <K extends EditableField>(
      row: ScheduleRow,
      field: K,
      value: ScheduleRowFields[K],
    ) => {
      setEdits((previous) => {
        const next = new Map(previous);
        const current = previous.get(row.id) ?? toFields(row);
        const updated = { ...current, [field]: value };
        // Snaps `end` forward to the minimum item duration instead of letting
        // a too-short gap sit there until save rejects it — mirrors the
        // native Wix schedule editor's own behavior. A no-op unless this
        // edit was to `start` or `end` and actually shortened things.
        next.set(row.id, normalizeDuration(updated));
        return next;
      });
    },
    [],
  );

  const applyToRows = useCallback(
    (
      targets: ScheduleRow[],
      change: (current: ScheduleRowFields, row: ScheduleRow) => ScheduleRowFields,
    ) => {
      setEdits((previous) => {
        const next = new Map(previous);
        for (const row of targets) {
          const current = previous.get(row.id) ?? toFields(row);
          // Each row is computed from its own current values only — no cascade
          // between rows, whatever their chronological order.
          next.set(row.id, normalizeDuration(change(current, row)));
        }
        return next;
      });
    },
    [],
  );

  const pending = useMemo(() => {
    const result: { id: string; fields: EditableField[]; next: ScheduleRowFields }[] = [];
    for (const row of rows) {
      const edited = edits.get(row.id);
      if (!edited) continue;
      const baseline = baselines.current.get(row.id) ?? toFields(row);
      const fields = changedFields(baseline, edited);
      if (fields.length > 0) result.push({ id: row.id, fields, next: edited });
    }
    return result;
  }, [rows, edits]);

  const dirtyIds = useMemo(() => new Set(pending.map((p) => p.id)), [pending]);

  // Only changed rows are validated: pre-existing server data that happens to
  // break a rule this app enforces shouldn't block an unrelated edit.
  const errorsByRow = useMemo(
    () => groupErrorsByRow(pending.flatMap((p) => validateRow(p.id, p.next))),
    [pending],
  );

  const errorCount = useMemo(
    () => [...errorsByRow.values()].reduce((sum, list) => sum + list.length, 0),
    [errorsByRow],
  );

  const reset = useCallback(() => setEdits(new Map()), []);

  const clearSaved = useCallback((savedRowIds: string[]) => {
    const saved = new Set(savedRowIds);
    setEdits((previous) => {
      const next = new Map(previous);
      for (const id of saved) {
        next.delete(id);
        baselines.current.delete(id); // re-baseline from the refetched row
      }
      return next;
    });
  }, []);

  return {
    valueOf,
    setField,
    applyToRows,
    pending,
    dirtyCount: pending.length,
    isDirty: (rowId: string) => dirtyIds.has(rowId),
    errorsByRow,
    errorCount,
    reset,
    clearSaved,
  };
}
