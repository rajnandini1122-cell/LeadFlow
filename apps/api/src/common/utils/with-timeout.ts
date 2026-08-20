/**
 * Resolves to `fallback` if `work` has not settled within `ms`.
 *
 * Used by the readiness probe. A dependency check that can hang is worse than
 * one that reports failure: an orchestrator waiting on a never-resolving probe
 * holds the instance in limbo instead of restarting it or routing around it.
 * Client-level timeouts are not sufficient on their own — a socket stuck
 * mid-reconnect may never invoke them — so the probe enforces its own bound.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
