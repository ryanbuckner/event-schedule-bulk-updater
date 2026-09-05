/**
 * Picks between the event picker and the editor for the currently selected event.
 */

import { Box, Text } from '@wix/design-system';
import React, { useState } from 'react';
import { APP_VERSION } from '../../../lib/version';
import { type EventSummary } from '../../../lib/types';
import { EventPicker } from './EventPicker';
import { ScheduleEditor } from './ScheduleEditor';

export function AppGate() {
  const [selected, setSelected] = useState<EventSummary | null>(null);

  return (
    <Box direction="vertical">
      {selected ? (
        <ScheduleEditor event={selected} onChangeEvent={() => setSelected(null)} />
      ) : (
        <EventPicker onSelect={setSelected} />
      )}
      <Box align="right" padding="SP1">
        <Text size="tiny" secondary>
          v{APP_VERSION}
        </Text>
      </Box>
    </Box>
  );
}
