/**
 * App-state (foreground/background) event source for the Web engine.
 *
 * Backs the `appState` trigger on web: the engine fires a task on the transition its
 * trigger names (`on: 'foreground' | 'background'`). The browser surfaces these through
 * `visibilitychange` (tab shown/hidden) — supplemented by `window` focus/blur, which also
 * cover window-manager focus changes the Page Visibility API alone can miss.
 *
 * The source is injectable so tests drive transitions deterministically and so the engine
 * stays pure under Node/SSR. {@link defaultAppStateSource} no-ops where there is no DOM.
 */

export type AppStateTransition = 'foreground' | 'background';

export interface AppStateSource {
  /** Subscribe to foreground/background transitions. Returns an unsubscribe fn. */
  subscribe(listener: (state: AppStateTransition) => void): () => void;
}

/** A source that never emits — used under Node/SSR or any runtime without a DOM. */
export const noopAppStateSource: AppStateSource = {
  subscribe: () => () => {},
};

interface DomDoc {
  hidden?: boolean;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}
interface DomWin {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

/** Wire `visibilitychange` + window focus/blur to foreground/background transitions, or
 *  no-op when there is no DOM (Node/SSR). Only emits on an ACTUAL change of state, so a
 *  focus event while already visible does not re-fire. */
export function defaultAppStateSource(): AppStateSource {
  const doc = (globalThis as { document?: DomDoc }).document;
  const win = (globalThis as { window?: DomWin }).window;
  if (!doc || typeof doc.addEventListener !== 'function') return noopAppStateSource;

  return {
    subscribe(listener) {
      // Track the last emitted state so visibilitychange and focus/blur (which overlap)
      // collapse into a single transition rather than firing twice.
      let last: AppStateTransition = doc.hidden ? 'background' : 'foreground';

      const emitForeground = () => {
        if (last === 'foreground') return;
        last = 'foreground';
        listener('foreground');
      };
      const emitBackground = () => {
        if (last === 'background') return;
        last = 'background';
        listener('background');
      };
      const onVisibility = () => (doc.hidden ? emitBackground() : emitForeground());

      doc.addEventListener('visibilitychange', onVisibility);
      win?.addEventListener('focus', emitForeground);
      win?.addEventListener('blur', emitBackground);

      return () => {
        doc.removeEventListener('visibilitychange', onVisibility);
        win?.removeEventListener('focus', emitForeground);
        win?.removeEventListener('blur', emitBackground);
      };
    },
  };
}
