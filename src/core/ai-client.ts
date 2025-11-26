import axios from 'axios';

export type SignalPayload = Record<string, any>;

export async function scoreWithRemoteModel(payload: SignalPayload): Promise<{ lossProb: number } | null> {
  // Reads environment variables (set by runtime) to talk to remote model (Gemini or other)
  const url = process.env.GEMINI_API_URL;
  const key = process.env.GEMINI_API_KEY;

  if (!url) return null;

  // Helpful debug: log the target scoring URL so operators can see what we're calling
  // (this avoids silent 404s if the GEMINI_API_URL points to the wrong service/port)
  // eslint-disable-next-line no-console
  console.debug('[ai-client] scoring URL:', url);

  try {
    const headers: Record<string,string> = {
      'Content-Type': 'application/json'
    };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    let res;
    try {
      res = await axios.post(url, payload, { headers, timeout: 15_000 });
      // debug: log successful response body for observability
      try {
        // eslint-disable-next-line no-console
        console.debug('[ai-client] scorer response:', res?.status, res?.data);
      } catch (e) {
        // ignore
      }
    } catch (firstErr:any) {
      // If we got a 404 from the exact URL, and the configured URL doesn't end
      // with '/score', try appending '/score' as a fallback to handle users
      // configuring the base host without the path. This also helps when the
      // configured host accidentally points at another service (eg. the MT5
      // bridge) which doesn't expose '/score'. We'll log the underlying error
      // so the operator can fix the environment config.
      const status = firstErr?.response?.status;
      if (status === 404 && !url.endsWith('/score')) {
        const alt = url.replace(/\/$/, '') + '/score';
        console.debug('[ai-client] initial scoring URL 404 — retrying with', alt);
        try {
          res = await axios.post(alt, payload, { headers, timeout: 15_000 });
        } catch (err2:any) {
          console.warn('scoreWithRemoteModel failed (retry)', err2?.response?.status, err2?.response?.data ?? err2?.message ?? err2);
          return null;
        }
      } else {
        // print status + body if available — this is often 404 from the MT5 bridge
        const status = firstErr?.response?.status;
        const body = firstErr?.response?.data;
        console.warn('scoreWithRemoteModel failed', status, body ?? firstErr?.message ?? firstErr);
        return null;
      }
    }

    // Expect provider to return JSON { lossProb: number } or similar
    if (res && res.data) {
      // Log scorer response so operators can see predictions in the bot console
      try {
        // eslint-disable-next-line no-console
        console.info('[ai-client] scorer response', res.status, res.data);
      } catch (e) {
        // ignore
      }
      const d = res.data as any;
      if (typeof d.lossProb === 'number') return { lossProb: d.lossProb };
      // fall back: provider may return score or probability fields
      if (typeof d.score === 'number') return { lossProb: d.score };
    }

    return null;
  } catch (err) {
    // swallow and return null (scoring is optional)
    // eslint-disable-next-line no-console
    console.warn('scoreWithRemoteModel failed', (err as any)?.message ?? err);
    return null;
  }
}

export default { scoreWithRemoteModel };
