/**
 * Backend API for trial and purchase state.
 *
 * Server-side because the underlying Wix calls authenticate as the app, and
 * because a paywall decided in the browser is a paywall that can be edited away
 * in devtools.
 */

import { appInstances } from '@wix/app-management';
import { auth } from '@wix/essentials';
import { Permissions, webMethod } from '@wix/web-methods';
import { APP_ID, APP_PRODUCT_ID } from '../../lib/config';
import {
  createCheckoutUrl,
  isProductionContext,
  resolveEntitlement,
} from '../../lib/entitlement';
import type { Entitlement } from '../../lib/types';

export const getEntitlement = webMethod(
  Permissions.Admin,
  (): Promise<Entitlement> => resolveEntitlement(),
);

/**
 * A fresh Wix checkout link for the one-time plan.
 *
 * Generated per click, not per page load: these links expire after 48 hours.
 * `testCheckout` is derived from the build mode rather than from anything the
 * client sends, so a 0.00 charge can never be requested in production.
 */
export const getCheckoutUrl = webMethod(
  Permissions.Admin,
  async (): Promise<string | null> => {
    if (!APP_PRODUCT_ID) {
      throw new Error(
        'No purchase plan is configured for this app yet. Set APP_PRODUCT_ID in ' +
          "src/lib/config.ts to the Single plan's product ID from the app " +
          'dashboard Pricing page.',
      );
    }

    const elevated = auth.elevate(appInstances.getAppInstance);
    const { instance } = await elevated();
    if (!instance?.instanceId) {
      throw new Error('Could not identify this app instance.');
    }

    return createCheckoutUrl({
      productId: APP_PRODUCT_ID,
      appId: APP_ID,
      instanceId: instance.instanceId,
      testCheckout: !isProductionContext(import.meta.env),
    });
  },
);
