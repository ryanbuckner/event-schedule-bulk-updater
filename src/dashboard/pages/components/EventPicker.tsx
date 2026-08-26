/**
 * Event selection. Nothing else loads until one event is chosen.
 *
 * Built as a patterns collection rather than a plain list so search comes for
 * free — a site with a few hundred events makes scrolling useless.
 *
 * Ordering is decided by the backend (upcoming soonest-first, then past
 * most-recent-first) and preserved here, so the event the owner most likely
 * wants is at the top.
 */

import { Badge, Box, Button, Text } from '@wix/design-system';
import {
  CollectionEmptyState,
  Table,
  useTableCollection,
  type TableColumn,
} from '@wix/patterns';
import { CollectionPage } from '@wix/patterns/page';
import React from 'react';
import { listEvents } from '../../../backend/api/schedule.web';
import { formatInZone } from '../../../lib/datetime';
import type { EventSummary } from '../../../lib/types';

const PAST_STATUSES = new Set(['ENDED', 'CANCELED']);

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

export function EventPicker({ onSelect }: { onSelect: (event: EventSummary) => void }) {
  const state = useTableCollection<EventSummary, {}>({
    queryName: 'schedule-events',
    paginationMode: 'offset',
    itemKey: (item) => item.id,
    itemName: (item) => item.title,
    filters: {},
    fetchData: async (query) => {
      const events = await listEvents();
      const term = (query.search ?? '').trim().toLowerCase();
      const matching = term
        ? events.filter((event) => event.title.toLowerCase().includes(term))
        : events;
      return { items: matching, total: matching.length };
    },
  });

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
              ? formatInZone(event.startDate, event.timeZoneId ?? 'Etc/UTC')
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
          onRowClick={(event) => onSelect(event)}
          rowStatus={(keyed) => {
            const event = keyed.item;
            return PAST_STATUSES.has(event.status)
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
}
