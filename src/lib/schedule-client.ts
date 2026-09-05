/**
 * Server-side wrappers around the Wix Events Schedule Items API.
 *
 * Two things this file exists to hide from the UI:
 *  - `listScheduleItems` returns at most 100 items per call, so a full read is
 *    a paging loop, not a single request;
 *  - every write lands in the DRAFT schedule. There is no write path to the
 *    published schedule. Publishing is a separate, explicit call.
 */

import { schedule } from '@wix/events';
import { auth } from '@wix/essentials';
import {
  DELETE_BATCH_SIZE,
  LIST_PAGE_SIZE,
  type EditableField,
  type RowResult,
  type SaveOutcome,
  type ScheduleRow,
  type ScheduleRowFields,
  type ScheduleSnapshot,
} from './types';

/**
 * The states that show every item exactly once, at its current draft value.
 *
 * `state` has two independent axes — revision (DRAFT/PUBLISHED) and
 * visibility (VISIBLE/HIDDEN) — confirmed on ListScheduleItems' own docs:
 * omitting one axis makes the API assume a default for it, e.g. `["HIDDEN"]`
 * becomes `["HIDDEN", "PUBLISHED"]`. Naming values from *both* axes, as this
 * app once did with `["DRAFT", "PUBLISHED", "VISIBLE", "HIDDEN"]`, asks for
 * the cross product: an item with unpublished changes comes back twice, once
 * per revision, with different field values but the same ID — which is what
 * caused both the duplicate-row bug and, worse, a save that looked reverted
 * (a later fetch's arbitrary tie-break sometimes kept the stale published
 * copy over the fresh draft one). Every item has a draft revision whether or
 * not it's been edited — "each event has one published schedule and one
 * draft schedule" — so naming only `DRAFT` for the revision axis, plus both
 * visibility values, returns each item exactly once, always at its current
 * (possibly-edited) draft value — which is what a draft-schedule editor
 * should show and write to.
 */
const ALL_STATES = ['DRAFT', 'VISIBLE', 'HIDDEN'] as const;

/**
 * How many writes to have in flight at once. Lowered from 5 after a
 * real-world burst of 26 concurrent creates (one large Add Schedule Item
 * batch) produced 21 generic "System error occurred" failures — a smaller
 * burst is less likely to trip whatever's overloaded on the API side in the
 * first place, on top of the broadened retry classification above.
 */
const WRITE_CONCURRENCY = 3;

/**
 * Retries per write, for transient failures only.
 *
 * A 100-item shift means up to 100 update calls in a burst, which is exactly
 * the shape of request that gets rate limited. Backing off and retrying turns a
 * throttled row into a saved row instead of a failure the owner has to chase.
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

const elevated = {
  list: auth.elevate(schedule.listScheduleItems),
  add: auth.elevate(schedule.addScheduleItem),
  update: auth.elevate(schedule.updateScheduleItem),
  remove: auth.elevate(schedule.deleteScheduleItem),
  publish: auth.elevate(schedule.publishDraft),
  discard: auth.elevate(schedule.discardDraft),
};

function toIso(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toRow(item: schedule.ScheduleItem): ScheduleRow {
  return {
    id: item._id ?? '',
    name: item.name ?? '',
    description: item.description ?? '',
    stageName: item.stageName ?? '',
    start: toIso(item.timeSlot?.start),
    end: toIso(item.timeSlot?.end),
    timeZoneId: item.timeSlot?.timeZoneId ?? 'Etc/UTC',
    tags: item.tags ?? [],
    hidden: item.hidden ?? false,
    status: item.status === 'CANCELED' ? 'CANCELED' : 'SCHEDULED',
    draft: item.draft ?? false,
  };
}

/** Maps this app's row shape onto the SDK's ScheduleItemData. */
function toItemData(fields: ScheduleRowFields): schedule.ScheduleItemData {
  return {
    name: fields.name,
    description: fields.description,
    stageName: fields.stageName,
    tags: fields.tags,
    hidden: fields.hidden,
    status: fields.status,
    timeSlot: {
      start: new Date(fields.start),
      end: new Date(fields.end),
      timeZoneId: fields.timeZoneId,
    },
  };
}

/**
 * Reads every schedule item for an event, following offset paging.
 *
 * A 100-item event sits exactly at the single-call ceiling, so the loop is
 * required rather than defensive.
 *
 * Deduping by ID is now a safety net rather than the fix: `ALL_STATES` is
 * chosen (see its own comment) so each item is returned exactly once, but
 * keeping the dedup means a future change to that list fails toward "some
 * rows silently coalesce" instead of "the grid (and edits, which are keyed by
 * ID) doubles up every row again."
 */
export async function readSchedule(eventId: string): Promise<ScheduleSnapshot> {
  const byId = new Map<string, ScheduleRow>();
  let offset = 0;
  let draftNotPublished = false;
  let fetched = 0;

  for (;;) {
    const response = await withRetry(() =>
      elevated.list({
        eventId: [eventId],
        state: [...ALL_STATES],
        paging: { limit: LIST_PAGE_SIZE, offset },
      }),
    );

    const items = response.items ?? [];
    for (const item of items.map(toRow)) byId.set(item.id, item);
    fetched += items.length;
    draftNotPublished = draftNotPublished || response.draftNotPublished === true;

    const total = response.pagingMetadata?.total ?? response.total ?? fetched;
    offset += items.length;
    if (items.length === 0 || fetched >= total) break;
  }

  const rows = [...byId.values()];
  rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { rows, draftNotPublished };
}

