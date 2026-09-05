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
 *
 * Column labels match the single-item editor's own field names ("Item Name",
 * "Start Date and Time", "End Date and Time") so the grid reads as the same
 * schedule, not a different tool.
 *
 * Place and Tags share the Start/End columns rather than getting columns of
 * their own — stacked below each date/time picker — so both fields get a
 * usable width instead of being squeezed into a narrow column apiece.
 *
 * Description and Time zone are deliberately not columns here — Description
 * isn't a fit for bulk editing, and Time zone was cut to keep the grid from
 * getting too cramped — but both stay fully readable and writable through
 * CSV export and import (see `csv.ts`). Because there's no cell for either,
 * the grid never marks them changed, so a grid save's field mask never
 * includes them and their current server values are left untouched.
 *
 * The trailing "meta" column groups every per-row state indicator — Hidden,
 * Unsaved, Unpublished — after the editable fields rather than leading with
 * a dedicated status column, so Item Name sits right next to the row
 * checkbox instead of leaving a gap for icons in front of it.
 */

import { dashboard } from '@wix/dashboard';
import { i18n } from '@wix/essentials';
import { Box, Breadcrumbs, Button, SectionHelper, Text } from '@wix/design-system';
import {
  CollectionEmptyState,
  MoreActions,
  MultiBulkActionToolbar,
  PrimaryActionButton,
  PrimaryActions,
  SecondaryActions,
  Table,
  TableTopNotification,
  ToolbarSecondaryActions,
  useTableCollection,
  type TableColumn,
} from '@wix/patterns';
import { CollectionPage } from '@wix/patterns/page';
import {
  Check,
  Delete,
  DownloadImportSmall,
  Publish,
  UploadExportSmall,
  Unsaved,
} from '@wix/wix-ui-icons-common';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getSchedule,
  saveSchedule,
  setScheduleVisibility,
} from '../../../backend/api/schedule.web';
import { formatInZone, shiftMinutes } from '../../../lib/datetime';
import { errorMessage } from '../../../lib/errors';
import { downloadCsv, exportFilename, toCsv } from '../../../lib/csv';
import { type EventSummary, type RowResult, type ScheduleRow } from '../../../lib/types';
import { AddItemsPanel } from './AddItemsPanel';
import {
  HiddenCell,
  NameCell,
  PlaceCell,
  RowStatusIcons,
  TagsCell,
  TimeSlotCell,
  UNPUBLISHED_ICON_COLOR,
  UNSAVED_ICON_COLOR,
} from './cells';
import { ImportPanel } from './ImportPanel';
import { TimeShiftBar } from './TimeShiftBar';
import { useScheduleEdits } from './useScheduleEdits';

/** Rows per save request. Small enough to give real progress on a big edit. */
const SAVE_CHUNK = 10;

