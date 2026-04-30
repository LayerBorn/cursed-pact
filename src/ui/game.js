import { $, show, toast, el, escapeHtml, renderMarkdown, animateD20 } from "./common.js";
import {
  listenRoom,
  postMessage,
  currentUid,
  setPlayerOnline,
} from "../firebase.js";
import { rollD20, rollWithStat, formatRoll } from "../game/combat.js";
import { messagesArray, submitPlayerAction, runDmTurn, shouldRunDmTurn } from "../game/room.js";

let unsubscribeRoom = null;
let lastRoom = null;
let renderedMessageIds = new Set();
let roomCode = null;
let isHost = false;
let dmRunning = false;
let pendingRolls = []; // rolls staged before sending the next action

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

  $("#btn-quick-roll").addEventListener("click", async () => {
    const my = lastRoom?.players?.[currentUid()];
    if (!my) return;
    const roll = rollD20();
    const line = `d20: **${roll}**`;
    pendingRolls.push(line);
    toast(`Staged d20 = ${roll}. Send your action to commit.`, "ok");
    // Also append a transient note in the action box.
    const t = $("#action-input");
    t.value = (t.value ? t.value + "\n" : "") + `[rolled d20: ${roll}]`;
  });

  $("#btn-roll").addEventListener("click", async () => {
    const my = lastRoom?.players?.[currentUid()];
    if (!my) return;
    // Use last needsRoll request if present in chat — otherwise raw d20.
    const last = findLastNeedsRoll();
    let roll;
    if (last) {
      roll = rollWithStat(my.character, last.stat || "Technique");
    } else {
      const d = rollD20();
      roll = { die: d, mod: 0, total: d, statName: "raw", crit: d === 20, fumble: d === 1 };
    }
    pendingRolls.push(formatRoll(roll));
    await postMessage(roomCode, {
      author: currentUid(),
      authorName: my.name,
      type: "roll",
      content: formatRoll(roll),
    });
    $("#dice-tray").classList.add("hidden");
    toast(`Rolled ${roll.total}. Describe your action and send.`, "ok");
  });
}

function findLastNeedsRoll() {
  if (!lastRoom) return null;
  const msgs = messagesArray(lastRoom.messages);
  const me = currentUid();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "system" && /Roll needed/.test(m.content || "")) {
      // crude parse: extract DC and stat
      const dcMatch = (m.content.match(/DC\s+(\d+)/) || [])[1];
      const statMatch = (m.content.match(/d20\s*\+\s*(\w+)/) || [])[1];
      return { dc: dcMatch ? Number(dcMatch) : null, stat: statMatch || "Technique" };
    }
    // Only look in recent messages, stop after the previous DM turn
    if (m.type === "dm" && i < msgs.length - 1) break;
  }
  return null;
}

async function sendAction() {
  const text = $("#action-input").value.trim();
  if (!text && !pendingRolls.length) {
    toast("Type something to do, or roll first.", "warn");
    return;
  }
  const my = lastRoom?.players?.[currentUid()];
  if (!my) { toast("Not in this room.", "error"); return; }
  if (lastRoom.currentTurn && lastRoom.currentTurn !== currentUid()) {
    toast("Not your turn — but I'll send anyway.", "warn");
  }

  const rolls = pendingRolls.splice(0);
  await submitPlayerAction({
    roomCode,
    uid: currentUid(),
    name: my.name,
    content: text || "(acts without speaking)",
    rolls,
  });
  $("#action-input").value = "";
}

export function joinRoom({ code, host }) {
  roomCode = code;
  isHost = host;
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

  // Mark online + heartbeat lastSeen.
  setPlayerOnline(code, currentUid(), true).catch(() => {});
}

function leaveRoom() {
  if (unsubscribeRoom) { try { unsubscribeRoom(); } catch {} unsubscribeRoom = null; }
  lastRoom = null;
  renderedMessageIds = new Set();
  roomCode = null;
  isHost = false;
  pendingRolls = [];
  $("#chat-log").innerHTML = "";
  $("#party-list").innerHTML = "";
  $("#action-input").value = "";
  $("#dice-tray").classList.add("hidden");
}

function renderRoom(room) {
  renderParty(room);
  renderMessages(room);
  renderTurnState(room);
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
  // Sort by turn order if present, else by name.
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

  // Show dice tray if there's a pending needsRoll for me.
  const needsRoll = findLastNeedsRollFor(me, room);
  $("#dice-tray").classList.toggle("hidden", !needsRoll);
  if (needsRoll) {
    $("#dice-prompt").textContent =
      `DM wants a d20 + ${needsRoll.stat || "stat"} mod vs DC ${needsRoll.dc ?? "?"} (${needsRoll.reason || "—"}).`;
  }
}

function findLastNeedsRollFor(uid, room) {
  const msgs = messagesArray(room.messages);
  // Walk back. If we see this player's roll AFTER the last "Roll needed" for them, no longer pending.
  let needed = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === "system" && /Roll needed/.test(m.content || "")) {
      // Only matches if this player's name is in the prompt — best-effort match by uid->name
      const player = room.players?.[uid];
      if (player && m.content.includes(player.name)) {
        const dcMatch = (m.content.match(/DC\s+(\d+)/) || [])[1];
        const statMatch = (m.content.match(/d20\s*\+\s*(\w+)/) || [])[1];
        const reasonMatch = (m.content.match(/\(([^)]+)\)\.\s*$/) || [])[1];
        needed = { dc: dcMatch ? Number(dcMatch) : null, stat: statMatch || "Technique", reason: reasonMatch || "" };
        // Check whether a roll from this player came after this system message.
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].type === "roll" && msgs[j].author === uid) { needed = null; break; }
        }
        break;
      }
    }
    if (m.type === "dm" && i < msgs.length - 1) break;
  }
  return needed;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
