import { $, show, toast, el, escapeHtml, renderMarkdown } from "./common.js";
import {
  listenRoom,
  postMessage,
  currentUid,
  setPlayerOnline,
  bumpLastSeen,
  kickPlayer,
} from "../firebase.js";
import { messagesArray, submitPlayerAction, runDmTurn, shouldRunDmTurn, triggerCampaignStart, generateMissingAbilities, regenerateForPlayer } from "../game/room.js";
import { findProfanity } from "../util/profanity.js";

const INACTIVE_AFTER_MS = 60 * 1000; // 1 minute of no heartbeat → "inactive"
const HEARTBEAT_MS = 25 * 1000;
let heartbeatTimer = null;
let inactivityRefreshTimer = null;

let unsubscribeRoom = null;
let lastRoom = null;
let renderedMessageIds = new Set();
let roomCode = null;
let isHost = false;
let dmRunning = false;
let abilityGenRunning = false;
let campaignStartTriggered = false;

export function initGame({ onLeave }) {
  $("#btn-leave").addEventListener("click", async () => {
    if (roomCode) {
      try { await setPlayerOnline(roomCode, currentUid(), false); } catch {}
    }
    leaveRoom();
    onLeave();
  });

  $("#action-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await sendAction();
  });

  // Live char counter on the action input.
  const actionInput = $("#action-input");
  const actionCounter = $("#action-counter");
  if (actionInput && actionCounter) {
    const updateAC = () => {
      const len = (actionInput.value || "").length;
      actionCounter.textContent = `${len} / 500`;
      actionCounter.classList.toggle("near-limit", len > 425);
    };
    actionInput.addEventListener("input", updateAC);
    updateAC();
  }

  $("#btn-start-campaign").addEventListener("click", async () => {
    const btn = $("#btn-start-campaign");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      await triggerCampaignStart({ roomCode });
    } catch (err) {
      console.error(err);
      toast(`Couldn't start: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "Start campaign";
    }
  });

  // Hide the now-vestigial dice buttons — auto-roll handles checks.
  const tray = $("#dice-tray");
  if (tray) tray.classList.add("hidden");
  const quickRoll = $("#btn-quick-roll");
  if (quickRoll) quickRoll.style.display = "none";
}

async function sendAction() {
  const text = $("#action-input").value.trim();
  if (!text) {
    toast("Type something to do.", "warn");
    return;
  }
  if (text.length > 500) {
    toast("Action too long (max 500 chars).", "warn");
    return;
  }
  const profane = findProfanity(text);
  if (profane) {
    toast(`Profanity detected — please rephrase.`, "error");
    return;
  }
  const my = lastRoom?.players?.[currentUid()];
  if (!my) { toast("Not in this room.", "error"); return; }
  if (lastRoom.currentTurn && lastRoom.currentTurn !== currentUid()) {
    toast("Not your turn — but I'll send anyway.", "warn");
  }

  await submitPlayerAction({
    roomCode,
    uid: currentUid(),
    name: my.name,
    content: text,
    rolls: [],
  });
  $("#action-input").value = "";
  // Reset counter
  const counter = $("#action-counter");
  if (counter) { counter.textContent = "0 / 500"; counter.classList.remove("near-limit"); }
}

export function joinRoom({ code, host }) {
  roomCode = code;
  isHost = host;
  campaignStartTriggered = false;
  window.__app.currentRoomCode = code;

  $("#game-room-code").textContent = code;
  $("#game-host-badge").classList.toggle("hidden", !host);

  unsubscribeRoom = listenRoom(code, (room) => {
    if (!room) {
      toast("Room was deleted.", "error");
      leaveRoom();
      return;
    }
    lastRoom = room;
    renderRoom(room);

    // Host: backfill abilities for any player who joined without a key.
    if (isHost && !abilityGenRunning && hasPlayersMissingAbilities(room)) {
      abilityGenRunning = true;
      generateMissingAbilities({ roomCode: code, room })
        .catch((err) => console.warn("Ability backfill failed:", err))
        .finally(() => { abilityGenRunning = false; });
    }

    // Host orchestrates DM turns once the campaign is started.
    if (isHost && !dmRunning && shouldRunDmTurn(room)) {
      dmRunning = true;
      runDmTurn({ roomCode: code, room, hostUid: currentUid() })
        .catch((err) => {
          console.error("DM turn failed:", err);
          toast(`DM turn failed: ${err.message}`, "error");
        })
        .finally(() => { dmRunning = false; });
    }
  });

  setPlayerOnline(code, currentUid(), true).catch(() => {});

  // Heartbeat: bump lastSeen periodically while the tab is active.
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!roomCode) return;
    bumpLastSeen(roomCode, currentUid()).catch(() => {});
  }, HEARTBEAT_MS);

  // Tab regaining focus → bump immediately so others see we're back.
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Re-render party every 15s so the inactivity tag updates as time passes
  // even without a Firebase change.
  if (inactivityRefreshTimer) clearInterval(inactivityRefreshTimer);
  inactivityRefreshTimer = setInterval(() => {
    if (lastRoom) renderParty(lastRoom);
  }, 15 * 1000);
}

function onVisibilityChange() {
  if (document.visibilityState === "visible" && roomCode) {
    bumpLastSeen(roomCode, currentUid()).catch(() => {});
  }
}

function leaveRoom() {
  if (unsubscribeRoom) { try { unsubscribeRoom(); } catch {} unsubscribeRoom = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (inactivityRefreshTimer) { clearInterval(inactivityRefreshTimer); inactivityRefreshTimer = null; }
  document.removeEventListener("visibilitychange", onVisibilityChange);
  lastRoom = null;
  renderedMessageIds = new Set();
  roomCode = null;
  isHost = false;
  campaignStartTriggered = false;
  $("#chat-log").innerHTML = "";
  $("#party-list").innerHTML = "";
  $("#action-input").value = "";
  $("#dice-tray").classList.add("hidden");
}

function renderRoom(room) {
  renderWaitingRoom(room);
  renderObjective(room);
  renderParty(room);
  renderMap(room);
  renderMessages(room);
  renderTurnState(room);
}

function renderWaitingRoom(room) {
  const msgs = Object.values(room.messages || {});
  const hasCampaignMsg = msgs.some((m) => m && m.type === "system" && /Campaign begins/i.test(m.content || ""));
  const players = Object.values(room.players || {});
  const ready = players.length;
  const me = currentUid();
  const myselfIn = !!room.players?.[me];

  const waitingRoom = $("#waiting-room");
  const chatLog = $("#chat-log");
  const actionForm = $("#action-form");
  const startBtn = $("#btn-start-campaign");
  const nonHost = $("#waiting-non-host");

  if (hasCampaignMsg) {
    // Game in progress — hide waiting UI, show chat and action form.
    waitingRoom.classList.add("hidden");
    chatLog.classList.remove("hidden");
    actionForm.classList.remove("hidden");
    return;
  }

  // Pre-game state: show waiting room, hide chat + input.
  waitingRoom.classList.remove("hidden");
  chatLog.classList.add("hidden");
  actionForm.classList.add("hidden");

  $("#waiting-room-code").textContent = roomCode || "—";

  // Roster of players already in the lobby.
  const status = $("#waiting-status");
  if (!ready) {
    status.textContent = "No sorcerers yet. Build yours.";
  } else {
    const names = players.map((p) => `${p.character?.name || p.name || "?"} (${p.character?.grade || "?"})`).join(" · ");
    status.textContent = `${ready} sorcerer${ready === 1 ? "" : "s"} ready: ${names}`;
  }

  // Host: show start button (disabled until at least one sorcerer is registered).
  if (isHost) {
    startBtn.classList.remove("hidden");
    startBtn.disabled = ready < 1 || !myselfIn;
    if (ready < 1) startBtn.textContent = "Waiting for sorcerers…";
    else if (!myselfIn) startBtn.textContent = "Build your sorcerer first";
    else startBtn.textContent = `Start campaign (${ready})`;
    nonHost.classList.add("hidden");
  } else {
    startBtn.classList.add("hidden");
    nonHost.classList.remove("hidden");
  }
}

function renderMap(room) {
  const container = $("#map-container");
  const map = room.map;
  if (!map || !Array.isArray(map.tokens) || !Array.isArray(map.size)) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  const [cols, rows] = map.size;
  const me = currentUid();

  // Title
  container.innerHTML = "";
  const title = el("div", { class: "map-title" }, escapeHtml(map.scene || "Scene"));
  container.appendChild(title);

  // Grid
  const grid = el("div", {
    class: "map-grid",
    style: `grid-template-columns: repeat(${cols}, 1fr); aspect-ratio: ${cols} / ${rows};`,
  });
  // Empty cells first.
  for (let i = 0; i < cols * rows; i++) {
    grid.appendChild(el("div", { class: "map-cell" }));
  }
  container.appendChild(grid);

  // Tokens overlay positioned absolutely inside the grid.
  for (const t of map.tokens) {
    const [c, r] = t.pos;
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const cellIdx = r * cols + c;
    const cell = grid.children[cellIdx];
    if (!cell) continue;
    const isMe = t.kind === "player" && t.id === me;
    const tokenLabel = (t.label || "?").slice(0, 2).toUpperCase();
    const tok = el("div", {
      class: `map-token kind-${t.kind || "feature"} ${isMe ? "me" : ""}`,
      title: t.label || "",
    }, tokenLabel);
    cell.appendChild(tok);
  }

  // Legend
  const legend = el("div", { class: "map-legend" });
  for (const t of map.tokens) {
    legend.appendChild(el("div", { class: "map-legend-row" }, [
      el("span", { class: `map-legend-dot kind-${t.kind || "feature"}` }, ""),
      el("span", { class: "map-legend-label" }, escapeHtml(t.label || "?")),
    ]));
  }
  container.appendChild(legend);
}

function renderObjective(room) {
  let bar = document.getElementById("objective-bar");
  if (!bar) {
    const layout = document.querySelector(".chat-area");
    if (!layout) return;
    bar = document.createElement("div");
    bar.id = "objective-bar";
    bar.className = "objective-bar hidden";
    layout.insertBefore(bar, layout.firstChild);
  }
  if (room.objective && typeof room.objective === "string") {
    bar.classList.remove("hidden");
    bar.innerHTML = `<span class="objective-label">Objective</span><span class="objective-text"></span>`;
    bar.querySelector(".objective-text").textContent = room.objective;
  } else {
    bar.classList.add("hidden");
  }
}

function renderParty(room) {
  const list = $("#party-list");
  list.innerHTML = "";
  const me = currentUid();
  const players = Object.values(room.players || {});
  if (!players.length) {
    list.appendChild(el("p", { class: "muted small" }, "No players yet."));
    return;
  }
  const order = room.turnOrder || [];
  players.sort((a, b) => {
    const ai = order.indexOf(a.uid); const bi = order.indexOf(b.uid);
    if (ai === -1 && bi === -1) return (a.name || "").localeCompare(b.name || "");
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const now = Date.now();
  for (const p of players) {
    const c = p.character || {};
    const isYou = p.uid === me;
    const isCurrent = room.currentTurn === p.uid;
    const inactive = isInactive(p, now);
    const card = el("div", {
      class: `party-card ${isYou ? "you" : ""} ${isCurrent ? "current-turn" : ""} ${inactive ? "inactive" : ""}`,
    });

    const nameRow = el("div", { class: "party-name" }, [
      el("span", {}, [
        `${escapeHtml(c.name || p.name || "?")} `,
        el("span", { class: "party-grade" }, escapeHtml(c.grade || "")),
      ]),
    ]);

    // Host action buttons (not for self).
    if (isHost && p.uid !== me) {
      const btnGroup = el("div", { class: "party-host-actions" });
      btnGroup.appendChild(el("button", {
        class: "btn-regen",
        title: `Regenerate abilities & stats for ${c.name || "player"}`,
        onclick: async () => {
          try {
            toast(`Regenerating for ${c.name}…`, "ok");
            await regenerateForPlayer({ roomCode, player: p });
          } catch (err) {
            console.error(err);
            toast(`Regenerate failed: ${err.message}`, "error");
          }
        },
      }, "↻"));
      btnGroup.appendChild(el("button", {
        class: "btn-kick",
        title: `Kick ${c.name || "player"}`,
        onclick: async () => {
          if (!confirm(`Kick ${c.name || "this player"} from the room?`)) return;
          try {
            await kickPlayer(roomCode, p.uid);
            toast(`Kicked ${c.name || "player"}.`, "ok");
          } catch (err) {
            console.error(err);
            toast(`Couldn't kick: ${err.message}`, "error");
          }
        },
      }, "✕"));
      nameRow.appendChild(btnGroup);
    }
    card.appendChild(nameRow);

    card.appendChild(el("div", { class: "party-technique" }, escapeHtml(truncate(c.technique || "(no technique)", 80))));

    if (c.stats) {
      card.appendChild(el("div", { class: "party-stats" },
        `P${c.stats.phys ?? "-"} · T${c.stats.tech ?? "-"} · S${c.stats.spirit ?? "-"}`));
    }

    const hpPct = Math.max(0, Math.min(100, Math.round(((c.hp ?? 0) / (c.maxHp || 1)) * 100)));
    const cePct = Math.max(0, Math.min(100, Math.round(((c.cursedEnergy ?? 0) / (c.maxCursedEnergy || 1)) * 100)));
    const hpBar = el("div", { class: "party-bar" }, el("div", { class: "party-bar-fill hp", style: `width:${hpPct}%` }));
    const ceBar = el("div", { class: "party-bar" }, el("div", { class: "party-bar-fill ce", style: `width:${cePct}%` }));
    card.appendChild(el("div", { class: "party-meta" }, [`HP ${c.hp ?? 0}/${c.maxHp ?? 0}`, ""]));
    card.appendChild(hpBar);
    card.appendChild(el("div", { class: "party-meta" }, [`CE ${c.cursedEnergy ?? 0}/${c.maxCursedEnergy ?? 0}`, ""]));
    card.appendChild(ceBar);

    if (Array.isArray(c.abilities) && c.abilities.length) {
      const abList = el("div", { class: "party-abilities" });
      abList.appendChild(el("div", { class: "party-abilities-label" }, "Abilities"));
      for (const a of c.abilities) {
        abList.appendChild(el("div", {
          class: "ability-row",
          title: a.effect || "",
        }, [
          el("span", { class: "ability-name" }, escapeHtml(a.name || "?")),
          el("span", { class: "ability-cost" }, `${a.cost ?? 0} CE`),
        ]));
      }
      card.appendChild(abList);
    }

    const status = el("div", { class: "party-status" });
    for (const s of (c.statusEffects || [])) {
      status.appendChild(el("span", { class: "status-tag" }, escapeHtml(s)));
    }
    if (inactive) status.appendChild(el("span", { class: "status-tag warn", title: "No activity for over a minute" }, "inactive"));
    card.appendChild(status);

    list.appendChild(card);
  }
}