export function ScheduleEditor({
  event,
  onChangeEvent,
}: {
  event: EventSummary;
  onChangeEvent: () => void;
}) {
  const [draftNotPublished, setDraftNotPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<RowResult[]>([]);
  const [publishPrompt, setPublishPrompt] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddItems, setShowAddItems] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScheduleRow[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  // "Add Schedule Item" is a toolbar action reachable from anywhere on the
  // page, but the panel itself renders near the top of the content — if the
  // user has scrolled down into a long schedule, it opens off-screen above
  // them. Scroll it into view the moment it opens rather than leaving them
  // to notice and scroll up themselves.
  const addItemsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showAddItems) {
      addItemsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showAddItems]);

  // Mirrors the table's own selection via `onSelectedItems`, so TimeShiftBar
  // can stay permanently rendered (never hidden) while still getting live
  // selection — `bulkActionToolbar`'s own render prop is the only other
  // source of live selection, but the table itself hides that slot whenever
  // nothing's selected, which is exactly the disappearing act being fixed.
  const [selectedRows, setSelectedRows] = useState<ScheduleRow[]>([]);
  // `bulkActionToolbar` hands us a fresh `clearSelection` on every render;
  // stashed here so `save()` (outside that render prop's scope) can clear the
  // table's selection after a successful save without re-plumbing it as a
  // prop. Calling a stale closure when nothing is selected is a harmless
  // no-op, so no cleanup is needed when the slot stops rendering.
  const clearSelectionRef = useRef<(() => void) | null>(null);

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

  // Where a newly added item should start: 10 minutes after the last
  // scheduled item's end, in that item's own zone. With no items yet, there's
  // no "last one" to build on, so this falls back to the event's own start
  // (or its zone alone, if the event's date is still TBD).
  const nextItemDefault = (() => {
    const lastByEnd = [...rows].sort((a, b) => Date.parse(a.end) - Date.parse(b.end)).at(-1);
    if (lastByEnd) {
      return {
        start: shiftMinutes(lastByEnd.end, 10) ?? lastByEnd.end,
        timeZoneId: lastByEnd.timeZoneId,
      };
    }
    const zone = event.timeZoneId ?? 'Etc/UTC';
    return { start: event.startDate ?? new Date().toISOString(), timeZoneId: zone };
  })();

  // Existing places across this schedule, offered as suggestions in the
  // Place field — not a locked list, since the API has no place taxonomy of
  // its own; just a shortcut to avoid re-typing "Main Stage" on every row.
  const placeOptions = Array.from(
    new Set(rows.map((row) => edits.valueOf(row).stageName).filter((place) => place !== '')),
  ).sort((a, b) => a.localeCompare(b));

  const blocked = edits.errorCount > 0;
  const busy = saving || publishing || deleting;

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
      const message = errorMessage(error, 'The save could not be completed.');
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
      // Everything just saved is already reflected in the draft — leaving
      // rows checked (and a stale shift amount sitting in TimeShiftBar) reads
      // as unfinished work rather than a completed save.
      clearSelectionRef.current?.();
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
          message: errorMessage(error, `Could not ${action} the schedule.`),
          type: 'error',
        });
      } finally {
        setPublishing(false);
      }
    },
    [edits, event.id, state.collection],
  );

  const runDelete = useCallback(async () => {
    if (!pendingDelete || pendingDelete.length === 0) return;
    const count = pendingDelete.length;
    setDeleting(true);
    try {
      await saveSchedule(event.id, {
        deletes: pendingDelete.map((row) => ({ id: row.id, name: row.name })),
      });
      await state.collection.refreshAllPages();
      setPendingDelete(null);
      dashboard.showToast({
        message: `Deleted ${count} item${count === 1 ? '' : 's'} from the draft schedule.`,
        type: 'success',
      });
      setPublishPrompt(true);
    } catch (error) {
      dashboard.showToast({
        message: errorMessage(error, 'Could not delete the selected items.'),
        type: 'error',
      });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, event.id, state.collection]);

  // `columns` must keep one stable identity for the life of the grid. It
  // used to be a plain array literal, rebuilt fresh on every render — i.e.
  // every keystroke, since each render closed over the current
  // `edits`/`busy`/`placeOptions`. The underlying table resets focus and
  // text selection in the currently-edited cell whenever it sees a new
  // `columns` array, which read as "the cursor jumps to the end after the
  // first character" — confirmed by testing. Computing `columns` once via
  // `useMemo(..., [])` and having each render function read current values
  // through this ref (instead of closing over them directly) keeps cell
  // values/handlers live without ever changing the columns array itself.
  const liveRef = useRef({ edits, busy, placeOptions, draftNotPublished });
  liveRef.current = { edits, busy, placeOptions, draftNotPublished };

  const columns: TableColumn<ScheduleRow>[] = useMemo(
    () => [
      {
        id: 'name',
        name: 'Item Name',
        title: 'Item Name',
        width: '26%',
        hiddenFromCustomColumnsSelection: true,
        render: (row: ScheduleRow) => (
          <NameCell
            values={liveRef.current.edits.valueOf(row)}
            errors={liveRef.current.edits.errorsByRow.get(row.id)}
            disabled={liveRef.current.busy}
            onChange={(value) => liveRef.current.edits.setField(row, 'name', value)}
          />
        ),
      },
      {
        id: 'start',
        name: 'Start Date and Time',
        title: 'Start Date and Time',
        width: '34%',
        render: (row: ScheduleRow) => {
          const values = liveRef.current.edits.valueOf(row);
          return (
            <Box direction="vertical" gap="SP1">
              <TimeSlotCell
                iso={values.start}
                timeZoneId={values.timeZoneId}
                message={
                  liveRef.current.edits.errorsByRow
                    .get(row.id)
                    ?.find((e) => e.field === 'start')?.message
                }
                disabled={liveRef.current.busy}
                onChange={(iso) => liveRef.current.edits.setField(row, 'start', iso)}
              />
              <PlaceCell
                value={values.stageName}
                options={liveRef.current.placeOptions}
                message={
                  liveRef.current.edits.errorsByRow
                    .get(row.id)
                    ?.find((e) => e.field === 'stageName')?.message
                }
                disabled={liveRef.current.busy}
                onChange={(value) => liveRef.current.edits.setField(row, 'stageName', value)}
              />
            </Box>
          );
        },
      },
      {
        id: 'end',
        name: 'End Date and Time',
        title: 'End Date and Time',
        width: '34%',
        render: (row: ScheduleRow) => {
          const values = liveRef.current.edits.valueOf(row);
          return (
            <Box direction="vertical" gap="SP1">
              <TimeSlotCell
                iso={values.end}
                timeZoneId={values.timeZoneId}
                message={
                  liveRef.current.edits.errorsByRow
                    .get(row.id)
                    ?.find((e) => e.field === 'end')?.message
                }
                disabled={liveRef.current.busy}
                onChange={(iso) => liveRef.current.edits.setField(row, 'end', iso)}
              />
              <TagsCell
                values={values}
                errors={liveRef.current.edits.errorsByRow.get(row.id)}
                disabled={liveRef.current.busy}
                onChange={(tags) => liveRef.current.edits.setField(row, 'tags', tags)}
              />
            </Box>
          );
        },
      },
      {
        // Combines the Hidden toggle with the row's status icons (Unsaved /
        // Unpublished), trailing the row rather than leading it — frees up
        // the space that used to sit between the checkbox and Item Name for
        // a dedicated leading status column, and groups all of a row's
        // meta/state indicators (as opposed to its editable content) in one
        // place at the end.
        id: 'meta',
        name: 'Status',
        title: '',
        width: '84px',
        hiddenFromCustomColumnsSelection: true,
        render: (row: ScheduleRow) => (
          <Box gap="SP1" verticalAlign="middle">
            <RowStatusIcons
              dirty={liveRef.current.edits.isDirty(row.id)}
              unpublished={liveRef.current.draftNotPublished}
              errors={liveRef.current.edits.errorsByRow.get(row.id)}
            />
            <HiddenCell
              values={liveRef.current.edits.valueOf(row)}
              disabled={liveRef.current.busy}
              onChange={(hidden) => liveRef.current.edits.setField(row, 'hidden', hidden)}
            />
          </Box>
        ),
      },
    ],
    [],
  );

  return (
    <CollectionPage>
      <CollectionPage.Header
        title={{ text: event.title }}
        breadcrumbs={
          <Breadcrumbs
            activeId="schedule"
            items={[
              { id: 'events', value: 'Events' },
              { id: 'event', value: event.title },
              { id: 'schedule', value: 'Schedule' },
            ]}
            onClick={(item) => {
              // Only "Events" actually goes anywhere — the event name and
              // "Schedule" are just context for where you are, same as the
              // rest of this trail can't link into Wix's own native Events
              // app pages (its own breadcrumb, e.g. Features), which this
              // app has no access to.
              if (item.id === 'events') onChangeEvent();
            }}
          />
        }
        subtitle={{
          text:
            event.formattedDateAndTime ??
            (event.startDate
              ? formatInZone(event.startDate, event.timeZoneId ?? 'Etc/UTC', i18n.getLocale())
              : ''),
        }}
        primaryAction={
          <PrimaryActions
            label="Publish schedule"
            prefixIcon={<Check />}
            disabled={busy || !draftNotPublished}
            onClick={() => runPublish('publish')}
          />
        }
        secondaryActions={
          <SecondaryActions
            label="Discard draft changes"
            disabled={busy || !draftNotPublished}
            onClick={() => runPublish('discard')}
          />
        }
        moreActions={
          <MoreActions
            items={[
              {
                text: 'Import CSV',
                prefixIcon: <DownloadImportSmall />,
                onClick: () => setShowImport(true),
                disabled: busy,
              },
              {
                text: 'Export CSV',
                prefixIcon: <UploadExportSmall />,
                onClick: () => downloadCsv(toCsv(serverRows.current), exportFilename(event.title)),
                disabled: busy,
              },
            ]}
          />
        }
      />
      <CollectionPage.Content>
        <Box direction="vertical" gap="SP3">
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

          {showAddItems ? (
            <div ref={addItemsRef}>
              <AddItemsPanel
                eventId={event.id}
                defaultStart={nextItemDefault.start}
                defaultTimeZoneId={nextItemDefault.timeZoneId}
                placeOptions={placeOptions}
                onClose={() => setShowAddItems(false)}
                onApplied={async () => {
                  await state.collection.refreshAllPages();
                  setShowAddItems(false);
                  setPublishPrompt(true);
                }}
              />
            </div>
          ) : null}

          {pendingDelete ? (
            <SectionHelper appearance="danger" title={`Delete ${pendingDelete.length} item${pendingDelete.length === 1 ? '' : 's'}?`}>
              <Box direction="vertical" gap="SP2">
                <Text size="small">
                  {pendingDelete.map((row) => row.name || 'Untitled item').join(', ')}
                </Text>
                <Box gap="SP2">
                  <Button size="small" skin="destructive" disabled={deleting} onClick={runDelete}>
                    {deleting ? 'Deleting…' : `Delete ${pendingDelete.length} item${pendingDelete.length === 1 ? '' : 's'}`}
                  </Button>
                  <Button
                    size="small"
                    priority="secondary"
                    disabled={deleting}
                    onClick={() => setPendingDelete(null)}
                  >
                    Cancel
                  </Button>
                </Box>
              </Box>
            </SectionHelper>
          ) : null}

          <Text size="tiny" secondary>
            Row checkboxes choose items for bulk actions (shift times, delete) only. Every
            unsaved edit is included when you save, whether or not its row is checked.
          </Text>

          <TimeShiftBar
            selected={selectedRows}
            disabled={busy}
            onApply={edits.applyToRows}
          />

          <Table
            state={state}
            columns={columns}
            showSelection
            internalScroll
            stickySelectionColumn
            search={false}
            onSelectedItems={(_allSelected, items) => setSelectedRows(items)}
            topNotification={
              publishPrompt ? (
                <TableTopNotification
                  skin="premium"
                  showPrefixIcon
                  title="Saved to the draft schedule. Publish it so guests can see the changes?"
                  actionText={publishing ? 'Publishing…' : 'Publish now'}
                  actionDisabled={publishing}
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
                  actionDisabled={publishing}
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
                    label: 'Add Schedule Item',
                    onClick: () => setShowAddItems(true),
                    disabled: busy,
                  },
                ]}
              />
            }
            bulkActionToolbar={({ selectedValues, clearSelection }) => {
              clearSelectionRef.current = clearSelection;
              return (
                <MultiBulkActionToolbar
                  primaryActionItems={[
                    {
                      dataHook: 'save-changes',
                      label:
                        edits.dirtyCount > 0
                          ? `Save ${edits.dirtyCount} change${edits.dirtyCount === 1 ? '' : 's'} as draft`
                          : 'Save draft',
                      prefixIcon: <Check />,
                      disabled: busy || blocked || edits.dirtyCount === 0,
                      onClick: () => save(),
                    },
                    {
                      dataHook: 'delete-selected',
                      label: `Delete ${selectedValues.length} selected`,
                      prefixIcon: <Delete />,
                      disabled: busy,
                      onClick: () => setPendingDelete(selectedValues),
                    },
                  ]}
                />
              );
            }}
            primaryActionButton={
              <PrimaryActionButton
                onClick={save}
                disabled={busy || blocked || edits.dirtyCount === 0}
              >
                {progress
                  ? `Saving ${progress.done} of ${progress.total}…`
                  : edits.dirtyCount > 0
                    ? `Save ${edits.dirtyCount} change${edits.dirtyCount === 1 ? '' : 's'} as draft`
                    : 'Save draft'}
              </PrimaryActionButton>
            }
            emptyState={
              <CollectionEmptyState
                title="This event has no schedule items yet"
                subtitle="Add items here, or import a CSV to build the schedule in bulk."
              >
                <Box gap="SP2">
                  <Button size="small" onClick={() => setShowAddItems(true)}>
                    Add Schedule Item
                  </Button>
                  <Button size="small" priority="secondary" onClick={() => setShowImport(true)}>
                    Import CSV
                  </Button>
                </Box>
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

          <Box gap="SP4" verticalAlign="middle">
            <Box gap="SP1" verticalAlign="middle">
              <Unsaved size="16px" color={UNSAVED_ICON_COLOR} />
              <Text size="tiny" secondary>
                Unsaved changes: edited, not yet saved to the draft
              </Text>
            </Box>
            <Box gap="SP1" verticalAlign="middle">
              <Publish size="16px" color={UNPUBLISHED_ICON_COLOR} />
              <Text size="tiny" secondary>
                Unpublished changes: saved to the draft, not yet visible to guests
              </Text>
            </Box>
          </Box>
        </Box>
      </CollectionPage.Content>
    </CollectionPage>
  );
}
