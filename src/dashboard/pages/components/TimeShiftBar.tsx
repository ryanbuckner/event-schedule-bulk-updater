/**
 * Bulk time shift for the checked rows.
 *
 * Deliberately not `schedule.rescheduleDraft()`. That endpoint shifts *every*
 * draft item by a *single* offset applied to *both* start and end — this needs
 * selected rows only, with start and end shiftable independently. Shifts are
 * applied to local edit state, so they flow through the same validation and the
 * same save path as hand edits.
 *
 * Live, not a staged "Apply" step: the shift amount always applies fresh from
 * each row's own saved (baseline) time, not from wherever it currently sits —
 * dialing "Start by" from 15 to 20 lands on baseline+20, never baseline+35.
 * That's why the change function below reads `row.start`/`row.end` (the
 * server-loaded value passed alongside `current`) instead of `current.start`/
 * `current.end` — it never compounds on top of an earlier live shift.
 *
 * Hours and minutes are just two dials on the same total: `shiftMinutes`
 * shifts the actual instant (epoch time), not the date/time strings
 * separately, so a shift that crosses midnight already rolls the calendar
 * date over correctly on its own — nothing extra to handle for that here.
 */

import { Box, Card, NumberInput, Text, TextButton } from '@wix/design-system';
import React, { useEffect, useState } from 'react';
import { shiftMinutes } from '../../../lib/datetime';
import type { ScheduleRow, ScheduleRowFields } from '../../../lib/types';

function ShiftInputs({
  hours,
  minutes,
  disabled,
  onHoursChange,
  onMinutesChange,
}: {
  hours: number;
  minutes: number;
  disabled: boolean;
  onHoursChange: (value: number) => void;
  onMinutesChange: (value: number) => void;
}) {
  return (
    <Box gap="SP1" verticalAlign="middle">
      <Box width="80px">
        <NumberInput
          size="small"
          value={hours}
          step={1}
          suffix={<Text size="tiny" secondary>hr</Text>}
          disabled={disabled}
          onChange={(value) => onHoursChange(value ?? 0)}
        />
      </Box>
      <Box width="90px">
        <NumberInput
          size="small"
          value={minutes}
          step={5}
          suffix={<Text size="tiny" secondary>min</Text>}
          disabled={disabled}
          onChange={(value) => onMinutesChange(value ?? 0)}
        />
      </Box>
    </Box>
  );
}

export function TimeShiftBar({
  selected,
  disabled,
  onApply,
}: {
  selected: ScheduleRow[];
  disabled: boolean;
  onApply: (
    rows: ScheduleRow[],
    change: (current: ScheduleRowFields, row: ScheduleRow) => ScheduleRowFields,
  ) => void;
}) {
  const [startHours, setStartHours] = useState(0);
  const [startMinutes, setStartMinutes] = useState(0);
  const [endHours, setEndHours] = useState(0);
  const [endMinutes, setEndMinutes] = useState(0);

  const startShift = startHours * 60 + startMinutes;
  const endShift = endHours * 60 + endMinutes;

  const count = selected.length;

  // A stable key instead of `selected` itself: `selected` is a fresh array
  // every render (it comes from the table's live-selection render prop), and
  // this effect's own `onApply` call triggers a parent re-render — depending
  // on the array reference directly would re-fire every render, forever.
  const selectedKey = [...selected]
    .map((row) => row.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (disabled || selected.length === 0) return;
    onApply(selected, (current, row) => ({
      ...current,
      // Recomputed from `row` (the saved value), not `current` — a 0 shift
      // correctly resets to baseline instead of leaving an earlier shift in
      // place, and repeated changes never stack.
      start: shiftMinutes(row.start, startShift) ?? current.start,
      end: shiftMinutes(row.end, endShift) ?? current.end,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedKey stands in for `selected`; see its comment.
  }, [startShift, endShift, selectedKey, disabled, onApply]);

  // This panel never unmounts (it's always visible, not conditional on
  // selection), so nothing else resets these inputs — without this, a shift
  // left dialed in from a prior selection would silently reapply the moment
  // rows are checked again.
  useEffect(() => {
    if (selected.length === 0) {
      setStartHours(0);
      setStartMinutes(0);
      setEndHours(0);
      setEndMinutes(0);
    }
  }, [selectedKey, selected.length]);

  const reset = () => {
    setStartHours(0);
    setStartMinutes(0);
    setEndHours(0);
    setEndMinutes(0);
  };

  const inputsDisabled = disabled || count === 0;
  const nothingToReset = startShift === 0 && endShift === 0;

  return (
    <Card>
      <Card.Content size="medium">
        <Box direction="vertical" gap="SP2">
          <Box gap="SP3" verticalAlign="middle">
            <Text size="small" weight="bold">
              {count === 0 ? 'Shift selected times' : `Shift ${count} selected time${count === 1 ? '' : 's'}`}
            </Text>

            <Box gap="SP1" verticalAlign="middle">
              <Text size="small" secondary>
                Start by
              </Text>
              <ShiftInputs
                hours={startHours}
                minutes={startMinutes}
                disabled={inputsDisabled}
                onHoursChange={setStartHours}
                onMinutesChange={setStartMinutes}
              />
            </Box>

            <Box gap="SP1" verticalAlign="middle">
              <Text size="small" secondary>
                End by
              </Text>
              <ShiftInputs
                hours={endHours}
                minutes={endMinutes}
                disabled={inputsDisabled}
                onHoursChange={setEndHours}
                onMinutesChange={setEndMinutes}
              />
            </Box>

            <TextButton size="small" disabled={inputsDisabled || nothingToReset} onClick={reset}>
              Reset
            </TextButton>
          </Box>

          <Text size="tiny" secondary>
            {count === 0
              ? 'Check items in the table below to shift their times.'
              : 'Times update live as you type. Negative values move earlier, and a shift past midnight moves the date too. Only checked items change — items are never pushed by each other.'}
          </Text>
        </Box>
      </Card.Content>
    </Card>
  );
}