function isInactive(player, now) {
  const ls = Number(player?.lastSeen);
  if (!Number.isFinite(ls) || ls <= 0) return false;
  return now - ls > INACTIVE_AFTER_MS;
}

function renderMessages(room) {
  const log = $("#chat-log");
  const msgs = messagesArray(room.messages);
  const me = currentUid();
  let appended = false;
  for (const m of msgs) {
    if (renderedMessageIds.has(m.id)) continue;
    renderedMessageIds.add(m.id);
    appended = true;
    const node = renderMessageNode(m, me);
    log.appendChild(node);
  }
  if (appended) {
    log.scrollTop = log.scrollHeight;
  }
}

function renderMessageNode(m, me) {
  const cls = ["msg", m.type || "system"];
  if (m.type === "player") {
    cls.push(m.author === me ? "you" : "other");
  }
  const wrap = document.createElement("div");
  wrap.className = cls.join(" ");

  if (m.type === "system") {
    wrap.textContent = m.content || "";
    return wrap;
  }

  const author = document.createElement("div");
  author.className = "msg-author";
  author.textContent = m.type === "dm" ? "DM" : (m.authorName || (m.author === me ? "You" : "?"));
  wrap.appendChild(author);

  const body = document.createElement("div");
  body.className = "msg-content";
  if (m.type === "dm") body.innerHTML = renderMarkdown(m.content || "");
  else if (m.type === "roll") body.innerHTML = renderMarkdown(m.content || "");
  else body.textContent = m.content || "";
  wrap.appendChild(body);
  return wrap;
}

function renderTurnState(room) {
  const me = currentUid();
  const myTurn = room.currentTurn === me;
  $("#game-turn-badge").classList.toggle("hidden", !myTurn);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function hasPlayersMissingAbilities(room) {
  const players = Object.values(room.players || {});
  return players.some((p) => {
    const c = p.character;
    if (!c) return false;
    const tech = (c.technique || "").trim();
    if (!tech || tech === "(undeclared technique)") return false;
    return !Array.isArray(c.abilities) || c.abilities.length === 0;
  });
}
