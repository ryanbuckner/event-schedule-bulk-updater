/**
 * CSV export and import for a single event's schedule.
 *
 * Written by hand rather than with the patterns `ExportTo` / `ImportButton`
 * features: those require Wix-internal server integrations (the Export Service
 * and a Data Movement job) that write to a Wix Data collection or a
 * platformized destination. This app's destination is the Events Schedule API,
 * and `ImportButton` has no "delete rows absent from the file" semantics,
 * which the sync below needs.
 *
 * `start`/`end` are stored internally as UTC instants, but a raw instant
 * ("2026-09-14T23:05:00.000Z") is unreadable to anyone editing the file by
 * hand. The CSV instead carries four columns — Start Date, Start Time, End
 * Date, End Time — rendered and parsed as wall-clock values in the row's own
 * `timeZoneId` column, the same `toInputStrings`/`fromInputStrings` pair the
 * grid's date/time pickers use. Checked against Wix's own site-wide time
 * zone setting (Site Properties' `timezone` field) before building this: that
 * setting reflects the site's primary business address, not any individual
 * event, and this app already treats each item's own `timeZoneId` (from the
 * event's configured zone) as authoritative — a site-wide fallback isn't
 * needed here and would be the wrong source of truth for a specific event.
 */

import { fromInputStrings, toInputStrings } from './datetime';
import { changedFields } from './diff';
import {
  type EditableField,
  type ImportPlan,
  type RowError,
  type ScheduleRow,
  type ScheduleRowFields,
} from './types';
import { normalizeDuration, validateRow } from './validation';

/**
 * The columns a CSV file actually has. `startDate`/`startTime` together
 * represent the `start` field; `endDate`/`endTime` represent `end` — every
 * other column matches an `EditableField` 1:1.
 */
type CsvColumn =
  | 'id'
  | Exclude<EditableField, 'start' | 'end'>
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime';

/** Column order in the exported file. `id` first so it reads as the key. */
const COLUMNS: readonly CsvColumn[] = [
  'id',
  'name',
  'description',
  'stageName',
  'startDate',
  'startTime',
  'endDate',
  'endTime',
  'timeZoneId',
  'tags',
  'hidden',
  'status',
];

/**
 * CSV header text for every column — matching the grid's own labels
 * ("Item Name", "Hidden", …) where the grid has that column, and a plain
 * Title Case name otherwise, so the file reads the same language as the app.
 */
const COLUMN_LABELS: Record<CsvColumn, string> = {
  id: 'ID',
  name: 'Item Name',
  description: 'Description',
  stageName: 'Place',
  startDate: 'Start Date',
  startTime: 'Start Time',
  endDate: 'End Date',
  endTime: 'End Time',
  timeZoneId: 'Time Zone',
  tags: 'Tags',
  hidden: 'Hidden',
  status: 'Status',
};

function labelFor(column: CsvColumn): string {
  return COLUMN_LABELS[column];
}

/** Resolves a CSV header cell back to its column, accepting either the label or the raw column name. */
function columnForLabel(label: string): CsvColumn | undefined {
  const byLabel = (Object.entries(COLUMN_LABELS) as [CsvColumn, string][]).find(
    ([, value]) => value === label,
  );
  if (byLabel) return byLabel[0];
  return (COLUMNS as readonly string[]).includes(label) ? (label as CsvColumn) : undefined;
}

/** Multi-value cells use semicolons, matching Wix's own CSV convention. */
const TAG_DELIMITER = ';';

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Wall-clock date/time in the row's own zone, or blanks if the instant isn't valid yet (e.g. a still-empty draft). */
function inputPartsOrBlank(iso: string, timeZoneId: string): { date: string; time: string } {
  return toInputStrings(iso, timeZoneId) ?? { date: '', time: '' };
}

function cellFor(row: ScheduleRow, column: CsvColumn): string {
  switch (column) {
    case 'id':
      return row.id;
    case 'tags':
      return (row.tags ?? []).join(TAG_DELIMITER);
    case 'hidden':
      return row.hidden ? 'true' : 'false';
    case 'startDate':
      return inputPartsOrBlank(row.start, row.timeZoneId).date;
    case 'startTime':
      return inputPartsOrBlank(row.start, row.timeZoneId).time;
    case 'endDate':
      return inputPartsOrBlank(row.end, row.timeZoneId).date;
    case 'endTime':
      return inputPartsOrBlank(row.end, row.timeZoneId).time;
    default:
      return String(row[column] ?? '');
  }
}

