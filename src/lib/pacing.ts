/**
 * Client-side pacing for bulk writes against the Events Schedule API.
 *
 * The API enforces a burst quota, confirmed empirically rather than assumed:
 * about 6 writes succeed, then the rest fail immediately (not a slowdown —
 * an outright rejection) until a pause lets it reset, and it's shared across
 * a batch rather than per item. Reactively recovering from tripping it is
 * expensive — with writes sequential, each item caught by the limit needs
 * its own retry-and-backoff cycle, and those compound one after another
 * (four stuck items each taking ~28s was an observed two-minute stall for a
 * single ten-item request). Sending one item per request and pausing every
 * few keeps the rate under the quota continuously, which is far cheaper,
 * and — as a side effect — gives a caller real per-item progress instead of
 * only learning the outcome once a whole multi-item request resolves.
 */

/** One item per write request, so progress can advance after every one. */
export const WRITE_CHUNK = 1;

const PACE_EVERY = 5;
const PACE_MS = 3000;

/** Call after completing the request at `index` (0-based) of `total`. */
export async function paceWrites(index: number, total: number): Promise<void> {
  const isPacePoint = (index + 1) % PACE_EVERY === 0;
  if (isPacePoint && index + 1 < total) {
    await new Promise<void>((resolve) => setTimeout(resolve, PACE_MS));
  }
}
