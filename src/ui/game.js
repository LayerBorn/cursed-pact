import { $, show, toast, el, escapeHtml, renderMarkdown, copyToClipboard, colorForUid, buildTranscript, downloadAsFile } from "./common.js";
import {
  listenRoom,
  postMessage,
  currentUid,
  setPlayerOnline,
  bumpLastSeen,
  kickPlayer,
  castVote,
} from "../firebase.js";
import {
  messagesArray,
  submitPlayerAction,
  submitPartyAction,
  runDmTurn,
  rerunLastDmTurn,
  shouldRunDmTurn,
  triggerCampaignStart,
  generateMissingAbilities,
  regenerateForPlayer,
  tallyVotes,
  eligibleVoterUids,
  nextTurnUid,
} from "../game/room.js";
import { XP_TO_NEXT } from "../game/character.js";
import { findProfanity } from "../util/profanity.js";

const INACTIVE_AFTER_MS = 3 * 60 * 1000; // 3 min — long enough that "thinking" doesn't trigger it
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
let voteResolveRunning = false;

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

  // Export log button
  $("#btn-export-log")?.addEventListener("click", () => {
    if (!lastRoom) { toast("Nothing to export yet.", "warn"); return; }
    const md = buildTranscript(lastRoom, roomCode);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadAsFile(`cursed-pact-${roomCode || "room"}-${stamp}.md`, md);
    toast("Campaign log downloaded.", "ok");
  });

  // Copy room code buttons
  for (const id of ["btn-copy-game-code", "btn-copy-waiting-code"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      if (!roomCode) return;
      const ok = await copyToClipboard(roomCode);
      toast(ok ? `Room code ${roomCode} copied` : "Couldn't copy — copy manually", ok ? "ok" : "warn");
    });
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
  if (text.length > 500) { toast("Action too long (max 500 chars).", "warn"); return; }
  if (findProfanity(text)) { toast(`Profanity detected — please rephrase.`, "error"); return; }

  const my = lastRoom?.players?.[currentUid()];
  if (!my) { toast("Not in this room.", "error"); return; }

  // If a group prompt is open, freeform isn't appropriate — they should vote.
  // We still allow it so the host can override, but warn.
  if (lastRoom?.actionPrompt?.optionMode === "group") {
    toast("Group vote in progress — submitting freeform overrides the vote.", "warn");
  }

  await submitPlayerAction({
    roomCode,
    uid: currentUid(),
    name: my.name,
    content: text,
    rolls: [],
  });
  $("#action-input").value = "";
  const counter = $("#action-counter");
  if (counter) { counter.textContent = "0 / 500"; counter.classList.remove("near-limit"); }
}

async function submitOption(optionText) {
  const my = lastRoom?.players?.[currentUid()];
  if (!my) return;
  await submitPlayerAction({
    roomCode,
    uid: currentUid(),
    name: my.name,
    content: optionText,
    rolls: [],
  });
}

async function castVoteFor(optionId) {
  try {
    await castVote(roomCode, currentUid(), optionId);
  } catch (err) {
    console.error(err);
    toast(`Vote failed: ${err.message}`, "error");
  }
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

    if (isHost && !abilityGenRunning && hasPlayersMissingAbilities(room)) {
      abilityGenRunning = true;
      generateMissingAbilities({ roomCode: code, room })
        .catch((err) => console.warn("Ability backfill failed:", err))
        .finally(() => { abilityGenRunning = false; });
    }

    // Host: detect resolved group vote, submit as party action.
    if (isHost && !voteResolveRunning && !dmRunning) {
      const winner = tallyVotes(room);
      if (winner) {
        voteResolveRunning = true;
        submitPartyAction({
          roomCode: code,
          content: winner.option.text,
          count: winner.count,
          total: winner.total,
          optionId: winner.option.id,
        })
          .catch((err) => console.warn("Party action submit failed:", err))
          .finally(() => { voteResolveRunning = false; });
      }
    }

    if (isHost && !dmRunning && shouldRunDmTurn(room)) {
      dmRunning = true;
      $("#dm-thinking").classList.remove("hidden");
      runDmTurn({ roomCode: code, room, hostUid: currentUid() })
        .catch((err) => {
          console.error("DM turn failed:", err);
          toast(`DM turn failed: ${err.message}`, "error");
        })
        .finally(() => {
          dmRunning = false;
          $("#dm-thinking").classList.add("hidden");
        });
    } else if (!isHost) {
      // Non-hosts show the spinner whenever a pending action exists or the DM
      // is waiting on the host (heuristic: pendingActions present, no fresh DM
      // message yet from this prompt).
      const hasPending = room.pendingActions && Object.keys(room.pendingActions).length > 0;
      $("#dm-thinking").classList.toggle("hidden", !hasPending);
    }
  });

  setPlayerOnline(code, currentUid(), true).catch(() => {});

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState !== "visible" || !roomCode) return;
    bumpLastSeen(roomCode, currentUid()).catch(() => {});
  }, HEARTBEAT_MS);

  document.addEventListener("visibilitychange", onVisibilityChange);

  if (inactivityRefreshTimer) clearInterval(inactivityRefreshTimer);
  inactivityRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (lastRoom) renderParty(lastRoom);
  }, 30 * 1000);
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
  $("#chat-log").innerHTML = "";
  $("#party-list").innerHTML = "";
  $("#action-input").value = "";
  $("#dice-tray").classList.add("hidden");
  $("#turn-banner").classList.add("hidden");
  $("#action-prompt").classList.add("hidden");
  $("#dm-thinking").classList.add("hidden");
}

