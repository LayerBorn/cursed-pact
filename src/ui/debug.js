// Debug panel — toggle with Ctrl+D. Shows a live snapshot of the room
// state (the same `lastRoom` the rest of the UI reads). Useful when
// something looks off in the game and you want to see what the underlying
// data actually says without opening the Firebase console.

let panelEl = null;
let lastRoomRef = null;
let isHostRef = null;
let openByDefault = false;

const STORAGE_KEY = "cp_debug_open_v1";

export function initDebugPanel() {
  // Hotkey: Ctrl+D (or Cmd+D on Mac). Don't fight the browser bookmark
  // shortcut — only toggle when our app's panel exists, otherwise let
  // the default action fire.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      toggle();
    }
  });

  // Restore previous state.
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") openByDefault = true;
  } catch {}
  if (openByDefault) ensurePanel();
}

export function setDebugContext({ room, isHost } = {}) {
  if (room) lastRoomRef = room;
  if (typeof isHost === "boolean") isHostRef = isHost;
  if (panelEl) renderPanel();
}

function toggle() {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
    try { localStorage.setItem(STORAGE_KEY, "0"); } catch {}
  } else {
    ensurePanel();
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch {}
  }
}

function ensurePanel() {
  if (panelEl) return;
  panelEl = document.createElement("div");
  panelEl.id = "cp-debug-panel";
  panelEl.innerHTML = `
    <header>
      <strong>Debug</strong>
      <span class="cp-debug-hint">Ctrl+D to close</span>
      <button class="cp-debug-close" type="button">×</button>
    </header>
    <div class="cp-debug-actions">
      <button data-action="verify" type="button">Verify state</button>
      <button data-action="copy" type="button">Copy snapshot</button>
      <button data-action="refresh" type="button">Re-render</button>
    </div>
    <div class="cp-debug-body"></div>
  `;
  document.body.appendChild(panelEl);

  panelEl.querySelector(".cp-debug-close").addEventListener("click", toggle);
  panelEl.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && target.dataset.action) {
      handleAction(target.dataset.action);
    }
  });
  renderPanel();
}

function handleAction(action) {
  if (action === "refresh") return renderPanel();
  if (action === "copy") {
    const snapshot = JSON.stringify(lastRoomRef || {}, null, 2);
    navigator.clipboard.writeText(snapshot).then(
      () => flashStatus("Copied snapshot to clipboard"),
      () => flashStatus("Copy failed — see console", true)
    );
    console.log("[debug] room snapshot:", lastRoomRef);
    return;
  }
  if (action === "verify") {
    const issues = verifyRoomInvariants(lastRoomRef);
    renderVerifyResults(issues);
    return;
  }
}

function flashStatus(msg, isErr = false) {
  const el = panelEl?.querySelector(".cp-debug-status");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3500);
}

function renderPanel() {
  if (!panelEl) return;
  const body = panelEl.querySelector(".cp-debug-body");
  const room = lastRoomRef || {};
  const cur = room.currentTurn || null;
  const players = Object.values(room.players || {});
  const curPlayer = cur ? room.players?.[cur] : null;
  const curName = curPlayer?.character?.name || curPlayer?.name || null;
  const messages = Object.values(room.messages || {})
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const recent = messages.slice(-15);
  const turnOrder = Array.isArray(room.turnOrder) ? room.turnOrder : [];

  const html = [];
  html.push(`<div class="cp-debug-section"><span class="lbl">Room</span> <code>${esc(room.host ? `host: ${room.host.slice(0, 8)}` : "?")}</code> · status: <code>${esc(room.status || "?")}</code> · tone: <code>${esc(room.dmTone || "balanced")}</code> · locked: <code>${esc(room.lockedGrade || "free")}</code></div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">isHost</span> ${isHostRef ? "<b>yes</b>" : "no"}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">currentTurn</span> ${cur ? `<code>${cur.slice(0, 12)}</code> (${esc(curName || "?")})` : "<i>(none)</i>"}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">turnOrder</span> ${turnOrder.length ? turnOrder.map(u => `<code title="${u}">${u.slice(0, 6)}</code>`).join(" → ") : "<i>(empty)</i>"}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">objective</span> ${esc(room.objective || "—")}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">actionPrompt</span> ${room.actionPrompt
    ? `<code>${esc(room.actionPrompt.optionMode || "?")}</code> for <code>${room.actionPrompt.forUid?.slice(0, 8) || "(group)"}</code> · ${(room.actionPrompt.options || []).length} options`
    : "<i>(none)</i>"}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">votes</span> ${room.votes ? Object.keys(room.votes).length : 0}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">pendingActions</span> ${room.pendingActions ? Object.keys(room.pendingActions).join(", ") : "<i>(none)</i>"}</div>`);
  html.push(`<div class="cp-debug-section"><span class="lbl">map</span> ${room.map ? `${esc(room.map.scene || "?")} · ${room.map.size?.[0] ?? "?"}×${room.map.size?.[1] ?? "?"} · ${(room.map.tokens || []).length} tokens` : "<i>(none)</i>"}</div>`);

  if (players.length) {
    html.push(`<div class="cp-debug-section"><span class="lbl">players</span></div>`);
    for (const p of players) {
      const c = p.character || {};
      const isCur = cur === p.uid;
      const abList = (c.abilities || []).map(a => `${esc(a.name)} (${a.cost})`).join(", ") || "<i>none</i>";
      html.push(`
        <div class="cp-debug-player ${isCur ? "current" : ""}">
          <div><b>${esc(c.name || p.name || "?")}</b> <code>${(p.uid || "").slice(0, 8)}</code> ${isCur ? "<span class='cur'>← current</span>" : ""}</div>
          <div class="cp-debug-meta">grade ${esc(c.grade || "?")} · HP ${c.hp ?? "?"}/${c.maxHp ?? "?"} · CE ${c.cursedEnergy ?? "?"}/${c.maxCursedEnergy ?? "?"} · XP ${c.xp ?? 0}</div>
          <div class="cp-debug-meta">stats: P${c.stats?.phys ?? "?"} T${c.stats?.tech ?? "?"} S${c.stats?.spirit ?? "?"}</div>
          <div class="cp-debug-meta">abilities: ${abList}</div>
        </div>`);
    }
  }

  html.push(`<div class="cp-debug-section"><span class="lbl">recent log (last 15)</span></div>`);
  html.push(`<div class="cp-debug-log">`);
  for (const m of recent) {
    const t = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : "";
    html.push(`<div class="cp-debug-msg ${m.type || ''}"><span class="ts">${t}</span> <span class="who">${esc(m.authorName || m.author || "?")}</span>: ${esc((m.content || "").slice(0, 120))}</div>`);
  }
  html.push(`</div>`);

  html.push(`<div class="cp-debug-status"></div>`);
  html.push(`<div class="cp-debug-verify"></div>`);
  body.innerHTML = html.join("");
}

