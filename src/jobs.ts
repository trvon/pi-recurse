type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JobKind = "llm_query" | "llm_query_batched" | "rlm_query";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** Most jobs one session may hold (running or finished but not yet collected). */
export const MAX_JOBS = 64;

interface Job {
  id: string;
  kind: JobKind;
  label: string;
  started: number;
  finished?: number;
  status: JobStatus;
  result?: Json;
  error?: string;
  controller: AbortController;
  settled: Promise<void>;
}

export interface JobView {
  job: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  /** Run time for finished jobs, time so far for running ones. */
  elapsed_ms: number;
  result?: Json;
  error?: string;
}

export interface WaitResult {
  done: JobView[];
  pending: JobView[];
}

/**
 * Background worker calls for one session. A started job keeps running after the tool call that
 * started it returns; `wait` hands finished jobs back once and forgets them. Jobs never outlive
 * their session: `dispose` cancels whatever is still running.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private next = 1;
  private disposed = false;

  constructor(private readonly prefix = "j") {}

  start(kind: JobKind, label: string, run: (signal: AbortSignal) => Promise<Json>): string {
    if (this.disposed) throw new Error("session ended; background jobs are unavailable");
    if (this.jobs.size >= MAX_JOBS) {
      throw new Error(`${MAX_JOBS} background jobs are already running or uncollected; collect them with rlm_wait or cancel them with rlm_jobs`);
    }
    const id = `${this.prefix}${this.next++}`;
    const controller = new AbortController();
    const job: Job = { id, kind, label, started: performance.now(), status: "running", controller, settled: Promise.resolve() };
    job.settled = run(controller.signal).then(
      (result) => {
        if (job.status === "running") Object.assign(job, { status: "done", result });
      },
      (e: unknown) => {
        if (job.status === "running") Object.assign(job, { status: controller.signal.aborted ? "cancelled" : "failed", error: errorText(e) });
      },
    ).finally(() => {
      job.finished ??= performance.now();
    });
    this.jobs.set(id, job);
    return id;
  }

  /** Jobs still running. */
  get running(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === "running") n++;
    return n;
  }

  /** Jobs running or finished but not collected. */
  get size(): number {
    return this.jobs.size;
  }

  /** Status of every job this session holds, without collecting any. */
  list(): JobView[] {
    return [...this.jobs.values()].map((j) => view(j, false));
  }

  /**
   * Wait until the given jobs (default: all) are finished, or until any one is with `any`, or until
   * `timeoutMs`. Finished jobs are returned with their results and forgotten; the rest are listed
   * as pending and keep running. Aborting the wait does not cancel the jobs.
   */
  async wait(ids: string[] | undefined, options: { timeoutMs: number; any?: boolean; signal?: AbortSignal }): Promise<WaitResult> {
    const wanted = ids ?? [...this.jobs.keys()];
    const unknown = wanted.filter((id) => !this.jobs.has(id));
    if (unknown.length) throw new Error(`unknown or already collected job${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    const jobs = wanted.map((id) => this.jobs.get(id) as Job);
    const running = jobs.filter((j) => j.status === "running");
    if (running.length && !(options.any && running.length < jobs.length)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stop = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.timeoutMs);
        onAbort = resolve;
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      const settled = running.map((j) => j.settled);
      try {
        await Promise.race([options.any ? Promise.race(settled) : Promise.all(settled), stop]);
      } finally {
        clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    }
    const done: JobView[] = [];
    const pending: JobView[] = [];
    for (const j of jobs) {
      if (j.status === "running") pending.push(view(j, false));
      else {
        done.push(view(j, true));
        this.jobs.delete(j.id);
      }
    }
    return { done, pending };
  }

  /** Cancel running jobs; finished ones are left for rlm_wait. Returns the ids that were cancelled. */
  cancel(ids: string[]): string[] {
    const cancelled: string[] = [];
    for (const id of ids) {
      const j = this.jobs.get(id);
      if (!j || j.status !== "running") continue;
      j.status = "cancelled";
      j.error = "cancelled";
      j.finished = performance.now();
      j.controller.abort();
      cancelled.push(id);
    }
    return cancelled;
  }

  /** Cancel everything and refuse new jobs: the session is over. */
  dispose(): void {
    this.disposed = true;
    this.cancel([...this.jobs.keys()]);
    this.jobs.clear();
  }
}

function view(j: Job, withResult: boolean): JobView {
  const v: JobView = { job: j.id, kind: j.kind, label: j.label, status: j.status, elapsed_ms: Math.round((j.finished ?? performance.now()) - j.started) };
  if (withResult && j.result !== undefined) v.result = j.result;
  if (j.error !== undefined) v.error = j.error;
  return v;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
