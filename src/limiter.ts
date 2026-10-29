/** Runs at most `limit` tasks at once; the rest wait in FIFO order. */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal?.reason);
        };
        this.waiting.push(resume);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      // Hand the occupied slot directly to the next waiter; a newcomer cannot steal it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
