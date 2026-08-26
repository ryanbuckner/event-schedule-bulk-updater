/**
 * Inline cell editors for the bulk grid.
 *
 * A note on dates: these use `Input` with the native `date` and `time` types
 * rather than WDS `DatePicker`/`TimeInput`. Those two exchange `Date` objects,
 * which are always interpreted in the *browser's* time zone — but a schedule
 * item carries its own `timeZoneId`, and an organizer in Denver editing a
 * London event means London wall-clock time. Passing plain `YYYY-MM-DD` and
 * `HH:MM` strings keeps the item's zone authoritative and never constructs a
 * Date in local time, so the browser's zone can't leak into stored values.
 */

import { Box, Checkbox, Input, StatusIndicator, Text } from '@wix/design-system';
import React from 'react';
import { fromInputStrings, toInputStrings } from '../../../lib/datetime';
import { LIMITS, type RowError, type ScheduleRowFields } from '../../../lib/types';

/** Field-level error message for a cell, if any. */
function errorFor(errors: RowError[] | undefined, field: string): string | undefined {
  return errors?.find((error) => error.field === field)?.message;
}

interface CellProps {
  values: ScheduleRowFields;
  errors: RowError[] | undefined;
  disabled: boolean;
}

export function NameCell({
  values,
  errors,
  disabled,
  onChange,
}: CellProps & { onChange: (value: string) => void }) {
  const message = errorFor(errors, 'name');
  return (
    <Input
      size="small"
      value={values.name}
      maxLength={LIMITS.NAME_MAX}
      placeholder="Session name"
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function TextCell({
  value,
  maxLength,
  placeholder,
  message,
  disabled,
  onChange,
}: {
  value: string;
  maxLength: number;
  placeholder: string;
  message?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      size="small"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Date + time pair for one end of the time slot.
 *
 * Both halves are edited as wall-clock strings in the item's own zone; the
 * instant is only recomputed when a valid pair exists.
 */
export function TimeSlotCell({
  iso,
  timeZoneId,
  message,
  disabled,
  onChange,
}: {
  iso: string;
  timeZoneId: string;
  message?: string;
  disabled: boolean;
  onChange: (iso: string) => void;
}) {
  const parts = toInputStrings(iso, timeZoneId) ?? { date: '', time: '' };

  const update = (date: string, time: string) => {
    const next = fromInputStrings(date, time, timeZoneId);
    // An incomplete pair (mid-typing) is ignored rather than written as an
    // invalid instant, which would show a spurious validation error.
    if (next) onChange(next);
  };

  return (
    <Box direction="vertical" gap="SP1">
      <Box gap="SP1">
        <Input
          size="small"
          type="date"
          value={parts.date}
          disabled={disabled}
          status={message ? 'error' : undefined}
          onChange={(event) => update(event.target.value, parts.time)}
        />
        <Input
          size="small"
          type="time"
          value={parts.time}
          disabled={disabled}
          status={message ? 'error' : undefined}
          onChange={(event) => update(parts.date, event.target.value)}
        />
      </Box>
      {message ? (
        <Text size="tiny" skin="error">
          {message}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Tags as a single delimited field.
 *
 * A per-row MultiSelect would be heavier than this grid can afford at ~100
 * rows, and semicolons match the delimiter used by the CSV export, so the two
 * representations stay consistent.
 */
export function TagsCell({
  values,
  errors,
  disabled,
  onChange,
}: CellProps & { onChange: (tags: string[]) => void }) {
  const message = errorFor(errors, 'tags');
  return (
    <Input
      size="small"
      value={values.tags.join('; ')}
      placeholder="tag; tag"
      status={message ? 'error' : undefined}
      statusMessage={message}
      disabled={disabled}
      onChange={(event) =>
        onChange(
          event.target.value
            .split(';')
            .map((tag) => tag.trim())
            .filter((tag) => tag !== ''),
        )
      }
    />
  );
}

export function HiddenCell({
  values,
  disabled,
  onChange,
}: Omit<CellProps, 'errors'> & { onChange: (hidden: boolean) => void }) {
  return (
    <Checkbox
      size="small"
      checked={values.hidden}
      disabled={disabled}
      tooltipContent="Hidden items don't appear in the schedule guests see."
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/** Read-only marker showing whether a row is unpublished and/or invalid. */
export function RowStatusCell({
  dirty,
  errors,
}: {
  dirty: boolean;
  errors: RowError[] | undefined;
}) {
  if (errors && errors.length > 0) {
    return (
      <StatusIndicator
        status="error"
        message={errors.map((error) => error.message).join(' ')}
      />
    );
  }
  if (dirty) {
    return <StatusIndicator status="warning" message="Unsaved change" />;
  }
  return null;
}
