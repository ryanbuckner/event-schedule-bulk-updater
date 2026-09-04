/**
 * Event selection. Nothing else loads until one event is chosen.
 *
 * Built as a patterns collection rather than a plain list so search comes for
 * free — a site with a few hundred events makes scrolling useless.
 *
 * Ordering is decided by the backend (upcoming soonest-first, then past
 * most-recent-first) and preserved here, so the event the owner most likely
 * wants is at the top.
 *
 * Status and Event type are filtered client-side against the already-fetched
 * list, not passed to the backend query: the Events V2 SDK's query builder is
 * type-constrained to a fixed set of filterable fields (`_id`, `title`,
 * `status`, `dateAndTimeSettings.startDate`/`endDate`, `slug`, `_createdDate`,
 * `_updatedDate`, `registration.initialType`, `userId`) that doesn't include
 * `dateAndTimeSettings.recurrenceStatus` — so "Recurring/Single" can only be
 * filtered here, after the fact, on data already in memory. Event category
 * isn't offered as a filter at all: the SDK has no category field on Event
 * and no bulk "events in category X" lookup, only a per-event
 * `listEventCategories(eventId)` call — filtering by category would mean one
 * extra API call per event on the page.
 *
 * Wrapped in `observer()`: `@wix/patterns`' collection state is MobX
 * observable under the hood, and `Table` reads it reactively internally —
 * but this component also reads `collection.keyedItems.length` directly (for
 * the "Events (N)" title), and a plain function component doesn't subscribe
 * to MobX observables just by reading them. Without `observer()`, that read
 * freezes at whatever it was on the very first render (0, before the fetch
 * resolves) and never updates, even though the table itself renders live data
 * correctly. This is Wix's own documented fix for reading collection state
 * outside of a library-owned render.
 */

import { Badge, Box, Button, Text } from '@wix/design-system';
import { i18n } from '@wix/essentials';
import {
  CollectionEmptyState,
  CollectionToolbarFilters,
  RadioGroupFilter,
  Table,
  ToolbarTitle,
  idNameArrayFilter,
  useTableCollection,
  type Filter,
  type TableColumn,
} from '@wix/patterns';
import { CollectionPage } from '@wix/patterns/page';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { listEvents } from '../../../backend/api/schedule.web';
import { formatInZone } from '../../../lib/datetime';
import type { EventSummary } from '../../../lib/types';

interface FilterOption {
  id: string;
  name: string;
}

// No explicit "All" entry: `RadioGroupFilter` already renders its own
// built-in option for "nothing selected," and a manual one here just
// duplicated it. Unselected already means unfiltered below.
const STATUS_OPTIONS: FilterOption[] = [
  { id: 'UPCOMING', name: 'Upcoming' },
  { id: 'PAST', name: 'Past' },
  { id: 'CANCELED', name: 'Canceled' },
];

const TYPE_OPTIONS: FilterOption[] = [
  { id: 'RECURRING', name: 'Recurring' },
  { id: 'SINGLE', name: 'Single' },
];

/** Which Status filter bucket an event's raw status falls into. */
function statusBucket(status: EventSummary['status']): 'UPCOMING' | 'PAST' | 'CANCELED' {
  if (status === 'CANCELED') return 'CANCELED';
  if (status === 'ENDED') return 'PAST';
  return 'UPCOMING'; // UPCOMING, STARTED, DRAFT
}

type EventPickerFilters = {
  status: Filter<FilterOption[]>;
  type: Filter<FilterOption[]>;
};

function statusBadge(status: EventSummary['status']) {
  switch (status) {
    case 'DRAFT':
      return <Badge skin="neutralLight" size="tiny">Draft</Badge>;
    case 'STARTED':
      return <Badge skin="success" size="tiny">Happening now</Badge>;
    case 'CANCELED':
      return <Badge skin="danger" size="tiny">Canceled</Badge>;
    case 'ENDED':
      return <Badge skin="neutralStandard" size="tiny">Ended</Badge>;
    default:
      return <Badge skin="standard" size="tiny">Upcoming</Badge>;
  }
}

