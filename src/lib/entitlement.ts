/**
 * Purchase state for this app instance. Server-side only.
 *
 * The app is freemium by capability rather than by time: reading a schedule and
 * exporting it are free forever, and writing (save, bulk time shift, CSV import)
 * needs a one-time purchase. There is no trial clock.
 *
 * That is a deliberate consequence of how Wix billing works for a one-time
 * (Single) plan:
 *
 *  - Wix-managed free trials are recurring-plans-only. Wix's docs are explicit
 *    that apps offering single purchases "must manage their own free trials",
 *    so `billing.freeTrialInfo` is never populated for this app.
 *  - A self-managed trial needs a per-instance start date, and no such date is
 *    reachable from an app-instance token. `getAppInstance()` carries no install
 *    timestamp, and `AppInstallation.firstInstallationDate` — the one Wix-hosted
 *    answer — sits on an account-level API (`isAccountLevel: true`) that an
 *    app-instance token can't call.
 *
 * A capability split needs no dates at all, so there is nothing to persist and
 * nothing to keep in sync.
 */

import { billing } from '@wix/app-management';
import { auth } from '@wix/essentials';
import type { Entitlement } from './types';

export interface EnvFlags {
  PROD?: boolean;
  DEV?: boolean;
  MODE?: string;
  NODE_ENV?: string;
}

/** True unless the build can be positively identified as dev or test. */
export function isProductionContext(env: EnvFlags | undefined): boolean {
  if (!env) return true; // cannot prove it's a dev build, so assume production
  if (env.PROD === true) return true;
  if (env.DEV === true) return false;
  const mode = env.MODE ?? env.NODE_ENV;
  return mode !== 'development' && mode !== 'test';
}

/**
 * Resolves whether this instance has paid.
 *
 * Fails CLOSED to the free tier: if the billing check can't be completed, the
 * owner keeps every read-only capability but writes stay locked, and `degraded`
 * is set so the UI can say the check failed rather than silently implying the
 * owner needs to buy something they may already own.
 *
 * There is no override for testing the free tier, and none is needed: an
 * instance that hasn't purchased *is* the free tier, which is the state every
 * fresh install starts in.
 */
export async function resolveEntitlement(): Promise<Entitlement> {
  try {
    const elevated = auth.elevate(billing.getPurchaseHistory);
    const response = await elevated();
    // This app sells exactly one thing, so any completed purchase is that
    // purchase. The billing cycle is deliberately not checked: reconfiguring
    // the plan later must not revoke access from someone who already paid.
    const paid = (response.purchases ?? []).some((purchase) => Boolean(purchase.productId));
    return { state: paid ? 'PAID' : 'FREE', degraded: false };
  } catch (error) {
    console.warn('[entitlement] Purchase history unavailable:', error);
    return { state: 'FREE', degraded: true };
  }
}

/**
 * Builds a Wix checkout URL for the app's one-time plan.
 *
 * Single plans get no Wix-hosted pricing page, so the app links straight to
 * checkout from its own upgrade prompt. Links are valid for 48 hours, so this
 * is called on click rather than on page load.
 */
export async function createCheckoutUrl(params: {
  productId: string;
  appId: string;
  instanceId: string;
  /** When true, Wix charges 0.00. Used while the app is unpublished. */
  testCheckout?: boolean;
}): Promise<string | null> {
  try {
    const elevated = auth.elevate(billing.getUrl);
    const response = await elevated(params.productId, {
      successUrl: `https://www.wix.com/my-account/app/${params.appId}/${params.instanceId}`,
      testCheckout: params.testCheckout ?? false,
    });
    return response.checkoutUrl ?? null;
  } catch (error) {
    console.warn('[entitlement] Could not create a checkout URL:', error);
    return null;
  }
}
