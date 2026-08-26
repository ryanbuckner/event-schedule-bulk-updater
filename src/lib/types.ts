/**
 * Shared types for the schedule bulk editor.
 *
 * Field names and constraints mirror the Wix Events `ScheduleItem` schema:
 * https://dev.wix.com/docs/api-reference/business-solutions/events/event-management/schedule-items/schedule-item-object
 */

/** Server-side limits, taken from the ScheduleItem schema. */
export const LIMITS = {
  NAME_MAX: 120,
  DESCRIPTION_MAX: 10000,
  STAGE_NAME_MAX: 30,
  TAGS_MAX: 5,
  TAG_LENGTH_MAX: 30,
} as const;

/**
 * Minimum duration enforced by this app.
 *
 * NOTE: this is NOT a documented server constraint — the ScheduleItem schema
 * declares no minimum duration and no end-after-start rule. It mirrors the
 * native Wix dashboard's convention. The server remains the final authority,
 * so a rejection here is advisory and a rejection there is surfaced verbatim.
 */
export const MIN_ITEM_DURATION_MINUTES = 10;

/** Max schedule items returned by a single listScheduleItems call. */
export const LIST_PAGE_SIZE = 100;

/** Max item IDs accepted by a single deleteScheduleItem call. */
export const DELETE_BATCH_SIZE = 100;

/** The editable fields of a schedule item, as this app models them. */
export interface ScheduleRowFields {
  name: string;
  description: string;
  stageName: string;
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant, exclusive. */
  end: string;
  /** IANA time zone ID, e.g. "America/New_York". */
  timeZoneId: string;
  tags: string[];
  hidden: boolean;
  status: 'SCHEDULED' | 'CANCELED';
}

/** A schedule item as displayed in the grid: editable fields plus read-only context. */
export interface ScheduleRow extends ScheduleRowFields {
  id: string;
  /** Read-only: whether this item currently exists only in the draft schedule. */
  draft: boolean;
}

/** Keys of ScheduleRowFields, used for field masks and CSV columns. */
export type EditableField = keyof ScheduleRowFields;

export const EDITABLE_FIELDS: readonly EditableField[] = [
  'name',
  'description',
  'stageName',
  'start',
  'end',
  'timeZoneId',
  'tags',
  'hidden',
  'status',
] as const;

/** A validation failure on one row. */
export interface RowError {
  rowId: string;
  field: EditableField | null;
  message: string;
}

/** Outcome of writing one row to the server. */
export interface RowResult {
  rowId: string;
  /** Item name at the time of the attempt, for reporting. */
  name: string;
  ok: boolean;
  /** Present when ok is false. Verbatim server message where available. */
  error?: string;
  /** What was attempted, for the results summary. */
  operation: 'update' | 'create' | 'delete';
}

/** Aggregate outcome of a bulk write. */
export interface SaveOutcome {
  results: RowResult[];
  succeeded: number;
  failed: number;
}

/** Live schedule state for one event. */
export interface ScheduleSnapshot {
  rows: ScheduleRow[];
  /** From listScheduleItems: whether unpublished draft changes exist. */
  draftNotPublished: boolean;
}

/** An event, as needed by the picker. */
export interface EventSummary {
  id: string;
  title: string;
  /** ISO 8601, or null when the event's date is marked TBD. */
  startDate: string | null;
  timeZoneId: string | null;
  status: 'UPCOMING' | 'STARTED' | 'ENDED' | 'CANCELED' | 'DRAFT';
  /** Preformatted date string from the API, used for display. */
  formattedDateAndTime: string | null;
  /** Whether the event has its schedule feature enabled. */
  agendaEnabled: boolean;
}

/**
 * Result of the purchase check.
 *
 * Freemium is by capability, not by time: `FREE` can read and export, `PAID`
 * can also write. There is no trial state because a one-time plan gives no
 * reachable per-instance install date to anchor a trial clock to.
 */
export type EntitlementState = 'FREE' | 'PAID';

export interface Entitlement {
  state: EntitlementState;
  /**
   * True when the check could not be completed and the app fell back to the
   * free tier. Surfaced so a failure is never silent, and so a paying owner
   * isn't told to buy something they already own.
   */
  degraded: boolean;
}

/** Whether this entitlement permits changing a schedule. */
export function canWrite(entitlement: Entitlement): boolean {
  return entitlement.state === 'PAID';
}

/** The plan produced by diffing an imported CSV against live server state. */
export interface ImportPlan {
  updates: { row: ScheduleRow; fields: EditableField[] }[];
  creates: ScheduleRowFields[];
  deletes: { id: string; name: string }[];
  errors: RowError[];
}
