/**
 * Decides what the page shows: the event picker or the editor, and whether
 * writing is unlocked.
 *
 * The purchase check runs on the server (see billing.web.ts) because the
 * underlying Wix call authenticates as the app, and because an entitlement
 * decided in the browser is one that can be edited away in devtools. The grid
 * enforces it for feedback; the backend enforces it for real.
 */

import { Box, Loader, Text } from '@wix/design-system';
import React, { useCallback, useEffect, useState } from 'react';
import { getCheckoutUrl, getEntitlement } from '../../../backend/api/billing.web';
import { canWrite, type Entitlement, type EventSummary } from '../../../lib/types';
import { EventPicker } from './EventPicker';
import { ScheduleEditor } from './ScheduleEditor';
import { UpgradeBanner } from './UpgradeBanner';

export function AppGate() {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [selected, setSelected] = useState<EventSummary | null>(null);

  const check = useCallback(async () => {
    try {
      setEntitlement(await getEntitlement());
    } catch (error) {
      // Fail closed to the free tier, but say the check failed rather than
      // implying the owner hasn't paid.
      console.warn('[AppGate] Purchase check failed:', error);
      setEntitlement({ state: 'FREE', degraded: true });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const openCheckout = useCallback(async () => {
    try {
      return await getCheckoutUrl();
    } catch (error) {
      console.warn('[AppGate] Checkout URL unavailable:', error);
      return null;
    }
  }, []);

  if (!entitlement) {
    return (
      <Box align="center" verticalAlign="middle" height="60vh" direction="vertical" gap="SP2">
        <Loader size="medium" />
        <Text size="small" secondary>
          Loading…
        </Text>
      </Box>
    );
  }

  return (
    <Box direction="vertical">
      <UpgradeBanner entitlement={entitlement} onUpgrade={openCheckout} />
      {selected ? (
        <ScheduleEditor
          event={selected}
          canWrite={canWrite(entitlement)}
          onUpgrade={openCheckout}
          onChangeEvent={() => setSelected(null)}
        />
      ) : (
        <EventPicker onSelect={setSelected} />
      )}
    </Box>
  );
}
