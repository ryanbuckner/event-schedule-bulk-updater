/**
 * Upgrade prompt for the free tier.
 *
 * The app is never fully blocked — viewing and exporting a schedule stay free,
 * so a site owner can always get their data out. This only explains why the
 * write actions are locked, and offers the one-time purchase.
 */

import { Box, Button, Text } from '@wix/design-system';
import React, { useState } from 'react';
import type { Entitlement } from '../../../lib/types';

export function UpgradeBanner({
  entitlement,
  onUpgrade,
}: {
  entitlement: Entitlement;
  onUpgrade: () => Promise<string | null>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (entitlement.state === 'PAID') return null;

  const buy = async () => {
    setWorking(true);
    setError(null);
    const url = await onUpgrade();
    setWorking(false);
    if (url) window.open(url, '_blank', 'noopener');
    else setError("Couldn't open Wix checkout just now. Please try again in a moment.");
  };

  // A failed check must not tell someone to buy what they may already own.
  if (entitlement.degraded) {
    return (
      <Box padding="SP2" backgroundColor="Y10" align="center" direction="vertical" gap="SP1">
        <Text size="tiny">
          Couldn't confirm your purchase with Wix, so saving is locked for now. Viewing and
          exporting still work. If you've already bought this app, reload in a moment.
        </Text>
      </Box>
    );
  }

  return (
    <Box
      padding="SP2"
      backgroundColor="B10"
      align="center"
      verticalAlign="middle"
      gap="SP2"
    >
      <Text size="tiny">
        Free: view and export your schedule. Buy once to save changes, shift times in bulk,
        and import CSVs.
      </Text>
      <Button size="tiny" onClick={buy} disabled={working}>
        {working ? 'Opening checkout…' : 'Buy now'}
      </Button>
      {error ? (
        <Text size="tiny" skin="error">
          {error}
        </Text>
      ) : null}
    </Box>
  );
}
