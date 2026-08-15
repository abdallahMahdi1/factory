// Thin wrapper around the two calls the device ever makes to the backend.
// Kept separate from sessionManager so it's trivial to mock in tests.

async function fetchConfig({ apiBase, apiKey, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}/device/config`, {
      headers: { "X-Machine-Api-Key": apiKey },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Config fetch failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function pushEvents({ apiBase, apiKey, events, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}/device/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Machine-Api-Key": apiKey },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchConfig, pushEvents };
