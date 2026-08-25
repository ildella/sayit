// Client for the sayit sidecar REST API.
// Token resolution order: Tauri invoke → ?token= URL param → localStorage.

const BASE = 'http://127.0.0.1:7878';
let token = null;

async function resolveToken() {
  if (token) return token;
  // Inside Tauri, the Rust side hands us the token.
  if (typeof window !== 'undefined' && window.__TAURI__?.core) {
    try {
      const { invoke } = window.__TAURI__.core;
      token = await invoke('get_token');
      return token;
    } catch { /* fall through */ }
  }
  if (typeof window !== 'undefined') {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    token = fromUrl || window.localStorage.getItem('sayit-token');
    if (fromUrl) window.localStorage.setItem('sayit-token', fromUrl);
  }
  return token;
}

export function setToken(t) {
  token = t;
  if (typeof window !== 'undefined') window.localStorage.setItem('sayit-token', t);
}

async function api(method, path, body) {
  const t = await resolveToken();
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const speak = (text, opts) => api('POST', '/v1/speak', { text, ...opts });
export const pause = () => api('POST', '/v1/pause');
export const resume = () => api('POST', '/v1/resume');
export const stop = () => api('POST', '/v1/stop');
export const seek = (seconds) => api('POST', '/v1/seek', { seconds });
export const setSpeed = (speed) => api('POST', '/v1/speed', { speed });
export const getStatus = () => api('GET', '/v1/status');
export const getVoices = () => api('GET', '/v1/voices');
export const getHistory = () => api('GET', '/v1/history');
export const replay = (id) => api('POST', '/v1/history/replay', { id });
export const deleteEntry = (id) => api('DELETE', `/v1/history/${id}`);
export const getSettings = () => api('GET', '/v1/settings');
export const saveSettings = (patch) => api('POST', '/v1/settings', patch);
export const getModels = () => api('GET', '/v1/models');
export const installModel = (id, selectAfterInstall = false) =>
  api('POST', `/v1/models/${id}/install`, { selectAfterInstall });
export const cancelModelInstall = (id) => api('DELETE', `/v1/models/${id}/install`);
export const selectModel = (id) => api('POST', `/v1/models/${id}/select`);
export const removeModel = (id) => api('DELETE', `/v1/models/${id}`);

export async function openEvents(handlers) {
  const t = await resolveToken();
  // EventSource can't set headers, so pass the token as a query param…
  // — instead we use fetch + manual SSE parsing to keep the token in the header.
  const res = await fetch(`${BASE}/v1/events`, { headers: { Authorization: `Bearer ${t}` } });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (event && data) {
          try { handlers[event]?.(JSON.parse(data)); } catch { /* ignore */ }
        }
      }
    }
    handlers.closed?.();
  })();
  return () => reader.cancel();
}
