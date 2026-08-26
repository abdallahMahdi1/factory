const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000/api";

function getToken() {
  return localStorage.getItem("ft_token");
}
export function setToken(token, username) {
  if (token) {
    localStorage.setItem("ft_token", token);
    localStorage.setItem("ft_username", username || "");
  } else {
    localStorage.removeItem("ft_token");
    localStorage.removeItem("ft_username");
  }
}
export function getUsername() {
  return localStorage.getItem("ft_username") || "";
}
export function isLoggedIn() {
  return !!getToken();
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    setToken(null);
    window.location.href = "/login";
    throw new Error("Session expired");
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),

  machines: {
    list: () => request("/machines"),
    get: (id) => request(`/machines/${id}`),
    create: (data) => request("/machines", { method: "POST", body: data }),
    update: (id, data) => request(`/machines/${id}`, { method: "PUT", body: data }),
    remove: (id) => request(`/machines/${id}`, { method: "DELETE" }),
    regenerateKey: (id) => request(`/machines/${id}/regenerate-key`, { method: "POST" }),
    addField: (id, data) => request(`/machines/${id}/fields`, { method: "POST", body: data }),
    updateField: (id, fieldId, data) => request(`/machines/${id}/fields/${fieldId}`, { method: "PUT", body: data }),
    removeField: (id, fieldId) => request(`/machines/${id}/fields/${fieldId}`, { method: "DELETE" }),
    // Replaces this machine's ENTIRE field set in one call — used by the
    // "Import from sheet" flow and by any bulk reorder/regroup edit in the
    // admin UI, so a 30-field machine doesn't need 30 separate requests.
    setFields: (id, fields) => request(`/machines/${id}/fields`, { method: "PUT", body: { fields } }),

    workOrders: {
      list: (machineId, status) => request(`/machines/${machineId}/work-orders${status ? `?status=${status}` : ""}`),
      create: (machineId, data) => request(`/machines/${machineId}/work-orders`, { method: "POST", body: data }),
      update: (machineId, id, data) => request(`/machines/${machineId}/work-orders/${id}`, { method: "PUT", body: data }),
      remove: (machineId, id) => request(`/machines/${machineId}/work-orders/${id}`, { method: "DELETE" }),
      reorder: (machineId, orderedIds) => request(`/machines/${machineId}/work-orders/reorder`, { method: "PUT", body: { orderedIds } }),
      bulkCreate: (machineId, workOrders) => request(`/machines/${machineId}/work-orders/bulk`, { method: "POST", body: { workOrders } }),
    },
  },

  optionLists: {
    list: () => request("/option-lists"),
    create: (name) => request("/option-lists", { method: "POST", body: { name } }),
    remove: (id) => request(`/option-lists/${id}`, { method: "DELETE" }),
    addItem: (id, value) => request(`/option-lists/${id}/items`, { method: "POST", body: { value } }),
    removeItem: (id, itemId) => request(`/option-lists/${id}/items/${itemId}`, { method: "DELETE" }),
  },

  operators: {
    list: () => request("/operators"),
    create: (data) => request("/operators", { method: "POST", body: data }),
    update: (id, data) => request(`/operators/${id}`, { method: "PUT", body: data }),
    remove: (id) => request(`/operators/${id}`, { method: "DELETE" }),
    setMachines: (id, machineIds) => request(`/operators/${id}/machines`, { method: "PUT", body: { machineIds } }),
  },

  pauseReasons: {
    list: () => request("/pause-reasons"),
    create: (label, code) => request("/pause-reasons", { method: "POST", body: { label, code } }),
    update: (id, data) => request(`/pause-reasons/${id}`, { method: "PUT", body: data }),
    remove: (id) => request(`/pause-reasons/${id}`, { method: "DELETE" }),
  },
  stopReasons: {
    list: () => request("/stop-reasons"),
    create: (label, code) => request("/stop-reasons", { method: "POST", body: { label, code } }),
    update: (id, data) => request(`/stop-reasons/${id}`, { method: "PUT", body: data }),
    remove: (id) => request(`/stop-reasons/${id}`, { method: "DELETE" }),
  },

  sessions: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/sessions${qs ? `?${qs}` : ""}`);
    },
    get: (id) => request(`/sessions/${id}`),
    update: (id, data) => request(`/sessions/${id}`, { method: "PUT", body: data }),
    // CSV export needs the admin's auth header, which a plain <a href> can't
    // send — so this fetches the file as a blob and triggers the browser's
    // save dialog manually, rather than linking straight to the endpoint.
    exportCsv: async (machineId, params = {}) => {
      const qs = new URLSearchParams({ machineId, ...params }).toString();
      const token = getToken();
      const res = await fetch(`${API_BASE}/sessions/export.csv?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : "production-report.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  },

  dashboard: {
    status: () => request("/dashboard/status"),
  },
};
