/**
 * CSV import: pick a file, review exactly what will change, then commit.
 *
 * Import is a sync, not a replace — items missing from the file are deleted —
 * so the diff is shown and confirmed before anything is written. The counts and
 * the names of items to be deleted are both on screen, because a silent bulk
 * delete is the worst thing this app could do.
 */

import { dashboard } from '@wix/dashboard';
import { Box, Button, Card, SectionHelper, Text, TextButton } from '@wix/design-system';
import React, { useState } from 'react';
import { getSchedule, saveSchedule } from '../../../backend/api/schedule.web';
import {
  CsvFormatError,
  downloadCsv,
  IMPORT_TEMPLATE_FILENAME,
  planImport,
  templateCsv,
} from '../../../lib/csv';
import { errorMessage } from '../../../lib/errors';
import type { ImportPlan, RowResult } from '../../../lib/types';

const COMMIT_CHUNK = 10;

export function ImportPanel({
  eventId,
  onClose,
  onApplied,
}: {
  eventId: string;
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [failures, setFailures] = useState<RowResult[]>([]);

  const readFile = async (file: File) => {
    setFormatError(null);
    setPlan(null);
    setFailures([]);
    setFileName(file.name);
    setPlanning(true);
    try {
      const text = await file.text();
      // Diff against a fresh read, not the grid's snapshot: this plan decides
      // what gets DELETED, and an item added since page load must not be
      // deleted just because it isn't in the file.
      const { rows } = await getSchedule(eventId);
      setPlan(planImport(text, rows));
    } catch (error) {
      setFormatError(
        error instanceof CsvFormatError
          ? error.message
          : errorMessage(error, "That file couldn't be read as CSV."),
      );
    } finally {
      setPlanning(false);
    }
  };

  const commit = async () => {
    if (!plan || plan.errors.length > 0) return;
    setCommitting(true);
    setFailures([]);

    const results: RowResult[] = [];
    try {
      // Updates and creates first, deletes last: if something fails, the file's
      // content has already landed and nothing has been destroyed yet.
      for (let i = 0; i < plan.updates.length; i += COMMIT_CHUNK) {
        const chunk = plan.updates.slice(i, i + COMMIT_CHUNK).map((update) => ({
          id: update.row.id,
          fields: update.fields,
          next: update.row,
        }));
        results.push(...(await saveSchedule(eventId, { updates: chunk })).results);
      }
      for (let i = 0; i < plan.creates.length; i += COMMIT_CHUNK) {
        const chunk = plan.creates.slice(i, i + COMMIT_CHUNK);
        results.push(...(await saveSchedule(eventId, { creates: chunk })).results);
      }
      if (plan.deletes.length > 0) {
        results.push(...(await saveSchedule(eventId, { deletes: plan.deletes })).results);
      }
    } catch (error) {
      dashboard.showToast({
        message: errorMessage(error, 'The import could not be completed.'),
        type: 'error',
      });
      setCommitting(false);
      return;
    }

    const failed = results.filter((r) => !r.ok);
    setFailures(failed);
    setCommitting(false);

    if (failed.length === 0) {
      dashboard.showToast({
        message: `Imported ${results.length} change${results.length === 1 ? '' : 's'} into the draft schedule.`,
        type: 'success',
      });
      await onApplied();
    } else {
      dashboard.showToast({
        message: `${results.length - failed.length} applied, ${failed.length} failed.`,
        type: 'error',
      });
    }
  };

  const total = plan ? plan.updates.length + plan.creates.length + plan.deletes.length : 0;

  return (
    <Card>
      <Card.Header
        title="Import a CSV"
        subtitle="Rows with an ID update that item. Rows without one are added. Items missing from the file are deleted."
        suffix={
          <TextButton size="small" onClick={onClose} disabled={committing}>
            Close
          </TextButton>
        }
      />
      <Card.Content>
        <Box direction="vertical" gap="SP3">
          <Box direction="vertical" gap="SP1">
            <Text size="small">
              Keep a row's ID to update that item, or leave the ID blank to add a new one. Any
              item not in the file is deleted from the draft, so start from a full export if
              you're only changing a few rows.
            </Text>
            <Text size="small">
              Start Date, Start Time, End Date, and End Time are read as local wall-clock values
              in that row's own Time Zone column, not UTC. Separate multiple tags with a
              semicolon (;).
            </Text>
            <TextButton
              size="small"
              onClick={() => downloadCsv(templateCsv(), IMPORT_TEMPLATE_FILENAME)}
            >
              Download a template
            </TextButton>
          </Box>

          <input
            type="file"
            accept=".csv,text/csv"
            disabled={committing || planning}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />

          {planning ? (
            <Text size="small" secondary>
              Checking the file against the current schedule…
            </Text>
          ) : null}

          {formatError ? (
            <SectionHelper appearance="danger" title="That file can't be used">
              <Text size="small">{formatError}</Text>
            </SectionHelper>
          ) : null}

          {plan && plan.errors.length > 0 ? (
            <SectionHelper
              appearance="danger"
              title={`${plan.errors.length} problem${plan.errors.length === 1 ? '' : 's'} in ${fileName ?? 'the file'} — nothing has been imported`}
            >
              <Box direction="vertical" gap="SP1">
                {plan.errors.slice(0, 20).map((error, index) => (
                  <Text key={`${error.rowId}-${index}`} size="small">
                    {error.message}
                  </Text>
                ))}
                {plan.errors.length > 20 ? (
                  <Text size="tiny" secondary>
                    …and {plan.errors.length - 20} more.
                  </Text>
                ) : null}
              </Box>
            </SectionHelper>
          ) : null}

          {plan && plan.errors.length === 0 ? (
            <Box direction="vertical" gap="SP2">
              <Text size="small" weight="bold">
                {total === 0
                  ? 'This file matches the current schedule — nothing to change.'
                  : `Ready to apply ${total} change${total === 1 ? '' : 's'}:`}
              </Text>
              <Text size="small">
                {plan.updates.length} updated · {plan.creates.length} added ·{' '}
                {plan.deletes.length} deleted
              </Text>

              {plan.deletes.length > 0 ? (
                <SectionHelper
                  appearance="warning"
                  title={`${plan.deletes.length} item${plan.deletes.length === 1 ? '' : 's'} will be deleted`}
                >
                  <Box direction="vertical" gap="SP1">
                    <Text size="small">
                      These items aren't in the file, so importing will remove them:
                    </Text>
                    <Text size="small">
                      {plan.deletes.map((entry) => entry.name || entry.id).join(', ')}
                    </Text>
                  </Box>
                </SectionHelper>
              ) : null}

              {failures.length > 0 ? (
                <SectionHelper
                  appearance="danger"
                  title={`${failures.length} change${failures.length === 1 ? '' : 's'} failed`}
                >
                  <Box direction="vertical" gap="SP1">
                    {failures.map((failure) => (
                      <Text key={`${failure.operation}-${failure.rowId}`} size="small">
                        <b>{failure.name || failure.rowId}:</b> {failure.error}
                      </Text>
                    ))}
                  </Box>
                </SectionHelper>
              ) : null}

              <Box gap="SP2">
                <Button
                  size="small"
                  skin={plan.deletes.length > 0 ? 'destructive' : 'standard'}
                  disabled={committing || total === 0}
                  onClick={commit}
                >
                  {committing ? 'Importing…' : `Apply ${total} change${total === 1 ? '' : 's'}`}
                </Button>
                <Button size="small" priority="secondary" onClick={onClose} disabled={committing}>
                  Cancel
                </Button>
              </Box>
            </Box>
          ) : null}
        </Box>
      </Card.Content>
    </Card>
  );
}
