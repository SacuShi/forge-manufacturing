/**
 * FORGE v1.0 — API client
 *
 * Thin, typed fetch wrappers for the FORGE backend and ESI.
 * All authenticated calls add the EVE access token as a Bearer header.
 *
 * Security:
 *   - Tokens are passed in Authorization headers, never in query strings.
 *   - All responses are checked for non-OK status before parsing JSON.
 *   - No eval, no dangerouslySetInnerHTML anywhere in this module.
 */

const ESI_BASE = 'https://esi.evetech.net/latest';

// ── Generic fetch helpers ────────────────────────────────────────────────────

/**
 * Basic fetch wrapper — returns the raw Response so callers can inspect
 * status codes and parse the body themselves.
 */
export async function apiFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

// ── FORGE backend ────────────────────────────────────────────────────────────

/** GET from the FORGE backend (optionally authenticated) */
export async function apiGet<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { headers });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('forge:session-expired'));
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** POST to the FORGE backend (optionally authenticated) */
export async function apiPost<T>(
  path: string,
  body: unknown,
  token?: string
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('forge:session-expired'));
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── EVE Swagger Interface (ESI) ──────────────────────────────────────────────

/**
 * Paginated ESI fetch.
 * Reads the x-pages response header and fetches all pages in parallel,
 * then flattens the results into a single array.
 */
export async function esiFetchAll<T>(path: string, token: string): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${ESI_BASE}${path}${separator}datasource=tranquility`;
  const headers = { Authorization: `Bearer ${token}` };

  const firstRes = await fetch(url, { headers });
  if (!firstRes.ok) {
    throw new Error(`ESI ${firstRes.status}: ${path}`);
  }

  const pages     = parseInt(firstRes.headers.get('x-pages') ?? '1', 10);
  const firstPage = (await firstRes.json()) as T[];

  if (pages <= 1) return firstPage;

  const remaining = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      fetch(`${url}&page=${i + 2}`, { headers })
        .then((r) => {
          if (!r.ok) throw new Error(`ESI page ${i + 2} error: ${r.status}`);
          return r.json() as Promise<T[]>;
        })
    )
  );

  return [firstPage, ...remaining].flat();
}

/**
 * Single (non-paginated) ESI GET.
 * Token is optional for public endpoints.
 */
export async function esiGet<T>(path: string, token?: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${ESI_BASE}${path}${separator}datasource=tranquility`;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`ESI ${res.status}: ${path}`);
  }
  return res.json() as Promise<T>;
}
