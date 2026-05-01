// HTTP client for the Cursed Pact backend (your home server, fronted by
// cloudflared). Replaces the Firebase Auth + Firebase Realtime Database
// build storage that we previously used for accounts. Multiplayer rooms
// still use Firebase — see firebase.js.
//
// MGMT_API_BASE is hard-coded here so the static site (layerborn.github.io)
// can find the backend. Cloudflare's free trial tunnel rotates URLs on
// restart — when that happens, update MGMT_API_BASE and push to GitHub.
// This is the same pattern as the Layerborn storefront.
export const MGMT_API_BASE = "https://controlled-results-referral-finances.trycloudflare.com";

const TOKEN_STORAGE = "cp_token_v1";
const USER_STORAGE = "cp_user_v1";

let _token = null;
let _user = null;
const listeners = [];

// ─────────────── Hydrate from localStorage ───────────────
try {
  _token = localStorage.getItem(TOKEN_STORAGE);
  const u = localStorage.getItem(USER_STORAGE);
  if (u) _user = JSON.parse(u);
} catch {}

function persist() {
  try {
    if (_token) localStorage.setItem(TOKEN_STORAGE, _token);
    else localStorage.removeItem(TOKEN_STORAGE);
    if (_user) localStorage.setItem(USER_STORAGE, JSON.stringify(_user));
    else localStorage.removeItem(USER_STORAGE);
  } catch {}
}

function notify() {
  for (const cb of listeners) {
    try { cb(_user); } catch (e) { console.warn(e); }
  }
}

export function onCpAuthChange(cb) {
  listeners.push(cb);
  cb(_user);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function cpToken() { return _token; }
export function cpUser() { return _user; }
export function cpIsSignedIn() { return Boolean(_token && _user); }

// ─────────────── Fetch wrapper ───────────────
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && _token) headers["Authorization"] = `Bearer ${_token}`;
  let res;
  try {
    res = await fetch(MGMT_API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error("Server unreachable. Check your connection (and that the host server is up).");
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    // Auto-clear stale token on 401.
    if (res.status === 401 && _token) {
      _token = null; _user = null; persist(); notify();
    }
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// ─────────────── Auth ───────────────
export async function cpSignUp({ email, password, displayName }) {
  const data = await api("/api/cp/auth/signup", {
    method: "POST",
    auth: false,
    body: { email, password, displayName },
  });
  _token = data.token;
  _user = data.user;
  persist();
  notify();
  return data.user;
}

export async function cpSignIn({ email, password }) {
  const data = await api("/api/cp/auth/signin", {
    method: "POST",
    auth: false,
    body: { email, password },
  });
  _token = data.token;
  _user = data.user;
  persist();
  notify();
  return data.user;
}

export async function cpSignOut() {
  _token = null;
  _user = null;
  persist();
  notify();
}

export async function cpRefreshMe() {
  if (!_token) return null;
  try {
    const data = await api("/api/cp/auth/me");
    _user = data.user;
    persist();
    notify();
    return _user;
  } catch (err) {
    // Token rejected → already cleared by api()
    return null;
  }
}

// ─────────────── Builds CRUD ───────────────
export async function cpListBuilds() {
  if (!_token) return [];
  const data = await api("/api/cp/builds");
  return data.builds || [];
}

export async function cpGetBuild(buildId) {
  const data = await api(`/api/cp/builds/${encodeURIComponent(buildId)}`);
  return data.build || null;
}

export async function cpSaveBuild(build, buildId = null) {
  // The backend accepts arbitrary character JSON in `data` plus name/grade.
  // It limits the blob to 12 KB and 50 builds per account.
  const path = buildId
    ? `/api/cp/builds/${encodeURIComponent(buildId)}`
    : "/api/cp/builds";
  const method = buildId ? "PUT" : "POST";
  const data = await api(path, { method, body: build });
  return data.build;
}

export async function cpDeleteBuild(buildId) {
  await api(`/api/cp/builds/${encodeURIComponent(buildId)}`, { method: "DELETE" });
}

// ─────────────── Health / connectivity ───────────────
export async function cpHealthCheck() {
  try {
    const data = await api("/api/cp/health", { auth: false });
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}
