/**
 * Backend API for reading and writing an event's schedule.
 *
 * These run as web methods rather than in the browser because they call the
 * Wix Events API with elevated (app) permissions, and because validation that
 * the client could edit away isn't validation.
 *
 * `Permissions.Admin`: this app is a dashboard tool, so only the site's admins
 * may read or change a schedule.
 */

import { Permissions, webMethod } from '@wix/web-methods';
import { resolveEntitlement } from '../../lib/entitlement';
import { getEventSummary, listEventsForPicker } from '../../lib/events-client';
import {
  discardSchedule,
  publishSchedule,
  readSchedule,
  writeSchedule,
  type UpdateSpec,
} from '../../lib/schedule-client';
import {
  EDITABLE_FIELDS,
  type EditableField,
  type EventSummary,
  type SaveOutcome,
  type ScheduleRow,
  type ScheduleRowFields,
} from '../../lib/types';
import { validateRow } from '../../lib/validation';

/** Raised when the instance hasn't purchased the write capability. */
export class PurchaseRequired extends Error {
  constructor() {
    super(
      'Saving schedule changes requires a one-time purchase of this app. Viewing ' +
        'and exporting your schedule stay free.',
    );
    this.name = 'PurchaseRequired';
  }
}

/**
 * Blocks writes on the free tier.
 *
 * The grid disables its own write controls, but that is only feedback — this is
 * the check that actually holds, because anything decided in the browser can be
 * edited away in devtools.
 */
async function requireWriteAccess(): Promise<void> {
  const entitlement = await resolveEntitlement();
  if (entitlement.state !== 'PAID') throw new PurchaseRequired();
}

/** Raised when a request is rejected before anything is written. */
export class ValidationFailure extends Error {
  constructor(readonly problems: string[]) {
    super(
      `${problems.length} row${problems.length === 1 ? '' : 's'} could not be saved: ` +
        problems.join(' '),
    );
    this.name = 'ValidationFailure';
  }
}

export const listEvents = webMethod(
  Permissions.Admin,
  (): Promise<EventSummary[]> => listEventsForPicker(),
);

export const getSchedule = webMethod(
  Permissions.Admin,
  async (
    eventId: string,
  ): Promise<{
    rows: ScheduleRow[];
    draftNotPublished: boolean;
    event: EventSummary | null;
  }> => {
    if (!eventId) throw new Error('An event ID is required.');
    const [snapshot, event] = await Promise.all([
      readSchedule(eventId),
      getEventSummary(eventId),
    ]);
    return { ...snapshot, event };
  },
);

export interface SavePayload {
  updates?: { id: string; fields: EditableField[]; next: ScheduleRowFields }[];
  creates?: ScheduleRowFields[];
  deletes?: { id: string; name: string }[];
}

/**
 * Applies bulk changes to the event's DRAFT schedule.
 *
 * Validation runs here as well as in the grid: the grid validates for immediate
 * feedback, this validates because it's the only check that can't be bypassed.
 * A single bad row rejects the whole request, so the owner never has to work out
 * which half of their edit landed.
 */
export const saveSchedule = webMethod(
  Permissions.Admin,
  async (eventId: string, payload: SavePayload): Promise<SaveOutcome & { noop?: boolean }> => {
    if (!eventId) throw new Error('An event ID is required.');
    await requireWriteAccess();

    const problems: string[] = [];
    const updates: UpdateSpec[] = [];

    for (const update of payload.updates ?? []) {
      if (!update?.id || !update.next) {
        problems.push('An update was missing its item ID or new values.');
        continue;
      }
      const fields = (update.fields ?? []).filter((field): field is EditableField =>
        (EDITABLE_FIELDS as readonly string[]).includes(field),
      );
      if (fields.length === 0) continue;

      const rowErrors = validateRow(update.id, update.next);
      if (rowErrors.length > 0) {
        const label = update.next.name || update.id;
        problems.push(...rowErrors.map((error) => `${label}: ${error.message}`));
        continue;
      }
      updates.push({ id: update.id, fields, next: update.next });
    }

    const creates: ScheduleRowFields[] = [];
    (payload.creates ?? []).forEach((create, index) => {
      const rowErrors = validateRow(`new-${index}`, create);
      if (rowErrors.length > 0) {
        const label = create.name || `New item ${index + 1}`;
        problems.push(...rowErrors.map((error) => `${label}: ${error.message}`));
        return;
      }
      creates.push(create);
    });

    const deletes = (payload.deletes ?? [])
      .filter((entry) => Boolean(entry?.id))
      .map((entry) => ({ id: entry.id, name: entry.name || entry.id }));

    if (problems.length > 0) throw new ValidationFailure(problems);

    if (updates.length === 0 && creates.length === 0 && deletes.length === 0) {
      return { results: [], succeeded: 0, failed: 0, noop: true };
    }

    return writeSchedule(eventId, { updates, creates, deletes });
  },
);

/**
 * Publishes or discards the draft schedule.
 *
 * Separate from saving because the Schedule Items API has no write path to the
 * published schedule — going live is always its own deliberate step.
 */
export const setScheduleVisibility = webMethod(
  Permissions.Admin,
  async (eventId: string, action: 'publish' | 'discard'): Promise<void> => {
    if (!eventId) throw new Error('An event ID is required.');
    await requireWriteAccess();
    if (action === 'publish') await publishSchedule(eventId);
    else if (action === 'discard') await discardSchedule(eventId);
    else throw new Error("The action must be either 'publish' or 'discard'.");
  },
);
