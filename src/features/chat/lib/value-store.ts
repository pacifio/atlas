/** A value outside React that components subscribe to with
 *  `useSyncExternalStore`, so a change re-renders only its subscribers. */
export function createValueStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export type ValueStore<T> = ReturnType<typeof createValueStore<T>>;
