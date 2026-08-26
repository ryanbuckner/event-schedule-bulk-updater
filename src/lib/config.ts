/**
 * Build-time configuration.
 *
 * These live in code rather than environment variables because this CLI version
 * has no env-var mechanism: there is no `astro.config.mjs`, `@wix/astro` isn't
 * installed, and there is no `wix env` command. Reading `import.meta.env.FOO`
 * for a custom key silently yields `undefined`.
 *
 * Neither value is a secret. The app ID is public, and the product ID is a plan
 * identifier that appears in the checkout URL the site owner is sent to.
 */

/** From wix.config.json. Used to build the post-purchase return URL. */
export const APP_ID = '8cb00406-2563-477f-b0da-ecc3a701776f';

/**
 * The Single (one-time) plan's product ID, from the app dashboard's Pricing page.
 *
 * Empty until a plan exists. While empty, the upgrade button reports a clear
 * configuration error instead of failing obscurely — the rest of the app,
 * including the whole free tier, works regardless.
 */
export const APP_PRODUCT_ID = '';