export const EventPicker = observer(function EventPicker({
  onSelect,
}: {
  onSelect: (event: EventSummary) => void;
}) {
  const state = useTableCollection<EventSummary, EventPickerFilters>({
    queryName: 'schedule-events',
    paginationMode: 'offset',
    itemKey: (item) => item.id,
    itemName: (item) => item.title,
    filters: {
      // Defaulted to Upcoming on load (`initialValue`), but "Clear all" empties
      // it rather than resetting back to Upcoming — no `defaultValue` is set,
      // so clearing lands on unfiltered, matching what "Clear all" means
      // everywhere else in Wix.
      status: idNameArrayFilter({ initialValue: [STATUS_OPTIONS[0]] }),
      type: idNameArrayFilter(),
    },
    fetchData: async (query) => {
      const events = await listEvents();
      const term = (query.search ?? '').trim().toLowerCase();
      let matching = term ? events.filter((event) => event.title.toLowerCase().includes(term)) : events;

      const statusValue = query.filters.status?.[0]?.id;
      if (statusValue) {
        matching = matching.filter((event) => statusBucket(event.status) === statusValue);
      }

      const typeValue = query.filters.type?.[0]?.id;
      if (typeValue) {
        matching = matching.filter((event) => event.recurring === (typeValue === 'RECURRING'));
      }

      return { items: matching, total: matching.length };
    },
  });

  const collection = state.collection;

  const columns: TableColumn<EventSummary>[] = [
    {
      id: 'title',
      name: 'Event',
      title: 'Event',
      width: '45%',
      render: (event) => (
        <Box direction="vertical">
          <Text size="small" weight="normal">
            {event.title}
          </Text>
          {!event.agendaEnabled ? (
            <Text size="tiny" skin="disabled">
              Schedule not enabled for this event yet
            </Text>
          ) : null}
        </Box>
      ),
    },
    {
      id: 'date',
      name: 'Date',
      title: 'Date',
      width: '30%',
      render: (event) => (
        <Text size="small" secondary>
          {event.formattedDateAndTime ??
            (event.startDate
              ? formatInZone(event.startDate, event.timeZoneId ?? 'Etc/UTC', i18n.getLocale())
              : 'Date TBD')}
        </Text>
      ),
    },
    {
      id: 'status',
      name: 'Status',
      title: 'Status',
      width: '15%',
      render: (event) => statusBadge(event.status),
    },
    {
      id: 'action',
      name: 'Action',
      title: '',
      width: '10%',
      render: (event) => (
        <Button size="tiny" priority="secondary" onClick={() => onSelect(event)}>
          Edit schedule
        </Button>
      ),
    },
  ];

  return (
    <CollectionPage>
      <CollectionPage.Header
        title={{ text: 'Bulk edit an event schedule' }}
        subtitle={{
          text: 'Pick the event whose schedule you want to edit. Upcoming events are listed first.',
        }}
      />
      <CollectionPage.Content>
        <Table
          state={state}
          columns={columns}
          title={<ToolbarTitle title={`Events (${collection.keyedItems.length})`} />}
          onRowClick={(event) => onSelect(event)}
          filters={
            <CollectionToolbarFilters inline={0} panelTitle="Filter events">
              <RadioGroupFilter
                filter={collection.filters.status!}
                data={STATUS_OPTIONS}
                accordionItemProps={{ label: 'Status' }}
              />
              <RadioGroupFilter
                filter={collection.filters.type!}
                data={TYPE_OPTIONS}
                accordionItemProps={{ label: 'Event type' }}
              />
            </CollectionToolbarFilters>
          }
          rowStatus={(keyed) => {
            const event = keyed.item;
            return statusBucket(event.status) !== 'UPCOMING'
              ? { status: 'warning' as const, messages: ['This event has already finished.'] }
              : null;
          }}
          emptyState={
            <CollectionEmptyState
              title="No events found"
              subtitle="Create an event in Wix Events first, then come back to bulk edit its schedule."
            />
          }
          errorState={(_error, { retry }) => (
            <CollectionEmptyState
              title="Couldn't load your events"
              subtitle="The Wix Events API didn't respond. Check your connection and try again."
            >
              <Button size="small" onClick={retry}>
                Try again
              </Button>
            </CollectionEmptyState>
          )}
        />
      </CollectionPage.Content>
    </CollectionPage>
  );
});