/** Serializes rows to CSV, including each item's ID. */
export function toCsv(rows: ScheduleRow[]): string {
  const header = COLUMNS.map(labelFor).join(',');
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

/** Which `EditableField` a present CSV column represents, for the update field mask. */
function editableFieldFor(column: CsvColumn): EditableField | null {
  if (column === 'startDate' || column === 'startTime') return 'start';
  if (column === 'endDate' || column === 'endTime') return 'end';
  if (column === 'id') return null;
  return column;
}

/**
 * Diffs an imported CSV against live server state.
 *
 * Sync semantics, not replace:
 *  - a row whose ID matches a live item becomes an update, and only the
 *    fields actually present in the file are named in its field mask, so
 *    fields this app doesn't model are left untouched;
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

  // Each header cell resolves to its column via either name: the label
  // ("Place", "Start Date") or the raw column name ("stageName", "startDate"),
  // so a re-exported file and a hand-edited one both work.
  const rawHeader = grid[0].map((h) => h.trim());
  const header = rawHeader.map((h) => columnForLabel(h));
  const unknown = rawHeader.filter((_, i) => header[i] === undefined);
  if (unknown.length > 0) {
    throw new CsvFormatError(
      `Unrecognized column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Expected any of: ${COLUMNS.map(labelFor).join(', ')}.`,
    );
  }
  if (!header.includes('id')) {
    throw new CsvFormatError(
      'The file needs an "ID" column. Export the schedule first to get a file with IDs.',
    );
  }

  // Which underlying fields the file actually supplies — only these may be
  // written; everything else stays as the server has it. `start`/`end` count
  // as present if either half of their date/time pair is in the file.
  const presentFields = new Set<EditableField>();
  for (const column of header) {
    if (!column) continue;
    const field = editableFieldFor(column);
    if (field) presentFields.add(field);
  }

  const liveById = new Map(live.map((row) => [row.id, row]));
  const plan: ImportPlan = { updates: [], creates: [], deletes: [], errors: [] };
  const seenIds = new Set<string>();

  grid.slice(1).forEach((cells, index) => {
    const lineNumber = index + 2; // 1-based, and the header is line 1
    const value = (column: CsvColumn): string | undefined => {
      const at = header.indexOf(column);
      return at === -1 ? undefined : (cells[at] ?? '').trim();
    };

    const id = value('id') ?? '';
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

    // The zone governs how the date/time columns below are interpreted, so
    // it must be resolved first — from the file if given, else the base row's.
    const zoneCell = value('timeZoneId');
    if (zoneCell !== undefined) next.timeZoneId = zoneCell;

    // Each half of the pair independently falls back to the base row's
    // existing value (re-expressed in the resolved zone) when the file
    // doesn't supply it, so a file can change just the date or just the time.
    const baseStart = inputPartsOrBlank(base.start, next.timeZoneId);
    const startDate = value('startDate') ?? baseStart.date;
    const startTime = value('startTime') ?? baseStart.time;
    next.start = fromInputStrings(startDate, startTime, next.timeZoneId) ?? '';

    const baseEnd = inputPartsOrBlank(base.end, next.timeZoneId);
    const endDate = value('endDate') ?? baseEnd.date;
    const endTime = value('endTime') ?? baseEnd.time;
    next.end = fromInputStrings(endDate, endTime, next.timeZoneId) ?? '';

    for (const column of ['name', 'description', 'stageName', 'tags', 'hidden', 'status'] as const) {
      const raw = value(column);
      if (raw === undefined) continue;
      if (column === 'tags') {
        next.tags = raw
          .split(TAG_DELIMITER)
          .map((t) => t.trim())
          .filter((t) => t !== '');
      } else if (column === 'hidden') {
        next.hidden = parseBoolean(raw);
      } else if (column === 'status') {
        next.status = raw.toUpperCase() === 'CANCELED' ? 'CANCELED' : 'SCHEDULED';
      } else {
        next[column] = raw;
      }
    }

    // Snapped forward to the minimum item duration here, same as the grid and
    // Add Schedule Item, rather than rejecting the whole import over it — the
    // native Wix schedule editor fixes this up for you too.
    const normalized = normalizeDuration(next);

    const rowKey = existing ? existing.id : `line-${lineNumber}`;
    const rowErrors = validateRow(rowKey, normalized).map(
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
      const changed = changedFields(existing, normalized).filter((field) =>
        presentFields.has(field),
      );
      if (changed.length > 0) {
        plan.updates.push({
          row: { ...normalized, id: existing.id, draft: existing.draft },
          fields: changed,
        });
      }
    } else {
      plan.creates.push(normalized);
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

/** Filename for the import template (see `templateCsv`). */
export const IMPORT_TEMPLATE_FILENAME = 'schedule-import-template.csv';

/**
 * One example row for the downloadable import template. ID is blank, since
 * the template's job is to show the columns for adding new items — the most
 * common reason to want a blank starting point.
 */
const TEMPLATE_ROW: ScheduleRow = {
  id: '',
  name: 'Opening Keynote',
  description: 'Welcome remarks and keynote address.',
  stageName: 'Main Stage',
  start: '2026-01-01T14:00:00.000Z', // 9:00 AM in America/New_York
  end: '2026-01-01T15:00:00.000Z', // 10:00 AM in America/New_York
  timeZoneId: 'America/New_York',
  tags: ['keynote', 'featured'],
  hidden: false,
  status: 'SCHEDULED',
  draft: false,
};

/** CSV text for the downloadable import template: headers plus one example row. */
export function templateCsv(): string {
  return toCsv([TEMPLATE_ROW]);
}

/** Triggers a browser download of CSV text under the given filename. */
export function downloadCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
