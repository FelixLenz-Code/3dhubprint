export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      // Required by the server's CSRF check for every non-GET request.
      ...(method !== 'GET' && { 'x-printhub-request': '1' }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}
