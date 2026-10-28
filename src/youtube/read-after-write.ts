/**
 * YouTube list-by-id can briefly return nothing right after a resource is created.
 * Retry ONLY while the item is missing; an item that exists but belongs to another
 * channel is returned immediately so the caller's ownership check can reject it.
 */
const backoffMs = [500, 1000, 2000, 4000] as const;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep: Sleep = realSleep;

/** Test hook: replace the delay (pass undefined to restore the real timer). */
export function setReadAfterWriteSleep(next?: Sleep): void {
  sleep = next ?? realSleep;
}

export async function retryWhileMissing<T>(read: () => Promise<T | null | undefined>, isMissing: (value: T | null | undefined) => boolean = (value) => value === undefined || value === null): Promise<T | null | undefined> {
  let value = await read();
  for (const delay of backoffMs) {
    if (!isMissing(value)) return value;
    await sleep(delay);
    value = await read();
  }
  return value;
}
