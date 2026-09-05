/**
 * Add new schedule items in bulk.
 *
 * A lightweight local form rather than rows injected into the grid: the grid's
 * collection is server-driven, and giving it synthetic not-yet-saved rows
 * would fight that. Each draft needs a name and a start/end time before it can
 * be added; Place and Tags are optional here, same as in the grid. Description
 * isn't collected here (it isn't a grid column either) and can be filled in
 * afterward through CSV import.
 */

import { dashboard } from '@wix/dashboard';
import {
  Box,
  Button,
  Card,
  IconButton,
  LinearProgressBar,
  SectionHelper,
  Text,
  TextButton,
} from '@wix/design-system';
import { Add, Delete } from '@wix/wix-ui-icons-common';
import React, { useState } from 'react';
import { saveSchedule } from '../../../backend/api/schedule.web';
import { shiftMinutes } from '../../../lib/datetime';
import { errorMessage } from '../../../lib/errors';
import { paceWrites } from '../../../lib/pacing';
import type { RowError, RowResult, ScheduleRowFields } from '../../../lib/types';
import { normalizeDuration, validateRow } from '../../../lib/validation';
import { NameCell, PlaceCell, RequiredMark, TagsCell, TimeSlotCell } from './cells';

/**
 * Default duration for a new item. Applied both to a brand-new blank row and
 * whenever the start time is edited — end always follows start by this much,
 * since a new item has no end of its own yet worth preserving.
 */
