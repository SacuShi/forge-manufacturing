import { useMemo, useRef } from 'react';

/**
 * Guard against stale responses. Call `begin()` when a request starts and keep the id it returns; after every
 * `await` check `isCurrent(id)` and drop the result if a newer request has begun since. (`current()` reads the
 * latest id without starting a new one, for follow-up requests such as "load more" that belong to the current
 * generation.) The returned object is stable across renders, so it is safe in dependency lists.
 */
export function useLatestRequest() {
  const latest = useRef(0);
  return useMemo(() => ({
    begin: () => ++latest.current,
    current: () => latest.current,
    isCurrent: (id: number) => id === latest.current,
  }), []);
}