function renderRoom(room) {
  renderWaitingRoom(room);
  renderObjective(room);
  renderTurnBanner(room);
  renderParty(room);
  renderMap(room);
  renderMessages(room);
  renderRerunButton(room);
  renderActionPrompt(room);
  renderTurnState(room);
}

// Host-only ↻ button overlaid on the most recent DM message. Lets the host
// revert and re-roll the last DM turn if it was bad.
function renderRerunButton(room) {
  const log = $("#chat-log");
  // Remove any prior rerun button.
  log.querySelectorAll(".dm-rerun-btn").forEach((b) => b.remove());
  if (!isHost) return;
  if (!room?._lastSnapshot) return;
  // Find the last .msg.dm in the log.
  const dmMsgs = log.querySelectorAll(".msg.dm");
  if (!dmMsgs.length) return;
  const last = dmMsgs[dmMsgs.length - 1];
  const btn = el("button", {
    class: "dm-rerun-btn",
    title: "Rerun this turn (revert state, re-call DM)",
    onclick: async () => {
      if (!confirm("Rerun the last DM turn? This reverts HP / CE / XP / map and re-asks the DM.")) return;
      try {
        await rerunLastDmTurn({ roomCode, room: lastRoom, hostUid: currentUid() });
      } catch (err) {
        console.error(err);
        toast(`Rerun failed: ${err.message}`, "error");
      }
    },
  }, "↻ rerun");
  last.appendChild(btn);
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
    waitingRoom.classList.add("hidden");
    chatLog.classList.remove("hidden");
    actionForm.classList.remove("hidden");
    return;
  }

  waitingRoom.classList.remove("hidden");
  chatLog.classList.add("hidden");
  actionForm.classList.add("hidden");
  $("#turn-banner").classList.add("hidden");
  $("#action-prompt").classList.add("hidden");

  $("#waiting-room-code").textContent = roomCode || "—";

  const status = $("#waiting-status");
  if (!ready) {
    status.textContent = "No sorcerers yet. Build yours.";
  } else {
    const names = players.map((p) => `${p.character?.name || p.name || "?"} (${p.character?.grade || "?"})`).join(" · ");
    status.textContent = `${ready} sorcerer${ready === 1 ? "" : "s"} ready: ${names}`;
  }

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

function renderTurnBanner(room) {
  const banner = $("#turn-banner");
  const msgs = Object.values(room.messages || {});
  const hasCampaignMsg = msgs.some((m) => m && m.type === "system" && /Campaign begins/i.test(m.content || ""));
  if (!hasCampaignMsg) { banner.classList.add("hidden"); return; }

  const me = currentUid();
  const cur = room.currentTurn;
  const curPlayer = cur ? room.players?.[cur] : null;
  const curName = curPlayer?.character?.name || curPlayer?.name || null;

  // Group prompt? Show "Party vote" banner regardless of currentTurn.
  if (room.actionPrompt?.optionMode === "group") {
    banner.classList.remove("hidden");
    banner.classList.remove("yours");
    banner.classList.add("group");
    $("#turn-label").textContent = "PARTY VOTE";
    $("#turn-name").textContent = "Choose together";
    return;
  }

  if (!cur) { banner.classList.add("hidden"); return; }

  banner.classList.remove("hidden");
  banner.classList.remove("group");
  if (cur === me) {
    banner.classList.add("yours");
    $("#turn-label").textContent = "YOUR TURN";
    $("#turn-name").textContent = curName ? `(${curName})` : "";
  } else {
    banner.classList.remove("yours");
    $("#turn-label").textContent = "TURN";
    $("#turn-name").textContent = curName || "—";
  }

  // Up-next preview: who acts after the current turn.
  const nextSlot = $("#turn-banner-next");
  if (nextSlot) {
    const next = nextTurnUid(room.turnOrder, cur);
    if (next && next !== cur) {
      const nextPlayer = room.players?.[next];
      const nextName = nextPlayer?.character?.name || nextPlayer?.name || null;
      if (nextName) {
        nextSlot.classList.remove("hidden");
        nextSlot.textContent = `Up next: ${nextName}`;
      } else {
        nextSlot.classList.add("hidden");
      }
    } else {
      nextSlot.classList.add("hidden");
    }
  }
}

