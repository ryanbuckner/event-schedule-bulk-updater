/**
 * Bulk time shift for the checked rows.
 *
 * Deliberately not `schedule.rescheduleDraft()`. That endpoint shifts *every*
 * draft item by a *single* offset applied to *both* start and end — this needs
 * selected rows only, with start and end shiftable independently. Shifts are
 * applied to local edit state, so they flow through the same validation and the
 * same save path as hand edits.
 */

import { Box, Button, Card, NumberInput, Text } from '@wix/design-system';
import React, { useState } from 'react';
import { shiftMinutes } from '../../../lib/datetime';
import type { ScheduleRow, ScheduleRowFields } from '../../../lib/types';

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
  const [startShift, setStartShift] = useState(0);
  const [endShift, setEndShift] = useState(0);

  const count = selected.length;
  const nothingToDo = count === 0 || (startShift === 0 && endShift === 0);

  const apply = () => {
    onApply(selected, (current) => {
      const next = { ...current };
      // Each end moves independently; neither depends on the other, and no row
      // affects any other row.
      if (startShift !== 0) {
        next.start = shiftMinutes(current.start, startShift) ?? current.start;
      }
      if (endShift !== 0) {
        next.end = shiftMinutes(current.end, endShift) ?? current.end;
      }
      return next;
    });
    setStartShift(0);
    setEndShift(0);
  };

  return (
    <Card>
      <Card.Content size="medium">
        <Box gap="SP3" verticalAlign="middle">
          <Text size="small" weight="bold">
            Shift selected times
          </Text>

          <Box gap="SP1" verticalAlign="middle">
            <Text size="small" secondary>
              Start by
            </Text>
            <Box width="110px">
              <NumberInput
                size="small"
                value={startShift}
                step={5}
                suffix={<Text size="tiny" secondary>min</Text>}
                disabled={disabled}
                onChange={(value) => setStartShift(value ?? 0)}
              />
            </Box>
          </Box>

          <Box gap="SP1" verticalAlign="middle">
            <Text size="small" secondary>
              End by
            </Text>
            <Box width="110px">
              <NumberInput
                size="small"
                value={endShift}
                step={5}
                suffix={<Text size="tiny" secondary>min</Text>}
                disabled={disabled}
                onChange={(value) => setEndShift(value ?? 0)}
              />
            </Box>
          </Box>

          <Button
            size="small"
            priority="secondary"
            disabled={disabled || nothingToDo}
            onClick={apply}
          >
            Apply to {count} selected
          </Button>

          <Text size="tiny" secondary>
            Negative values move earlier. Only checked items change — items are never
            pushed by each other.
          </Text>
        </Box>
      </Card.Content>
    </Card>
  );
}
