/**
 * Append-only ring buffer for {@link TaskExecutionEvent}s. Used by the web engine to
 * persist lifecycle events (execute/complete/error/skipped) across page reloads so they
 * can be folded into {@link TaskExecutionRecord}s by `foldHistory()`.
 *
 * On native platforms an equivalent store lives in Kotlin (`ExecutionLogStore.kt`) and
 * Swift (`ExecutionLog.swift`) to capture headless/background events where no JS is
 * running. The three implementations hold the same JSON shape so `foldHistory()` works
 * identically on all platforms.
 *
 * Note: this is display/JS-side only — no Kotlin/Swift port and no /fixtures case.
 */
import type { TaskExecutionEvent } from '../../ExpoConductor.types';

export const EXECUTION_LOG_CAPACITY = 200;

const DEFAULT_STORAGE_KEY = '__conductor_exec_log__';

export class ExecutionLog {
  private events: TaskExecutionEvent[] = [];
  private readonly capacity: number;
  private readonly storageKey: string;

  constructor(capacity = EXECUTION_LOG_CAPACITY, storageKey = DEFAULT_STORAGE_KEY) {
    this.capacity = capacity;
    this.storageKey = storageKey;
    this.load();
  }

  /** Append a new event, dropping the oldest when over capacity. */
  append(event: TaskExecutionEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events = this.events.slice(-this.capacity);
    }
    this.persist();
  }

  /** Return all events in append order (oldest first). */
  all(): TaskExecutionEvent[] {
    return [...this.events];
  }

  /** Clear the ring buffer and its persisted copy. */
  clear(): void {
    this.events = [];
    this.persist();
  }

  private load(): void {
    try {
      const raw =
        typeof localStorage !== 'undefined' ? localStorage.getItem(this.storageKey) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this.events = parsed as TaskExecutionEvent[];
        }
      }
    } catch {
      this.events = [];
    }
  }

  private persist(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, JSON.stringify(this.events));
      }
    } catch {
      // ignore: private browsing, storage quota exceeded, etc.
    }
  }
}
