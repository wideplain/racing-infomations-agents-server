export class QueueFullError extends Error {
  constructor() {
    super("Analysis queue is full");
    this.name = "QueueFullError";
  }
}

/**
 * Serial task queue: exactly one task runs at a time. Enqueuing beyond
 * `maxPending` waiting tasks (not counting the currently running one)
 * throws QueueFullError synchronously so callers can respond 429.
 */
export class SerialQueue {
  private pending: Array<() => void> = [];
  private running = false;
  private readonly maxPending: number;

  constructor(maxPending = 5) {
    this.maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get maxPendingCount(): number {
    return this.maxPending;
  }

  /**
   * Throws QueueFullError synchronously (before returning a promise) when
   * the waiting list is already at capacity, so callers can respond 429
   * without waiting for the task to run.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxPending) {
      throw new QueueFullError();
    }
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running = true;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running = false;
            this.next();
          });
      };
      if (!this.running) {
        run();
      } else {
        this.pending.push(run);
      }
    });
  }

  private next(): void {
    const run = this.pending.shift();
    if (run) run();
  }
}
