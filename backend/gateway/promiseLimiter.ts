/**
 * Minimal promise-concurrency limiter (p-limit shape, no dependency).
 *
 * Shared by the film render coordinator (image/video generation fan-out) and
 * the media transcode executor (parallel ffmpeg pipelines contend for CPU).
 *
 * @param concurrency - Maximum number of tasks running at once (>= 1).
 * @returns A function that schedules a task and resolves with its result.
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolveWait) => queue.push(resolveWait));
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };
}
