import axios from 'axios';

export type SignalPayload = Record<string, any>;

export async function scoreWithRemoteModel(payload: SignalPayload): Promise<{ lossProb: number } | null> {
  // Reads environment variables (set by runtime) to talk to remote model (Gemini or other)
  const url = process.env.GEMINI_API_URL;
  const key = process.env.GEMINI_API_KEY;

  if (!url) return null;

  try {
    const headers: Record<string,string> = {
      'Content-Type': 'application/json'
    };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await axios.post(url, payload, { headers, timeout: 15_000 });

    // Expect provider to return JSON { lossProb: number } or similar
    if (res && res.data) {
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
