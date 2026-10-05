export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await parse(res);
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  return body as T;
}

/** Mutating requests carry the X-CC marker and a same-origin Origin header. */
export async function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, payload?: unknown, extra: Record<string, string> = {}): Promise<T> {
  // A JSON content-type with no body is a 400 on the server (Fastify rejects an empty JSON body), so a bodyless request names no type.
  const hasBody = payload !== undefined;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), accept: 'application/json', 'X-CC': '1', ...extra },
    body: hasBody ? JSON.stringify(payload) : undefined,
  });
  const body = await parse(res);
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, body);
  return body as T;
}

/** Plain text (markdown, subtitles) from a GET; unlike apiGet it never tries to parse JSON. */
export async function apiGetText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, text);
  return text;
}
