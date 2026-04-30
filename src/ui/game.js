import { $, show, toast, el, escapeHtml, renderMarkdown } from "./common.js";
import {
  listenRoom,
  postMessage,
  currentUid,
  setPlayerOnline,
} from "../firebase.js";
import { messagesArray, submitPlayerAction, runDmTurn, shouldRunDmTurn, triggerCampaignStart } from "../game/room.js";

let unsubscribeRoom = null;
let lastRoom = null;
let renderedMessageIds = new Set();
let roomCode = null;
let isHost = false;
let dmRunning = false;
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

    // Host: kick the campaign off once we've registered our own character.
    if (isHost && !campaignStartTriggered) {
      const hostUid = currentUid();
      const msgs = Object.values(room.messages || {});
      const hasCampaignMsg = msgs.some((m) => m && m.type === "system" && /Campaign begins/i.test(m.content || ""));
      const hostHasCharacter = room.players && room.players[hostUid];
      if (hostHasCharacter && !hasCampaignMsg) {
        campaignStartTriggered = true;
        triggerCampaignStart({ roomCode: code }).catch((err) => {
          console.error("Failed to start campaign:", err);
          campaignStartTriggered = false;
        });
      } else if (hasCampaignMsg) {
        campaignStartTriggered = true;
      }
    }

    // Host orchestrates DM turns.
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
}

function leaveRoom() {
  if (unsubscribeRoom) { try { unsubscribeRoom(); } catch {} unsubscribeRoom = null; }
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
  renderObjective(room);
  renderParty(room);
  renderMessages(room);
  renderTurnState(room);
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
  for (const p of players) {
    const c = p.character || {};
    const isYou = p.uid === me;
    const isCurrent = room.currentTurn === p.uid;
    const card = el("div", {
      class: `party-card ${isYou ? "you" : ""} ${isCurrent ? "current-turn" : ""} ${p.online ? "" : "offline"}`,
    });
    card.appendChild(el("div", { class: "party-name" }, [
      `${escapeHtml(c.name || p.name || "?")} `,
      el("span", { class: "party-grade" }, escapeHtml(c.grade || "")),
    ]));
    card.appendChild(el("div", { class: "party-technique" }, escapeHtml(truncate(c.technique || "(no technique)", 80))));

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
    if (!p.online) status.appendChild(el("span", { class: "status-tag bad" }, "offline"));
    card.appendChild(status);

    list.appendChild(card);
  }
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
