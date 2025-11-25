/**
 * Safe error formatter helper.
 * Accepts unknown and returns a readable string (prefer message, response.data, JSON).
 */
export function formatError(err: unknown): string {
  if (err === null || typeof err === 'undefined') return String(err);
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;

  try {
    const a = err as any;
    if (a?.response?.data) return typeof a.response.data === 'string' ? a.response.data : JSON.stringify(a.response.data);
    if (a?.message) return String(a.message);
    return JSON.stringify(a);
  } catch (e) {
    try { return String(err); } catch { return 'unknown error'; }
  }
}

export default formatError;
