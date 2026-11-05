type FetchLike = typeof fetch;

export class FetchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Fetch timed out after ${timeoutMs}ms.`);
    this.name = "FetchTimeoutError";
  }
}

export async function fetchWithTimeout(
  fetcher: FetchLike,
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new FetchTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(input, {
        ...init,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
