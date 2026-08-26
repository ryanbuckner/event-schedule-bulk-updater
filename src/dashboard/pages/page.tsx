/**
 * Dashboard page entry point.
 *
 * This file exists only to establish context: the WDS provider, the patterns
 * provider, and the global stylesheet. The page content lives in `AppGate` and
 * below, because `useTableCollection` needs the patterns provider to already be
 * above it in the tree — calling it in the same component that renders the
 * provider fails at runtime.
 */

import { WixDesignSystemProvider } from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import { withDashboard } from '@wix/patterns';
import { WixPatternsProvider } from '@wix/patterns/provider';
import React, { type FC } from 'react';
import { AppGate } from './components/AppGate';

const Index: FC = () => (
  <WixDesignSystemProvider>
    <WixPatternsProvider>
      <AppGate />
    </WixPatternsProvider>
  </WixDesignSystemProvider>
);

export default withDashboard(Index);
