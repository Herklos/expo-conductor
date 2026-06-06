/**
 * Task registry (Web / reference implementation).
 *
 * Mirrors `Registry.kt` (SharedPreferences) and `Registry.swift` (UserDefaults).
 * Persists to `localStorage` when available, otherwise stays in-memory so it also
 * works under Node/SSR and tests.
 */
import type { RegisteredTask } from '../../ExpoConductor.types';

const STORAGE_KEY = 'expo-conductor:tasks';

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Accessing localStorage can throw in some sandboxes.
  }
  return null;
}

export class TaskRegistry {
  private tasks = new Map<string, RegisteredTask>();
  private storage = getStorage();

  constructor() {
    this.load();
  }

  private load(): void {
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as RegisteredTask[];
      for (const task of parsed) this.tasks.set(task.id, task);
    } catch {
      // Corrupt persisted data — start fresh rather than crash.
    }
  }

  private persist(): void {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.tasks.values()]));
  }

  upsert(task: RegisteredTask): void {
    this.tasks.set(task.id, task);
    this.persist();
  }

  remove(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) this.persist();
    return existed;
  }

  get(id: string): RegisteredTask | undefined {
    return this.tasks.get(id);
  }

  all(): RegisteredTask[] {
    return [...this.tasks.values()];
  }

  clear(): void {
    this.tasks.clear();
    this.persist();
  }
}
