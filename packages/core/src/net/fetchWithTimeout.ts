/**
 * fetch with an AbortController deadline; the timer clears in a finally so
 * neither success nor throw leaks it. The deadline covers the headers — guard
 * the body read separately where a stalled body matters (see traces.ts).
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
