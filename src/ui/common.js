// Tiny vanilla UI helpers shared across views.

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");
  // Toggle body.in-game so the layout-lock CSS works in browsers without :has().
  document.body.classList.toggle("in-game", viewId === "view-game");
}

const MAX_TOASTS = 4;
export function toast(message, kind = "") {
  const root = document.getElementById("toasts");
  if (!root) return;
  // Cap concurrent toasts so spamming kicks/regens doesn't fill the screen.
  while (root.children.length >= MAX_TOASTS) {
    const oldest = root.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity 0.3s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 300);
  }, 3500);
}

// Deterministic player color palette. Each uid maps to one color so chat
// messages from the same player are easy to spot at a glance.
const PLAYER_COLORS = [
  "#5ee0a6", // mint
  "#6fb5ff", // sky
  "#ffb84d", // amber
  "#ff7b8a", // rose
  "#b89aff", // violet (default accent)
  "#7adfd1", // teal
  "#ffaa7a", // peach
  "#a7e85b", // lime
];
export function colorForUid(uid) {
  if (!uid) return "#b89aff";
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 31 + uid.charCodeAt(i)) | 0;
  }
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

// Convenience: copy text to clipboard, with a fallback for older / blocked
// clipboard contexts. Returns true on success.
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch { return false; }
  }
}

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Build a Markdown transcript from a room's message log. Used by the
// "Export log" button to download a campaign log file.
export function buildTranscript(room, roomCode) {
  const lines = [];
  lines.push(`# Cursed Pact — campaign transcript`);
  lines.push("");
  lines.push(`**Room:** \`${roomCode || "?"}\``);
  if (room?.dmTone) lines.push(`**DM tone:** ${room.dmTone}`);
  if (room?.objective) lines.push(`**Objective:** ${room.objective}`);
  lines.push(`**Exported:** ${new Date().toISOString()}`);
  lines.push("");
  if (room?.players) {
    lines.push("## Party");
    for (const p of Object.values(room.players)) {
      const c = p.character || {};
      lines.push(`- **${c.name || p.name || "?"}** (${c.grade || "?"}, ${c.xp || 0} XP) — ${c.technique || "(no technique)"}`);
    }
    lines.push("");
  }
  lines.push("## Log");
  lines.push("");
  const msgs = Object.entries(room?.messages || {})
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const m of msgs) {
    const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : "";
    if (m.type === "dm") {
      lines.push(`### DM ${ts ? `(${ts})` : ""}`);
      lines.push("");
      lines.push(m.content || "");
      lines.push("");
    } else if (m.type === "system") {
      lines.push(`> _${m.content || ""}_`);
      lines.push("");
    } else if (m.type === "roll") {
      lines.push(`**${m.authorName || "?"} ${ts ? `(${ts})` : ""}** rolled: ${m.content || ""}`);
      lines.push("");
    } else {
      lines.push(`**${m.authorName || "?"} ${ts ? `(${ts})` : ""}:** ${m.content || ""}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function downloadAsFile(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// marked is loaded as a global script tag.
export function renderMarkdown(text) {
  if (typeof window.marked?.parse === "function") {
    return window.marked.parse(text || "", { breaks: true });
  }
  return escapeHtml(text || "");
}

// Animate a d20 roll. Calls onResult(result) with the final number.
export function animateD20(displayEl, finalValue) {
  return new Promise((resolve) => {
    if (!displayEl) { resolve(); return; }
    displayEl.classList.add("d20-rolling");
    let ticks = 0;
    const interval = setInterval(() => {
      displayEl.textContent = String(1 + Math.floor(Math.random() * 20));
      ticks++;
      if (ticks > 8) {
        clearInterval(interval);
        displayEl.textContent = String(finalValue);
        displayEl.classList.remove("d20-rolling");
        resolve();
      }
    }, 60);
  });
}
