/**
 * The bulk edit grid for one event's schedule.
 *
 * Two state owners, deliberately separated:
 *  - the patterns collection owns the rows as the server returned them, plus
 *    selection, the toolbar, and the empty/error states;
 *  - `useScheduleEdits` owns unsaved changes layered on top.
 *
 * Every write goes to the event's DRAFT schedule — the API has no path to the
 * published one — so publishing is a separate, explicit step and the UI never
 * implies an edit is live until it happens.
 */

import { dashboard } from '@wix/dashboard';
import {
  Box,
  Button,
  SectionHelper,
  Text,
  TextButton,
} from '@wix/design-system';
import {
  CollectionEmptyState,
  PrimaryActionButton,
  Table,
  TableTopNotification,
  ToolbarSecondaryActions,
  useTableCollection,
  type TableColumn,
} from '@wix/patterns';
import { CollectionPage } from '@wix/patterns/page';
import React, { useCallback, useRef, useState } from 'react';
import {
  getSchedule,
  saveSchedule,
  setScheduleVisibility,
} from '../../../backend/api/schedule.web';
import { formatInZone } from '../../../lib/datetime';
import { toCsv, exportFilename } from '../../../lib/csv';
import {
  LIMITS,
  type EventSummary,
  type RowResult,
  type ScheduleRow,
} from '../../../lib/types';
import {
  HiddenCell,
  NameCell,
  RowStatusCell,
  TagsCell,
  TextCell,
  TimeSlotCell,
} from './cells';
import { ImportPanel } from './ImportPanel';
import { TimeShiftBar } from './TimeShiftBar';
import { useScheduleEdits } from './useScheduleEdits';

/** Rows per save request. Small enough to give real progress on a big edit. */
const SAVE_CHUNK = 10;