function renderActionPrompt(room) {
  const panel = $("#action-prompt");
  const optionsRoot = $("#action-options");
  const tally = $("#action-prompt-tally");
  const modeLabel = $("#action-prompt-mode");
  const prompt = room.actionPrompt;

  if (!prompt || !Array.isArray(prompt.options) || !prompt.options.length) {
    panel.classList.add("hidden");
    optionsRoot.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  const me = currentUid();
  const isGroup = prompt.optionMode === "group";

  if (isGroup) {
    modeLabel.textContent = "Party vote — choose one";
    panel.classList.add("group");
    panel.classList.remove("individual", "spectator");
    const eligible = eligibleVoterUids(room);
    const votes = room.votes || {};
    const cast = eligible.filter((u) => votes[u]).length;
    tally.textContent = `${cast} / ${eligible.length} voted`;
  } else {
    panel.classList.remove("group", "spectator");
    panel.classList.add("individual");
    if (prompt.forUid === me) {
      modeLabel.textContent = "Choose your action";
    } else {
      modeLabel.textContent = `Waiting for ${room.players?.[prompt.forUid]?.character?.name || "player"}…`;
      panel.classList.add("spectator");
    }
    tally.textContent = "";
  }

  optionsRoot.innerHTML = "";
  const myVote = (room.votes || {})[me];

  for (const opt of prompt.options) {
    let count = 0;
    if (isGroup) {
      const votes = room.votes || {};
      count = Object.values(votes).filter((v) => v === opt.id).length;
    }
    const btn = el("button", {
      class: `option-btn ${isGroup && myVote === opt.id ? "voted" : ""}`,
      type: "button",
      onclick: async () => {
        if (isGroup) {
          await castVoteFor(opt.id);
        } else {
          if (prompt.forUid && prompt.forUid !== me) {
            toast("Not your turn.", "warn");
            return;
          }
          await submitOption(opt.text);
        }
      },
    }, [
      el("span", { class: "option-text" }, opt.text),
      isGroup ? el("span", { class: "option-count" }, count > 0 ? String(count) : "") : null,
    ].filter(Boolean));
    if (!isGroup && prompt.forUid && prompt.forUid !== me) btn.disabled = true;
    optionsRoot.appendChild(btn);
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

  container.innerHTML = "";
  container.appendChild(el("div", { class: "map-title" }, escapeHtml(map.scene || "Scene")));

  const grid = el("div", {
    class: "map-grid",
    style: `grid-template-columns: repeat(${cols}, 1fr); aspect-ratio: ${cols} / ${rows};`,
  });
  for (let i = 0; i < cols * rows; i++) grid.appendChild(el("div", { class: "map-cell" }));
  container.appendChild(grid);

  for (const t of map.tokens) {
    const [c, r] = t.pos;
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const cell = grid.children[r * cols + c];
    if (!cell) continue;
    const isMe = t.kind === "player" && t.id === me;
    const tokenLabel = (t.label || "?").slice(0, 2).toUpperCase();

    // Compute hp/maxHp: enemy/boss tokens have it inline; player tokens read
    // from the player's character record so we can surface live HP.
    let hp = null, maxHp = null, hpTitle = "";
    if (t.kind === "player" || t.kind === "ally") {
      const player = room.players?.[t.id];
      const c2 = player?.character;
      if (c2 && Number.isFinite(c2.maxHp) && c2.maxHp > 0) {
        hp = c2.hp ?? c2.maxHp;
        maxHp = c2.maxHp;
        hpTitle = `${hp} / ${maxHp} HP`;
      }
    } else if (Number.isFinite(t.hp) && Number.isFinite(t.maxHp) && t.maxHp > 0) {
      hp = t.hp;
      maxHp = t.maxHp;
      hpTitle = `${hp} / ${maxHp} HP`;
    }

    const tok = el("div", {
      class: `map-token kind-${t.kind || "feature"} ${isMe ? "me" : ""}`,
      title: hpTitle ? `${t.label || ""} — ${hpTitle}` : (t.label || ""),
    });
    tok.appendChild(el("span", { class: "map-token-label" }, tokenLabel));
    if (hp != null && maxHp != null) {
      const pct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
      const hpBar = el("div", { class: "map-token-hp" }, el("div", { class: "map-token-hp-fill", style: `width:${pct}%` }));
      tok.appendChild(hpBar);
    }
    cell.appendChild(tok);
  }

  // Legend with optional HP next to each non-feature token
  const legend = el("div", { class: "map-legend" });
  for (const t of map.tokens) {
    let hpTxt = "";
    if (t.kind === "player" || t.kind === "ally") {
      const c2 = room.players?.[t.id]?.character;
      if (c2 && Number.isFinite(c2.maxHp)) hpTxt = ` ${c2.hp ?? "?"}/${c2.maxHp}`;
    } else if (Number.isFinite(t.hp) && Number.isFinite(t.maxHp)) {
      hpTxt = ` ${t.hp}/${t.maxHp}`;
    }
    legend.appendChild(el("div", { class: "map-legend-row" }, [
      el("span", { class: `map-legend-dot kind-${t.kind || "feature"}` }, ""),
      el("span", { class: "map-legend-label" }, escapeHtml(t.label || "?") + hpTxt),
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

    const nameSpan = el("span", { class: "party-name-main" }, escapeHtml(c.name || p.name || "?"));
    nameSpan.style.color = colorForUid(p.uid);
    const nameRow = el("div", { class: "party-name" }, [
      el("span", { class: "party-name-text" }, [
        nameSpan,
        " ",
        el("span", { class: "party-grade" }, escapeHtml(c.grade || "")),
      ]),
    ]);

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

    // XP bar + label
    const xp = Number(c.xp) || 0;
    const xpNeeded = XP_TO_NEXT[c.grade] ?? Infinity;
    const xpPct = Number.isFinite(xpNeeded)
      ? Math.max(0, Math.min(100, Math.round((xp / xpNeeded) * 100)))
      : 100;
    const xpLabel = Number.isFinite(xpNeeded) ? `XP ${xp}/${xpNeeded}` : `XP ${xp} (max grade)`;
    card.appendChild(el("div", { class: "party-meta" }, [xpLabel, ""]));
    card.appendChild(el("div", { class: "party-bar" }, el("div", {
      class: "party-bar-fill xp",
      style: `width:${xpPct}%`,
    })));

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

const MAX_TRACKED_MSG_IDS = 1000;
function renderMessages(room) {
  const log = $("#chat-log");
  const msgs = messagesArray(room.messages);
  const me = currentUid();
  // Capture scroll position BEFORE we append so we can decide whether to
  // auto-scroll. If the user scrolled up to read history, leave them be.
  const wasAtBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
  let appended = false;
  for (const m of msgs) {
    if (renderedMessageIds.has(m.id)) continue;
    renderedMessageIds.add(m.id);
    appended = true;
    const node = renderMessageNode(m, me);
    log.appendChild(node);
  }
  if (appended && wasAtBottom) log.scrollTop = log.scrollHeight;
  // Trim the rendered-id set so a long campaign doesn't leak memory.
  if (renderedMessageIds.size > MAX_TRACKED_MSG_IDS) {
    const arr = Array.from(renderedMessageIds);
    renderedMessageIds = new Set(arr.slice(-MAX_TRACKED_MSG_IDS / 2));
  }
}

function renderMessageNode(m, me) {
  const cls = ["msg", m.type || "system"];
  if (m.type === "player") {
    if (m.author === "__party__") cls.push("party");
    else cls.push(m.author === me ? "you" : "other");
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
  // Apply a deterministic per-player color for player and roll messages.
  if ((m.type === "player" || m.type === "roll") && m.author && m.author !== "__party__") {
    const c = colorForUid(m.author);
    author.style.color = c;
    wrap.style.borderLeftColor = c;
  }
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
