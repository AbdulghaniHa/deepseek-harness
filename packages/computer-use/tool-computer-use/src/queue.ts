/**
 * Promise chain that runs tasks one at a time so desktop input and its
 * follow-up observation cannot interleave on the shared keyboard and pointer.
 * @module @deepseek-ai/dsh-tool-computer-use/queue
 */

/**
 * Serialize asynchronous work through one tail.
 * @returns a `run` function that starts the next task only after the previous one settles.
 */
/* jscpd:ignore-start -- desktop input serialization is independent of browser per-tab serialization. */
export function createSerialQueue(): {
  run<T>(task: () => Promise<T>): Promise<T>
} {
  let tail: Promise<void> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task)
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}
/* jscpd:ignore-end */