const DEFAULT_DURATION_MINUTES = 15;

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
  placeOptions,
  onClose,
  onRefresh,
  onApplied,
}: {
  eventId: string;
  /** Suggested start for the first item — 10 minutes after the last scheduled item's end, or the event's own start when the schedule is empty. */
  defaultStart: string;
  defaultTimeZoneId: string;
  /** Existing places across this schedule, offered as Place suggestions — same list the grid uses. */
  placeOptions: string[];
  onClose: () => void;
  /** Refreshes the grid's data without closing this panel — called after every
   * commit attempt, since a partial failure can still mean some creates
   * landed in the draft schedule and the grid needs to catch up. */
  onRefresh: () => Promise<void> | void;
  /** Everything succeeded: closes the panel and offers to publish. */
  onApplied: () => Promise<void> | void;
}) {
  const [drafts, setDrafts] = useState<ScheduleRowFields[]>([
    blankRow(defaultStart, defaultTimeZoneId),
  ]);
  const [committing, setCommitting] = useState(false);
  const [failures, setFailures] = useState<RowResult[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const setField = <K extends keyof ScheduleRowFields>(
    index: number,
    field: K,
    value: ScheduleRowFields[K],
  ) => {
    setDrafts((previous) =>
      previous.map((row, i) => {
        if (i !== index) return row;
        const updated = { ...row, [field]: value };
        // A new item has no end of its own worth preserving yet, so end
        // always follows start by the same default duration rather than
        // just being nudged to stay a minimum gap apart.
        if (field === 'start') {
          updated.end = shiftMinutes(updated.start, DEFAULT_DURATION_MINUTES) ?? updated.end;
        }
        return normalizeDuration(updated);
      }),
    );
  };

  const addRow = () =>
    setDrafts((previous) => {
      // A new draft row starts exactly where the previous *draft* row ends,
      // so several items added in a row sit back to back with no gap. (The
      // very first draft is the exception — its start comes from
      // `defaultStart`, which already carries a 10-minute gap after the last
      // real scheduled item.)
      const last = previous[previous.length - 1];
      const nextStart = last ? last.end : defaultStart;
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
    setProgress({ done: 0, total: drafts.length });

    // One item per request, paced (see pacing.ts), rather than a batch —
    // keeps the API's burst quota from tripping in the first place instead
    // of paying to recover after it does, and a one-item request resolving
    // on its own is what makes real "N of M added" progress possible.
    const results: RowResult[] = [];
    try {
      for (let i = 0; i < drafts.length; i++) {
        const outcome = await saveSchedule(eventId, { creates: [drafts[i]] });
        results.push(...outcome.results);
        setProgress({ done: i + 1, total: drafts.length });
        await paceWrites(i, drafts.length);
      }
    } catch (error) {
      // A chunk can fail outright (network error, etc.) after earlier chunks
      // already landed — refresh and drop what succeeded so far rather than
      // leave the grid stale and risk duplicating those on retry.
      setDrafts((previous) => previous.filter((_, index) => !results[index]?.ok));
      await onRefresh();
      dashboard.showToast({
        message: errorMessage(error, 'Could not add the items.'),
        type: 'error',
      });
      setCommitting(false);
      setProgress(null);
      return;
    }

    const failed = results.filter((result) => !result.ok);
    setFailures(failed);
    // Results are positionally aligned with `drafts` (creates preserve order
    // end to end within and across chunks, and a request only reaches the
    // server at all once every row has passed validation) — index, not
    // rowId, is what reliably ties a result back to its draft, since a
    // successful create's rowId is the new server-assigned id, not
    // `new-<index>`. Drop the ones that succeeded; only failures stay in the
    // form to fix and retry, so retrying never recreates something already
    // saved.
    setDrafts((previous) => previous.filter((_, index) => !results[index]?.ok));
    if (failed.length === 0) {
      dashboard.showToast({
        message: `Added ${results.length} item${results.length === 1 ? '' : 's'} to the draft schedule.`,
        type: 'success',
      });
      await onApplied();
    } else {
      // Some creates may still have landed before the rest failed, so the
      // grid needs to catch up even though the panel stays open for the
      // user to see and retry what didn't.
      dashboard.showToast({
        message: `${results.length - failed.length} added, ${failed.length} failed.`,
        type: 'error',
      });
      await onRefresh();
    }
    setCommitting(false);
    setProgress(null);
  };

  return (
    <Card>
      <Card.Header
        title="Add new schedule items"
        subtitle="Set a name and start/end time for each. Place and Tags are optional. Description can be filled in afterward through CSV import."
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
                    <RequiredMark />
                  </Text>
                  <NameCell
                    values={row}
                    errors={errors}
                    disabled={committing}
                    onChange={(value) => setField(index, 'name', value)}
                  />
                </Box>
                <Box direction="vertical" gap="SP2">
                  <Box direction="vertical" gap="SP1">
                    <Text size="tiny" secondary>
                      Start Date and Time
                      <RequiredMark />
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
                      Place
                    </Text>
                    <PlaceCell
                      value={row.stageName}
                      options={placeOptions}
                      message={errors.find((e) => e.field === 'stageName')?.message}
                      disabled={committing}
                      onChange={(value) => setField(index, 'stageName', value)}
                    />
                  </Box>
                </Box>
                <Box direction="vertical" gap="SP2">
                  <Box direction="vertical" gap="SP1">
                    <Text size="tiny" secondary>
                      End Date and Time
                      <RequiredMark />
                    </Text>
                    <TimeSlotCell
                      iso={row.end}
                      timeZoneId={row.timeZoneId}
                      message={errors.find((e) => e.field === 'end')?.message}
                      disabled={committing}
                      onChange={(iso) => setField(index, 'end', iso)}
                    />
                  </Box>
                  <Box direction="vertical" gap="SP1">
                    <Text size="tiny" secondary>
                      Tags
                    </Text>
                    <TagsCell
                      values={row}
                      errors={errors}
                      disabled={committing}
                      onChange={(tags) => setField(index, 'tags', tags)}
                    />
                  </Box>
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

          {progress ? (
            <Box direction="vertical" gap="SP1">
              <LinearProgressBar
                value={(progress.done / progress.total) * 100}
                label={`Adding ${progress.done} of ${progress.total}…`}
                showProgressIndication
              />
              <Text size="tiny" secondary>
                Large batches go a few items at a time and pause briefly between groups —
                that's Wix's own API pacing itself, not this app stalling.
              </Text>
            </Box>
          ) : null}

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
