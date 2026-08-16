import { describe, it, expect } from "vitest";
import { SerialQueue, QueueFullError } from "../src/analysis/queue.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SerialQueue", () => {
  it("runs tasks one at a time even when enqueued concurrently", async () => {
    const queue = new SerialQueue(5);
    const order: number[] = [];
    let running = 0;
    let maxConcurrent = 0;

    const makeTask = (id: number) => async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      order.push(id);
      running--;
      return id;
    };

    const results = await Promise.all([
      queue.enqueue(makeTask(1)),
      queue.enqueue(makeTask(2)),
      queue.enqueue(makeTask(3)),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("throws QueueFullError once pending exceeds maxPending", async () => {
    const queue = new SerialQueue(2);
    const blockers = [deferred<void>(), deferred<void>(), deferred<void>()];

    // First task starts running immediately; next two sit in the pending queue.
    const p0 = queue.enqueue(() => blockers[0].promise);
    const p1 = queue.enqueue(() => blockers[1].promise);
    const p2 = queue.enqueue(() => blockers[2].promise);

    expect(() => queue.enqueue(async () => "overflow")).toThrow(
      QueueFullError
    );

    blockers[0].resolve();
    blockers[1].resolve();
    blockers[2].resolve();
    await Promise.all([p0, p1, p2]);
  });
});
