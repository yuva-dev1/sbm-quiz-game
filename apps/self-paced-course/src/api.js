/** Thin fetch wrappers. Every response is JSON `{ ... }` or `{ error }`. */

async function request(method, url, body) {
  // POSTs always carry a JSON body (even {}), so Google Front End never
  // 411s a bodyless request before it reaches the app.
  const response = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  if (response.status === 204) return {};
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body)
};