function downloadCsv(rows: ScheduleRow[], eventTitle: string) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFilename(eventTitle);
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ScheduleEditor({
  event,
  canWrite,
  onUpgrade,
  onChangeEvent,
}: {
  event: EventSummary;
  /** False on the free tier: reading and exporting stay available, writing doesn't. */
  canWrite: boolean;
  onUpgrade: () => Promise<string | null>;
  onChangeEvent: () => void;
}) {
  const [draftNotPublished, setDraftNotPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<RowResult[]>([]);
  const [publishPrompt, setPublishPrompt] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // The rows most recently returned by the server, kept for CSV export and for
  // the import diff — both need the true server state, not the edited view.
  const serverRows = useRef<ScheduleRow[]>([]);

  const state = useTableCollection<ScheduleRow, {}>({
    queryName: `schedule-${event.id}`,
    paginationMode: 'offset',
    itemKey: (item) => item.id,
    itemName: (item) => item.name || 'Untitled item',
    filters: {},
    fetchData: async () => {
      const snapshot = await getSchedule(event.id);
      setDraftNotPublished(snapshot.draftNotPublished);
      serverRows.current = snapshot.rows;
      // The backend already followed paging and returned everything, so the
      // collection gets one complete page.
      return { items: snapshot.rows, total: snapshot.rows.length };
    },
  });

  const rows = state.collection.keyedItems.map((keyed) => keyed.item);
  const edits = useScheduleEdits(rows);
  const selected = state.collection.bulkSelect.selectedValues;

  const blocked = edits.errorCount > 0;
  const busy = saving || publishing;
  // On the free tier the grid is a viewer: cells are inert, so there is never
  // unsaved work that can't be saved.
  const locked = busy || !canWrite;

  /** Warns before losing unsaved edits on navigation. */
  const dirtyRef = useRef(edits.dirtyCount);
  dirtyRef.current = edits.dirtyCount;
  React.useEffect(() => {
    const subscription = dashboard.onBeforeUnload(() => ({
      shouldBlock: dirtyRef.current > 0,
    }));
    return () => subscription.remove();
  }, []);

  const save = useCallback(async () => {
    const pending = edits.pending;
    if (pending.length === 0) return;

    setSaving(true);
    setFailures([]);
    setPublishPrompt(false);
    setProgress({ done: 0, total: pending.length });

    const results: RowResult[] = [];
    try {
      for (let i = 0; i < pending.length; i += SAVE_CHUNK) {
        const chunk = pending.slice(i, i + SAVE_CHUNK);
        const outcome = await saveSchedule(event.id, { updates: chunk });
        results.push(...outcome.results);
        setProgress({ done: Math.min(i + SAVE_CHUNK, pending.length), total: pending.length });
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'The save could not be completed.';
      // Earlier chunks may already have been written, so the grid must be
      // resynced rather than left showing a state the server doesn't hold.
      await state.collection.refreshAllPages();
      edits.clearSaved(results.filter((r) => r.ok).map((r) => r.rowId));
      dashboard.showToast({
        message: `${message} Any changes already saved have been reloaded.`,
        type: 'error',
      });
      setSaving(false);
      setProgress(null);
      return;
    }

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // Refetch rather than trusting local state, so the grid shows what the
    // server actually holds.
    await state.collection.refreshAllPages();
    edits.clearSaved(succeeded.map((r) => r.rowId));

    setFailures(failed);
    setSaving(false);
    setProgress(null);

    if (failed.length === 0) {
      dashboard.showToast({
        message: `Saved ${succeeded.length} item${succeeded.length === 1 ? '' : 's'} to the draft schedule.`,
        type: 'success',
      });
      setPublishPrompt(true);
    } else {
      // Partial failure: never rounded up to success, and publishing is not
      // offered until the owner has dealt with the failures.
      dashboard.showToast({
        message: `${succeeded.length} saved, ${failed.length} failed.`,
        type: 'error',
      });
    }
  }, [edits, event.id, state.collection]);

  const runPublish = useCallback(
    async (action: 'publish' | 'discard') => {
      setPublishing(true);
      try {
        await setScheduleVisibility(event.id, action);
        await state.collection.refreshAllPages();
        edits.reset();
        setPublishPrompt(false);
        dashboard.showToast({
          message:
            action === 'publish'
              ? 'Schedule published. Guests can see these changes now.'
              : 'Draft changes discarded.',
          type: 'success',
        });
      } catch (error) {
        dashboard.showToast({
          message:
            error instanceof Error && error.message
              ? error.message
              : `Could not ${action} the schedule.`,
          type: 'error',
        });
      } finally {
        setPublishing(false);
      }
    },
    [edits, event.id, state.collection],
  );

  const columns: TableColumn<ScheduleRow>[] = [
    {
      id: 'name',
      name: 'Name',
      title: 'Name',
      width: '22%',
      hiddenFromCustomColumnsSelection: true,
      render: (row: ScheduleRow) => (
        <NameCell
          values={edits.valueOf(row)}
          errors={edits.errorsByRow.get(row.id)}
          disabled={locked}
          onChange={(value) => edits.setField(row, 'name', value)}
        />
      ),
    },
    {
      id: 'start',
      name: 'Starts',
      title: 'Starts',
      width: '16%',
      render: (row: ScheduleRow) => {
        const values = edits.valueOf(row);
        return (
          <TimeSlotCell
            iso={values.start}
            timeZoneId={values.timeZoneId}
            message={edits.errorsByRow.get(row.id)?.find((e) => e.field === 'start')?.message}
            disabled={locked}
            onChange={(iso) => edits.setField(row, 'start', iso)}
          />
        );
      },
    },
    {
      id: 'end',
      name: 'Ends',
      title: 'Ends',
      width: '16%',
      render: (row: ScheduleRow) => {
        const values = edits.valueOf(row);
        return (
          <TimeSlotCell
            iso={values.end}
            timeZoneId={values.timeZoneId}
            message={edits.errorsByRow.get(row.id)?.find((e) => e.field === 'end')?.message}
            disabled={locked}
            onChange={(iso) => edits.setField(row, 'end', iso)}
          />
        );
      },
    },
    {
      id: 'stageName',
      name: 'Location',
      title: 'Location',
      width: '12%',
      render: (row: ScheduleRow) => (
        <TextCell
          value={edits.valueOf(row).stageName}
          maxLength={LIMITS.STAGE_NAME_MAX}
          placeholder="Stage or room"
          message={edits.errorsByRow.get(row.id)?.find((e) => e.field === 'stageName')?.message}
          disabled={locked}
          onChange={(value) => edits.setField(row, 'stageName', value)}
        />
      ),
    },
    {
      id: 'description',
      name: 'Description',
      title: 'Description',
      width: '18%',
      defaultHidden: true,
      render: (row: ScheduleRow) => (
        <TextCell
          value={edits.valueOf(row).description}
          maxLength={LIMITS.DESCRIPTION_MAX}
          placeholder="Description"
          message={
            edits.errorsByRow.get(row.id)?.find((e) => e.field === 'description')?.message
          }
          disabled={locked}
          onChange={(value) => edits.setField(row, 'description', value)}
        />
      ),
    },
    {
      id: 'tags',
      name: 'Tags',
      title: 'Tags',
      width: '12%',
      render: (row: ScheduleRow) => (
        <TagsCell
          values={edits.valueOf(row)}
          errors={edits.errorsByRow.get(row.id)}
          disabled={locked}
          onChange={(tags) => edits.setField(row, 'tags', tags)}
        />
      ),
    },
    {
      id: 'hidden',
      name: 'Hidden',
      title: 'Hidden',
      width: '80px',
      render: (row: ScheduleRow) => (
        <HiddenCell
          values={edits.valueOf(row)}
          disabled={locked}
          onChange={(hidden) => edits.setField(row, 'hidden', hidden)}
        />
      ),
    },
    {
      id: 'updated',
      name: 'Time zone',
      title: 'Time zone',
      width: '10%',
      defaultHidden: true,
      render: (row: ScheduleRow) => (
        <Text size="tiny" secondary>
          {row.timeZoneId}
        </Text>
      ),
    },
  ];

  return (
    <CollectionPage>
      <CollectionPage.Header
        title={{ text: event.title }}
        subtitle={{
          text:
            event.formattedDateAndTime ??
            (event.startDate ? formatInZone(event.startDate, event.timeZoneId ?? 'Etc/UTC') : ''),
        }}
      />
      <CollectionPage.Content>
        <Box direction="vertical" gap="SP3">
          <Box gap="SP2" verticalAlign="middle">
            <TextButton size="small" onClick={onChangeEvent} disabled={busy}>
              Choose a different event
            </TextButton>
          </Box>

          {blocked ? (
            <SectionHelper appearance="danger" title="Fix these before saving">
              <Box direction="vertical" gap="SP1">
                {[...edits.errorsByRow.entries()].map(([rowId, rowErrors]) => {
                  const row = rows.find((r) => r.id === rowId);
                  const label = edits.valueOf(row ?? ({ id: rowId } as ScheduleRow))?.name;
                  return (
                    <Text key={rowId} size="small">
                      <b>{label || 'Untitled item'}:</b>{' '}
                      {rowErrors.map((e) => e.message).join(' ')}
                    </Text>
                  );
                })}
              </Box>
            </SectionHelper>
          ) : null}

          {failures.length > 0 ? (
            <SectionHelper
              appearance="danger"
              title={`${failures.length} item${failures.length === 1 ? '' : 's'} could not be saved`}
              onClose={() => setFailures([])}
            >
              <Box direction="vertical" gap="SP1">
                {failures.map((failure) => (
                  <Text key={`${failure.operation}-${failure.rowId}`} size="small">
                    <b>{failure.name || failure.rowId}:</b> {failure.error}
                  </Text>
                ))}
                <Text size="tiny" secondary>
                  Everything else was saved to the draft schedule. Fix these rows and save
                  again.
                </Text>
              </Box>
            </SectionHelper>
          ) : null}

          {showImport ? (
            <ImportPanel
              eventId={event.id}
              onClose={() => setShowImport(false)}
              onApplied={async () => {
                await state.collection.refreshAllPages();
                edits.reset();
                setShowImport(false);
                setPublishPrompt(true);
              }}
            />
          ) : null}

          <TimeShiftBar
            selected={selected}
            disabled={locked}
            onApply={(targets, change) => edits.applyToRows(targets, change)}
          />

          <Table
            state={state}
            columns={columns}
            showSelection
            internalScroll
            stickySelectionColumn
            search={false}
            rowStatus={(keyed) => {
              const row = keyed.item;
              const rowErrors = edits.errorsByRow.get(row.id);
              if (rowErrors && rowErrors.length > 0) {
                return {
                  status: 'error' as const,
                  messages: rowErrors.map((e) => e.message),
                };
              }
              if (edits.isDirty(row.id)) {
                return { status: 'warning' as const, messages: ['Unsaved change'] };
              }
              return null;
            }}
            topNotification={
              publishPrompt ? (
                <TableTopNotification
                  skin="premium"
                  showPrefixIcon
                  title="Saved to the draft schedule. Publish it so guests can see the changes?"
                  actionText={publishing ? 'Publishing…' : 'Publish now'}
                  actionDisabled={publishing || !canWrite}
                  onAction={() => runPublish('publish')}
                  secondaryActionProps={{
                    label: 'Keep as draft',
                    onClick: () => setPublishPrompt(false),
                  }}
                />
              ) : draftNotPublished ? (
                <TableTopNotification
                  skin="warning"
                  showPrefixIcon
                  title="This event has unpublished draft changes. Guests still see the previously published schedule."
                  actionText={publishing ? 'Publishing…' : 'Publish'}
                  actionDisabled={publishing || !canWrite}
                  onAction={() => runPublish('publish')}
                  secondaryActionProps={{
                    label: 'Discard draft',
                    onClick: () => runPublish('discard'),
                  }}
                />
              ) : null
            }
            secondaryActions={
              <ToolbarSecondaryActions
                items={[
                  {
                    label: 'Export CSV',
                    onClick: () => downloadCsv(serverRows.current, event.title),
                    disabled: busy,
                  },
                  {
                    label: canWrite ? 'Import CSV' : 'Import CSV (requires purchase)',
                    onClick: () => (canWrite ? setShowImport(true) : void onUpgrade()),
                    disabled: busy,
                  },
                ]}
              />
            }
            primaryActionButton={
              <PrimaryActionButton
                onClick={canWrite ? save : () => void onUpgrade()}
                disabled={canWrite && (busy || blocked || edits.dirtyCount === 0)}
              >
                {!canWrite
                  ? 'Buy to unlock saving'
                  : progress
                    ? `Saving ${progress.done} of ${progress.total}…`
                    : edits.dirtyCount > 0
                      ? `Save ${edits.dirtyCount} change${edits.dirtyCount === 1 ? '' : 's'}`
                      : 'Save changes'}
              </PrimaryActionButton>
            }
            emptyState={
              <CollectionEmptyState
                title="This event has no schedule items yet"
                subtitle="Add items in Wix Events, or import a CSV to build the schedule in bulk."
              >
                <Button
                  size="small"
                  onClick={() => (canWrite ? setShowImport(true) : void onUpgrade())}
                >
                  {canWrite ? 'Import CSV' : 'Buy to unlock importing'}
                </Button>
              </CollectionEmptyState>
            }
            errorState={(_error, { retry }) => (
              <CollectionEmptyState
                title="Couldn't load this schedule"
                subtitle="The Wix Events API didn't respond. Check your connection and try again."
              >
                <Button size="small" onClick={retry}>
                  Try again
                </Button>
              </CollectionEmptyState>
            )}
          />
        </Box>
      </CollectionPage.Content>
    </CollectionPage>
  );
}
