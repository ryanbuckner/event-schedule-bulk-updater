/**
 * Add new schedule items in bulk.
 *
 * A lightweight local form rather than rows injected into the grid: the grid's
 * collection is server-driven, and giving it synthetic not-yet-saved rows
 * would fight that. Each draft needs a name and a start/end time before it can
 * be added — description, tags, and location aren't collected here (they
 * aren't grid columns either) and can be filled in afterward through CSV
 * import.
 */

import { dashboard } from '@wix/dashboard';
import { Box, Button, Card, IconButton, SectionHelper, Text, TextButton } from '@wix/design-system';
import { Add, Delete } from '@wix/wix-ui-icons-common';
import React, { useState } from 'react';
import { saveSchedule } from '../../../backend/api/schedule.web';
import { shiftMinutes } from '../../../lib/datetime';
import { errorMessage } from '../../../lib/errors';
import type { RowError, RowResult, ScheduleRowFields } from '../../../lib/types';
import { validateRow } from '../../../lib/validation';
import { NameCell, TimeSlotCell } from './cells';

/** No duration was specified for a new item, so it gets a plain, easily-adjusted default. */
const DEFAULT_DURATION_MINUTES = 30;

function blankRow(startIso: string, timeZoneId: string): ScheduleRowFields {
  return {
    name: '',
    description: '',
    stageName: '',
    start: startIso,
    end: shiftMinutes(startIso, DEFAULT_DURATION_MINUTES) ?? startIso,
    timeZoneId,
    tags: [],
    hidden: false,
    status: 'SCHEDULED',
  };
}

export function AddItemsPanel({
  eventId,
  defaultStart,
  defaultTimeZoneId,
  onClose,
  onApplied,
}: {
  eventId: string;
  /** Suggested start for the first item — 10 minutes after the last scheduled item's end, or the event's own start when the schedule is empty. */
  defaultStart: string;
  defaultTimeZoneId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const [drafts, setDrafts] = useState<ScheduleRowFields[]>([
    blankRow(defaultStart, defaultTimeZoneId),
  ]);
  const [committing, setCommitting] = useState(false);
  const [failures, setFailures] = useState<RowResult[]>([]);

  const setField = <K extends keyof ScheduleRowFields>(
    index: number,
    field: K,
    value: ScheduleRowFields[K],
  ) => {
    setDrafts((previous) =>
      previous.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  };

  const addRow = () =>
    setDrafts((previous) => {
      // Each new item defaults 10 minutes after the previous one — whether
      // "previous" is a real scheduled item (the initial default) or just the
      // row drafted right before it, so adding several in a row lines them up
      // back to back without retyping times.
      const last = previous[previous.length - 1];
      const nextStart = last ? (shiftMinutes(last.end, 10) ?? last.end) : defaultStart;
      const zone = last ? last.timeZoneId : defaultTimeZoneId;
      return [...previous, blankRow(nextStart, zone)];
    });
  const removeRow = (index: number) =>
    setDrafts((previous) => previous.filter((_, i) => i !== index));

  const errorsByIndex: RowError[][] = drafts.map((row, index) =>
    validateRow(`draft-${index}`, row),
  );
  const hasErrors = errorsByIndex.some((errors) => errors.length > 0);

  const commit = async () => {
    if (hasErrors || drafts.length === 0) return;
    setCommitting(true);
    setFailures([]);
    try {
      const outcome = await saveSchedule(eventId, { creates: drafts });
      const failed = outcome.results.filter((result) => !result.ok);
      setFailures(failed);
      if (failed.length === 0) {
        dashboard.showToast({
          message: `Added ${outcome.results.length} item${outcome.results.length === 1 ? '' : 's'} to the draft schedule.`,
          type: 'success',
        });
        await onApplied();
      } else {
        dashboard.showToast({
          message: `${outcome.results.length - failed.length} added, ${failed.length} failed.`,
          type: 'error',
        });
      }
    } catch (error) {
      dashboard.showToast({
        message: errorMessage(error, 'Could not add the items.'),
        type: 'error',
      });
    } finally {
      setCommitting(false);
    }
  };

  return (
    <Card>
      <Card.Header
        title="Add new schedule items"
        subtitle="Set a name and start/end time for each. Description, tags, and location can be filled in afterward through CSV import."
        suffix={
          <TextButton size="small" onClick={onClose} disabled={committing}>
            Close
          </TextButton>
        }
      />
      <Card.Content>
        <Box direction="vertical" gap="SP3">
          {failures.length > 0 ? (
            <SectionHelper
              appearance="danger"
              title={`${failures.length} item${failures.length === 1 ? '' : 's'} could not be added`}
            >
              <Box direction="vertical" gap="SP1">
                {failures.map((failure, index) => (
                  <Text key={`${failure.rowId}-${index}`} size="small">
                    <b>{failure.name || `Item ${index + 1}`}:</b> {failure.error}
                  </Text>
                ))}
              </Box>
            </SectionHelper>
          ) : null}

          {drafts.map((row, index) => {
            const errors = errorsByIndex[index];
            return (
              <Box
                key={index}
                direction="horizontal"
                gap="SP3"
                verticalAlign="top"
                border="1px solid"
                borderColor="D40"
                padding="SP2"
              >
                <Box direction="vertical" gap="SP1">
                  <Text size="tiny" secondary>
                    Item Name
                  </Text>
                  <NameCell
                    values={row}
                    errors={errors}
                    disabled={committing}
                    onChange={(value) => setField(index, 'name', value)}
                  />
                </Box>
                <Box direction="vertical" gap="SP1">
                  <Text size="tiny" secondary>
                    Start Date and Time
                  </Text>
                  <TimeSlotCell
                    iso={row.start}
                    timeZoneId={row.timeZoneId}
                    message={errors.find((e) => e.field === 'start')?.message}
                    disabled={committing}
                    onChange={(iso) => setField(index, 'start', iso)}
                  />
                </Box>
                <Box direction="vertical" gap="SP1">
                  <Text size="tiny" secondary>
                    End Date and Time
                  </Text>
                  <TimeSlotCell
                    iso={row.end}
                    timeZoneId={row.timeZoneId}
                    message={errors.find((e) => e.field === 'end')?.message}
                    disabled={committing}
                    onChange={(iso) => setField(index, 'end', iso)}
                  />
                </Box>
                <IconButton
                  size="small"
                  priority="secondary"
                  skin="destructive"
                  disabled={committing || drafts.length === 1}
                  ariaLabel="Remove this item"
                  onClick={() => removeRow(index)}
                >
                  <Delete />
                </IconButton>
              </Box>
            );
          })}

          <Box>
            <Button
              size="small"
              priority="secondary"
              prefixIcon={<Add />}
              disabled={committing}
              onClick={addRow}
            >
              Add another item
            </Button>
          </Box>

          <Box gap="SP2">
            <Button size="small" disabled={committing || hasErrors} onClick={commit}>
              {committing ? 'Adding…' : `Add ${drafts.length} item${drafts.length === 1 ? '' : 's'}`}
            </Button>
            <Button size="small" priority="secondary" onClick={onClose} disabled={committing}>
              Cancel
            </Button>
          </Box>
        </Box>
      </Card.Content>
    </Card>
  );
}
