/**
 * CSV export and import for a single event's schedule.
 *
 * Written by hand rather than with the patterns `ExportTo` / `ImportButton`
 * features: those require Wix-internal server integrations (the Export Service
 * and a Data Movement job) that write to a Wix Data collection or a
 * platformized destination. This app's destination is the Events Schedule API,
 * and `ImportButton` has no "delete rows absent from the file" semantics,
 * which the sync below needs.
 */

import { changedFields } from './diff';
import {
  EDITABLE_FIELDS,
  type EditableField,
  type ImportPlan,
  type RowError,
  type ScheduleRow,
  type ScheduleRowFields,
} from './types';
import { validateRow } from './validation';

/** Column order in the exported file. `id` first so it reads as the key. */
const COLUMNS: readonly (EditableField | 'id')[] = ['id', ...EDITABLE_FIELDS];

/** Multi-value cells use semicolons, matching Wix's own CSV convention. */
const TAG_DELIMITER = ';';

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellFor(row: ScheduleRow, column: EditableField | 'id'): string {
  switch (column) {
    case 'id':
      return row.id;
    case 'tags':
      return (row.tags ?? []).join(TAG_DELIMITER);
    case 'hidden':
      return row.hidden ? 'true' : 'false';
    default:
      return String(row[column] ?? '');
  }
}

/** Serializes rows to CSV, including each item's ID. */
export function toCsv(rows: ScheduleRow[]): string {
  const header = COLUMNS.join(',');
  const body = rows.map((row) =>
    COLUMNS.map((column) => escapeCell(cellFor(row, column))).join(','),
  );
  // Leading BOM so Excel reads UTF-8 names correctly.
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

/**
 * Splits CSV text into rows of cells.
 *
 * Handles quoted cells containing commas, newlines, and escaped quotes.
 */
export function parseCsv(text: string): string[][] {
  const stripped = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];

    if (quoted) {
      if (char === '"') {
        if (stripped[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      // Consume CRLF as a single terminator.
      if (stripped[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function parseBoolean(raw: string): boolean {
  return /^(true|yes|1)$/i.test(raw.trim());
}

export class CsvFormatError extends Error {}

/**
 * Diffs an imported CSV against live server state.
 *
 * Sync semantics, not replace:
 *  - a row whose ID matches a live item becomes an update, and only the
 *    columns present in the file are named in its field mask, so fields this
 *    app doesn't model are left untouched;
 *  - a row with a blank ID becomes a create;
 *  - a live item whose ID appears nowhere in the file is deleted.
 *
 * Nothing is committed if `errors` is non-empty.
 */
export function planImport(text: string, live: ScheduleRow[]): ImportPlan {
  const grid = parseCsv(text);
  if (grid.length === 0) {
    throw new CsvFormatError('The file is empty.');
  }

  const header = grid[0].map((h) => h.trim());
  const unknown = header.filter(
    (h) => !COLUMNS.includes(h as EditableField | 'id'),
  );
  if (unknown.length > 0) {
    throw new CsvFormatError(
      `Unrecognized column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Expected any of: ${COLUMNS.join(', ')}.`,
    );
  }
  if (!header.includes('id')) {
    throw new CsvFormatError(
      'The file needs an "id" column. Export the schedule first to get a file with IDs.',
    );
  }

  // Only these columns may be written; everything else stays as the server has it.
  const presentFields = header.filter(
    (h): h is EditableField => h !== 'id' && COLUMNS.includes(h as EditableField),
  );

  const liveById = new Map(live.map((row) => [row.id, row]));
  const plan: ImportPlan = { updates: [], creates: [], deletes: [], errors: [] };
  const seenIds = new Set<string>();

  grid.slice(1).forEach((cells, index) => {
    const lineNumber = index + 2; // 1-based, and the header is line 1
    const value = (column: string): string => {
      const at = header.indexOf(column);
      return at === -1 ? '' : (cells[at] ?? '').trim();
    };

    const id = value('id');
    const existing = id ? liveById.get(id) : undefined;

    if (id && !existing) {
      plan.errors.push({
        rowId: `line-${lineNumber}`,
        field: null,
        message: `Line ${lineNumber}: no schedule item with ID ${id} exists on this event.`,
      });
      return;
    }
    if (id && seenIds.has(id)) {
      plan.errors.push({
        rowId: `line-${lineNumber}`,
        field: null,
        message: `Line ${lineNumber}: ID ${id} appears more than once in the file.`,
      });
      return;
    }
    if (id) seenIds.add(id);

    // Start from the live row so omitted columns keep their current values;
    // for a create, start from blanks in the event's own zone.
    const base: ScheduleRowFields = existing
      ? { ...existing }
      : {
          name: '',
          description: '',
          stageName: '',
          start: '',
          end: '',
          timeZoneId: '',
          tags: [],
          hidden: false,
          status: 'SCHEDULED',
        };

    const next: ScheduleRowFields = { ...base };
    for (const field of presentFields) {
      const raw = value(field);
      if (field === 'tags') {
        next.tags = raw
          .split(TAG_DELIMITER)
          .map((t) => t.trim())
          .filter((t) => t !== '');
      } else if (field === 'hidden') {
        next.hidden = parseBoolean(raw);
      } else if (field === 'status') {
        next.status = raw.toUpperCase() === 'CANCELED' ? 'CANCELED' : 'SCHEDULED';
      } else {
        next[field] = raw;
      }
    }

    const rowKey = existing ? existing.id : `line-${lineNumber}`;
    const rowErrors = validateRow(rowKey, next).map(
      (error): RowError => ({
        ...error,
        message: `Line ${lineNumber}: ${error.message}`,
      }),
    );
    if (rowErrors.length > 0) {
      plan.errors.push(...rowErrors);
      return;
    }

    if (existing) {
      const changed = changedFields(existing, next).filter((field) =>
        presentFields.includes(field),
      );
      if (changed.length > 0) {
        plan.updates.push({
          row: { ...next, id: existing.id, draft: existing.draft },
          fields: changed,
        });
      }
    } else {
      plan.creates.push(next);
    }
  });

  for (const row of live) {
    if (!seenIds.has(row.id)) {
      plan.deletes.push({ id: row.id, name: row.name });
    }
  }

  return plan;
}

/** Suggested download filename for an event's schedule export. */
export function exportFilename(eventTitle: string): string {
  const slug =
    eventTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'event';
  return `${slug}-schedule.csv`;
}
