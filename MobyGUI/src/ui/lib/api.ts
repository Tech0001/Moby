export const SESSION_EXPIRED = 'moby:session-expired';

export async function apiFetch(input: RequestInfo | URL, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  try {
    const response = await fetch(input, { ...options, signal: controller.signal });
    if (response.status === 401) {
      window.dispatchEvent(new Event(SESSION_EXPIRED));
      throw new Error('Your session expired. Please sign in again.');
    }
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