function renderVerifyResults(issues) {
  const out = panelEl?.querySelector(".cp-debug-verify");
  if (!out) return;
  if (!issues.length) {
    out.innerHTML = `<div class="cp-debug-ok">✓ No invariant violations.</div>`;
    return;
  }
  out.innerHTML = `<div class="cp-debug-issues"><strong>${issues.length} issue${issues.length === 1 ? "" : "s"}:</strong><ul>${issues.map(i => `<li class="${i.severity}">${esc(i.text)}</li>`).join("")}</ul></div>`;
  console.warn("[debug] state verification issues:", issues);
}

// Walk the room state and report invariant violations.
export function verifyRoomInvariants(room) {
  const issues = [];
  if (!room) {
    issues.push({ severity: "warn", text: "No room state captured yet." });
    return issues;
  }
  const players = room.players || {};
  const turnOrder = Array.isArray(room.turnOrder) ? room.turnOrder : [];
  const playerIds = Object.keys(players);
  const cur = room.currentTurn || null;

  // 1. currentTurn must reference a real player (or be null).
  if (cur && !players[cur]) {
    issues.push({ severity: "err", text: `currentTurn "${cur}" is not in players.` });
  }

  // 2. Every uid in turnOrder must exist in players.
  for (const uid of turnOrder) {
    if (!players[uid]) {
      issues.push({ severity: "err", text: `turnOrder contains "${uid}" which is not in players.` });
    }
  }

  // 3. Every player should be in turnOrder (so they can take a turn).
  for (const uid of playerIds) {
    if (!turnOrder.includes(uid)) {
      issues.push({ severity: "warn", text: `player "${uid}" is missing from turnOrder.` });
    }
  }

  // 4. HP / CE within [0, max] for each player.
  for (const p of Object.values(players)) {
    const c = p.character;
    if (!c) continue;
    if (typeof c.hp === "number" && (c.hp < 0 || c.hp > (c.maxHp || 0))) {
      issues.push({ severity: "err", text: `${c.name || p.uid}: HP ${c.hp} out of [0, ${c.maxHp}].` });
    }
    if (typeof c.cursedEnergy === "number" && (c.cursedEnergy < 0 || c.cursedEnergy > (c.maxCursedEnergy || 0))) {
      issues.push({ severity: "err", text: `${c.name || p.uid}: CE ${c.cursedEnergy} out of [0, ${c.maxCursedEnergy}].` });
    }
    // 5. Each ability must have name + cost + effect.
    const abs = Array.isArray(c.abilities) ? c.abilities : [];
    abs.forEach((a, idx) => {
      if (!a || typeof a.name !== "string" || !a.name.trim()) {
        issues.push({ severity: "warn", text: `${c.name || p.uid}: ability[${idx}] missing name.` });
      }
      if (a && (typeof a.cost !== "number" || a.cost < 0)) {
        issues.push({ severity: "warn", text: `${c.name || p.uid}: ability[${idx}] cost invalid.` });
      }
    });
  }

  // 6. pendingActions keys should be uids that exist (or "__party__" sentinel).
  const allowedPendingKeys = new Set([...playerIds, "__party__"]);
  for (const k of Object.keys(room.pendingActions || {})) {
    if (!allowedPendingKeys.has(k)) {
      issues.push({ severity: "err", text: `pendingActions has stale key "${k}" (player removed?).` });
    }
  }

  // 7. votes keys should be uids that exist (or "__resolved" sentinel).
  for (const k of Object.keys(room.votes || {})) {
    if (k === "__resolved") continue;
    if (!players[k]) {
      issues.push({ severity: "err", text: `votes contains stale key "${k}".` });
    }
  }

  // 8. Action prompt's forUid (if set) must be a real player.
  const ap = room.actionPrompt;
  if (ap && ap.optionMode === "individual" && ap.forUid && !players[ap.forUid]) {
    issues.push({ severity: "err", text: `actionPrompt.forUid "${ap.forUid}" is not in players.` });
  }

  // 9. map tokens with kind=player must reference real player uids.
  const mapTokens = Array.isArray(room.map?.tokens) ? room.map.tokens : [];
  for (const t of mapTokens) {
    if (t.kind === "player" && t.id && !players[t.id]) {
      issues.push({ severity: "warn", text: `map token "${t.label || t.id}" claims to be a player but uid not in room.` });
    }
  }

  return issues;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
