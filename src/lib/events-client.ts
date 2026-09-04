/**
 * Server-side reader for the event list that feeds the picker.
 *
 * Two queries rather than one, because a single sort cannot express "upcoming
 * soonest-first, then past most-recent-first" — the orderings run in opposite
 * directions.
 */

import { wixEventsV2 } from '@wix/events';
import { auth } from '@wix/essentials';
import type { EventSummary } from './types';

/** Upper bound per group, so a site with thousands of events stays responsive. */
const EVENTS_PER_GROUP = 100;

/** Draft events are grouped with upcoming ones: their schedules are still being built. */
const UPCOMING_STATUSES = ['UPCOMING', 'STARTED', 'DRAFT'] as const;
const PAST_STATUSES = ['ENDED', 'CANCELED'] as const;

const elevatedQuery = auth.elevate(wixEventsV2.queryEvents);

function toSummary(event: wixEventsV2.Event): EventSummary {
  const settings = event.dateAndTimeSettings;
  const start = settings?.startDate;
  return {
    id: event._id ?? '',
    title: event.title ?? '(untitled event)',
    startDate: start ? new Date(start).toISOString() : null,
    timeZoneId: settings?.timeZoneId ?? null,
    status: (event.status as EventSummary['status']) ?? 'UPCOMING',
    formattedDateAndTime:
      settings?.formatted?.dateAndTime ??
      (settings?.dateAndTimeTbd ? settings.dateAndTimeTbdMessage ?? 'Date TBD' : null),
    agendaEnabled: event.agendaSettings?.enabled ?? false,
    recurring: (settings?.recurrenceStatus ?? 'ONE_TIME') !== 'ONE_TIME',
  };
}

/**
 * Lists events for the picker: upcoming ascending, then past descending.
 *
 * `AGENDA` is requested so the picker can tell whether an event even has its
 * schedule feature switched on. `paging.limit` must be set explicitly — the
 * API defaults it to 0, which returns nothing.
 */
export async function listEventsForPicker(): Promise<EventSummary[]> {
  const options = { fields: ['AGENDA' as const], includeDrafts: true };

  const [upcoming, past] = await Promise.all([
    elevatedQuery(options)
      .in('status', [...UPCOMING_STATUSES])
      .ascending('dateAndTimeSettings.startDate')
      .limit(EVENTS_PER_GROUP)
      .find(),
    elevatedQuery(options)
      .in('status', [...PAST_STATUSES])
      .descending('dateAndTimeSettings.startDate')
      .limit(EVENTS_PER_GROUP)
      .find(),
  ]);

  return [...upcoming.items.map(toSummary), ...past.items.map(toSummary)].filter(
    (event) => event.id !== '',
  );
}

/** Fetches one event, for the editor header and CSV filename. */
export async function getEventSummary(eventId: string): Promise<EventSummary | null> {
  const result = await elevatedQuery({ fields: ['AGENDA'], includeDrafts: true })
    .eq('_id', eventId)
    .limit(1)
    .find();
  const event = result.items[0];
  return event ? toSummary(event) : null;
}
