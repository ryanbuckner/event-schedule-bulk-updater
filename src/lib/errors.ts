/**
 * Extracts a human-readable message from a caught value.
 *
 * Deliberately not `error instanceof Error`: web-method errors thrown on the
 * backend cross a serialization boundary and arrive on the client as plain
 * objects with the same shape (`name`, `message`, `stack`) but a different
 * prototype chain, so `instanceof Error` is false for them even though
 * `.message` holds the real, specific backend error text. Duck-typing on
 * `.message` catches those too, instead of silently falling back to a
 * generic message.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string' &&
    (error as { message: string }).message
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}
