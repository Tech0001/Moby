/**
 * Fetch with timeout wrapper
 * Prevents API calls from hanging indefinitely
 */

const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  return fetch(url, {
    ...fetchOptions,
    signal: fetchOptions.signal
      ? AbortSignal.any([fetchOptions.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
}
