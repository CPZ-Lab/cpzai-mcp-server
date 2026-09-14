import type { ApiResult } from './api-client.js';

/** Preserve the API envelope for clients that consume JSON and older text clients. */
export function formatResult(result: Pick<ApiResult, 'ok' | 'status' | 'data'>) {
  const structuredContent = result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : { data: result.data };
  const text = JSON.stringify(structuredContent, null, 2);
  return {
    content: [{ type: 'text' as const, text: result.ok ? text : `Error (${result.status}): ${text}` }],
    structuredContent,
    ...(result.ok ? {} : { isError: true }),
  };
}

export function invalidArguments(message: string) {
  return formatResult({ ok: false, status: 400, data: { error: message, code: 'invalid_arguments' } });
}
