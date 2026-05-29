/**
 * Races a promise against a timeout, rejecting with `message` if it does not
 * settle within `timeoutMs`. The timer is always cleared, so a resolved promise
 * never leaves a dangling timeout armed.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