/** Runs tasks with a bounded number in flight, preserving input order. */
async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });

  await Promise.all(workers);
  return results;
}

/** True for failures worth retrying: rate limits, timeouts, and 5xx. */
function isTransient(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    httpStatus?: number;
    status?: number;
    response?: { status?: number };
    code?: string | number;
    message?: string;
  };
  const status =
    candidate.httpStatus ?? candidate.status ?? candidate.response?.status ?? undefined;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  const code = String(candidate.code ?? '');
  if (/RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ETIMEDOUT|ECONNRESET/i.test(code)) {
    return true;
  }
  // "System error occurred" is the Events API's own generic internal-error
  // message (confirmed against a real failure: a burst of 21 concurrent
  // creates in one Add Schedule Item batch, all failing with this exact
  // text and no numeric status this function could otherwise catch) — a
  // transient overload under load, not a validation failure, so it belongs
  // here alongside the rate-limit/timeout wording.
  return /rate limit|too many requests|timed? ?out|temporarily unavailable|system error/i.test(
    candidate.message ?? '',
  );
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one write, retrying transient failures with a short backoff.
 *
 * Permanent failures (validation, permissions, not-found) are returned on the
 * first attempt — retrying those would just slow the batch down and would still
 * fail.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === MAX_ATTEMPTS - 1) throw error;
      await delay(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
  }
  throw lastError;
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: string;
      details?: { applicationError?: { description?: string } };
    };
    return (
      candidate.details?.applicationError?.description ??
      candidate.message ??
      'Unknown error.'
    );
  }
  return typeof error === 'string' ? error : 'Unknown error.';
}

export interface UpdateSpec {
  id: string;
  fields: EditableField[];
  next: ScheduleRowFields;
}

export interface WriteSpec {
  updates?: UpdateSpec[];
  creates?: ScheduleRowFields[];
  deletes?: { id: string; name: string }[];
}

/**
 * Applies updates, creates, and deletes for one event.
 *
 * Every write is attempted; a failure never aborts the rest. The caller gets a
 * per-row verdict so partial failure can be reported honestly instead of being
 * rounded up to success or discarded.
 */
export async function writeSchedule(
  eventId: string,
  spec: WriteSpec,
): Promise<SaveOutcome> {
  const results: RowResult[] = [];

  const updateTasks = (spec.updates ?? []).map(
    (update) => async (): Promise<RowResult> => {
      try {
        // No field mask: the API rejects every value tried here (a bare
        // `timeSlot`, dotted `timeSlot.start`, even a plain top-level `name`)
        // with the same "Invalid field mask" error, so partial updates via
        // `fields` appear broken on this endpoint regardless of path syntax.
        // An empty/omitted mask is documented as "interpreted as full
        // update," which works. `update.next` already carries this row's
        // complete current field set (baseline merged with edits), so a full
        // replace is safe under normal use — the one trade-off is that a
        // change made by someone else between this row's load and this save
        // could be overwritten, which the field mask would have prevented.
        await withRetry(() => elevated.update(update.id, eventId, { item: toItemData(update.next) }));
        return { rowId: update.id, name: update.next.name, ok: true, operation: 'update' };
      } catch (error) {
        return {
          rowId: update.id,
          name: update.next.name,
          ok: false,
          error: describeError(error),
          operation: 'update',
        };
      }
    },
  );

  const createTasks = (spec.creates ?? []).map(
    (create, index) => async (): Promise<RowResult> => {
      try {
        const response = await withRetry(() =>
          elevated.add(eventId, { item: toItemData(create) }),
        );
        return {
          rowId: response.item?._id ?? `new-${index}`,
          name: create.name,
          ok: true,
          operation: 'create',
        };
      } catch (error) {
        return {
          rowId: `new-${index}`,
          name: create.name,
          ok: false,
          error: describeError(error),
          operation: 'create',
        };
      }
    },
  );

  results.push(...(await withConcurrency([...updateTasks, ...createTasks], WRITE_CONCURRENCY)));

  // Deletes are the one batched operation: up to 100 IDs per call.
  const deletes = spec.deletes ?? [];
  for (let i = 0; i < deletes.length; i += DELETE_BATCH_SIZE) {
    const batch = deletes.slice(i, i + DELETE_BATCH_SIZE);
    try {
      await withRetry(() => elevated.remove(eventId, { itemIds: batch.map((d) => d.id) }));
      results.push(
        ...batch.map(
          (d): RowResult => ({ rowId: d.id, name: d.name, ok: true, operation: 'delete' }),
        ),
      );
    } catch (error) {
      // A batch call fails as a unit, so every ID in it is reported failed.
      const message = describeError(error);
      results.push(
        ...batch.map(
          (d): RowResult => ({
            rowId: d.id,
            name: d.name,
            ok: false,
            error: message,
            operation: 'delete',
          }),
        ),
      );
    }
  }

  return {
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

/** Publishes the event's draft schedule, making staged edits live. */
export async function publishSchedule(eventId: string): Promise<void> {
  await elevated.publish(eventId);
}

/** Throws away the event's draft schedule, reverting to what is published. */
export async function discardSchedule(eventId: string): Promise<void> {
  await elevated.discard(eventId);
}
