/**
 * Promise chain that runs tasks one at a time so one action and its follow-up
 * observation cannot interleave with another.
 * @module @deepseek-ai/dsh-tool-browser/queue
 */

/**
 * Serialize asynchronous work through one tail.
 * @returns a `run` function that starts the next task only after the previous one settles.
 */
/* jscpd:ignore-start -- browser per-tab serialization is independent of computer input serialization. */
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

/**
 * Per-key serial queues, used to serialize browser work per tab.
 * @returns a `run` function keyed by tab id.
 */
export function createKeyedSerialQueue(): {
  run<T>(key: string, task: () => Promise<T>): Promise<T>
} {
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const existing = queues.get(key)
      const queue = existing ?? createSerialQueue()
      if (existing === undefined) queues.set(key, queue)
      return queue.run(task)
    },
  }
}
