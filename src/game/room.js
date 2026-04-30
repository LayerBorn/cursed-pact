// Room state helpers + DM-turn orchestration. Only the host calls Gemini.
import {
  postMessage,
  setCurrentTurn,
  updatePlayerCharacter,
  setPendingAction,
  clearPendingActions,
  setObjective,
  setMap,
} from "../firebase.js";
import { applyMechanicsToCharacter, summarizeChange, rollWithStat, formatRoll } from "./combat.js";
import {
  buildTurnUserMessage,
  callGemini,
  DM_SYSTEM_PROMPT,
  parseDmResponse,
  loadStoredKey,
} from "../gemini.js";

// Convert a Firebase messages object (push-key keyed) into a sorted array.
export function messagesArray(messagesObj) {
  if (!messagesObj) return [];
  const arr = Object.entries(messagesObj).map(([id, m]) => ({ id, ...m }));
  arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return arr;
}

// Returns the next uid in the cycle.
export function nextTurnUid(turnOrder, currentUid) {
  if (!turnOrder || !turnOrder.length) return null;
  const idx = turnOrder.indexOf(currentUid);
  if (idx < 0) return turnOrder[0];
  return turnOrder[(idx + 1) % turnOrder.length];
}

// Submit the current player's action. Stored in pendingActions; host picks it up.
export async function submitPlayerAction({ roomCode, uid, name, content, rolls = [] }) {
  await postMessage(roomCode, {
    author: uid,
    authorName: name,
    type: "player",
    content,
  });
  for (const r of rolls) {
    await postMessage(roomCode, {
      author: uid,
      authorName: name,
      type: "roll",
      content: r,
    });
  }
  await setPendingAction(roomCode, uid, {
    content,
    rolls,
    submittedAt: Date.now(),
  });
}

// Re-fetch the room state (passed via callback so we don't import firebase get
// at module scope unnecessarily). The host always passes the latest snapshot in.
async function callDmOnce({ roomCode, room, hostUid, apiKey }) {
  const messages = messagesArray(room.messages).slice(-30);
  const userMsg = buildTurnUserMessage(
    room.players,
    room.turnOrder,
    room.currentTurn,
    messages,
    hostUid
  );

  const raw = await callGemini({
    apiKey,
    systemPrompt: DM_SYSTEM_PROMPT,
    userMessage: userMsg,
  });
  return parseDmResponse(raw);
}

// Auto-roll for a player, post it to the chat, and return an updated room
// snapshot reflecting the new message (we mutate the local clone since the
// real Firebase update will propagate via the listener anyway).
async function autoRollAndPost({ roomCode, room, needsRoll }) {
  const player = room.players?.[needsRoll.playerId];
  if (!player) return room;
  const roll = rollWithStat(player.character, needsRoll.stat || "Technique");
  const dcStr = needsRoll.dc != null ? ` vs DC ${needsRoll.dc}` : "";
  const reasonStr = needsRoll.reason ? ` — ${needsRoll.reason}` : "";
  const content = `${formatRoll(roll)}${dcStr}${reasonStr}`;
  await postMessage(roomCode, {
    author: needsRoll.playerId,
    authorName: player.name,
    type: "roll",
    content,
  });
  // Append locally for the next prompt build.
  const newId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...room,
    messages: {
      ...(room.messages || {}),
      [newId]: { author: needsRoll.playerId, authorName: player.name, type: "roll", content, timestamp: Date.now() },
    },
  };
}

// Host-side: handle one full "player did something" cycle. Calls Gemini up to
// MAX_CHAIN times to resolve any auto-rolls inline, then advances the turn.
const MAX_CHAIN = 4;

export async function runDmTurn({ roomCode, room: initialRoom, hostUid }) {
  const apiKey = loadStoredKey();
  if (!apiKey) {
    await postMessage(roomCode, {
      author: "system",
      authorName: "system",
      type: "system",
      content: "Host has no Gemini API key set; DM is silent.",
    });
    return;
  }

  await postMessage(roomCode, {
    author: "system",
    authorName: "system",
    type: "system",
    content: "The DM gathers their thoughts…",
  });

  let room = initialRoom;
  let lastMechanics = null;

  for (let i = 0; i < MAX_CHAIN; i++) {
    let result;
    try {
      result = await callDmOnce({ roomCode, room, hostUid, apiKey });
    } catch (err) {
      await postMessage(roomCode, {
        author: "system",
        authorName: "system",
        type: "system",
        content: `DM error: ${err.message}`,
      });
      await clearPendingActions(roomCode);
      return;
    }

    const { narration, mechanics } = result;
    lastMechanics = mechanics;

    if (narration) {
      await postMessage(roomCode, {
        author: "dm",
        authorName: "DM",
        type: "dm",
        content: narration,
      });
    }

    // Apply mechanical state changes per player.
    if (mechanics?.stateChanges?.length) {
      for (const change of mechanics.stateChanges) {
        const player = room.players?.[change.playerId];
        if (!player) continue;
        const newChar = applyMechanicsToCharacter(player.character, change);
        await updatePlayerCharacter(roomCode, change.playerId, newChar);
        // Update our local room copy so subsequent chained DM calls see fresh stats.
        room = {
          ...room,
          players: {
            ...room.players,
            [change.playerId]: { ...player, character: newChar },
          },
        };
        const summary = summarizeChange(change, player.name);
        if (summary) {
          await postMessage(roomCode, {
            author: "system",
            authorName: "system",
            type: "system",
            content: summary,
          });
        }
      }
    }

    // Update objective if the DM set one.
    if (typeof mechanics?.objective === "string" && mechanics.objective.trim()) {
      try { await setObjective(roomCode, mechanics.objective.trim()); } catch {}
    }

    // Update the scene map if the DM provided one.
    if (mechanics?.map && typeof mechanics.map === "object") {
      const m = mechanics.map;
      const cleaned = {
        scene: typeof m.scene === "string" ? m.scene.slice(0, 200) : "",
        size: Array.isArray(m.size) && m.size.length === 2
          ? [Math.max(2, Math.min(16, Number(m.size[0]) || 8)), Math.max(2, Math.min(12, Number(m.size[1]) || 5))]
          : [8, 5],
        tokens: Array.isArray(m.tokens)
          ? m.tokens.slice(0, 30).filter((t) => t && Array.isArray(t.pos) && t.pos.length === 2).map((t) => ({
              id: String(t.id || "").slice(0, 64),
              label: String(t.label || "?").slice(0, 24),
              kind: ["player", "ally", "enemy", "boss", "feature"].includes(t.kind) ? t.kind : "feature",
              pos: [Math.max(0, Math.min(15, Number(t.pos[0]) || 0)), Math.max(0, Math.min(11, Number(t.pos[1]) || 0))],
            }))
          : [],
      };
      try { await setMap(roomCode, cleaned); } catch {}
    }

    // If a roll is needed, auto-roll and chain the next call.
    if (mechanics?.needsRoll?.playerId && room.players?.[mechanics.needsRoll.playerId]) {
      room = await autoRollAndPost({ roomCode, room, needsRoll: mechanics.needsRoll });
      // Keep currentTurn as the rolling player so the next prompt frames it correctly.
      const stayUid = mechanics.needsRoll.playerId;
      if (room.currentTurn !== stayUid) {
        await setCurrentTurn(roomCode, stayUid);
        room = { ...room, currentTurn: stayUid };
      }
      continue; // chain
    }

    break; // no more rolls — done
  }

  // Advance the turn at the end of the chain.
  const nextUid = lastMechanics?.nextTurn || nextTurnUid(room.turnOrder, room.currentTurn);
  if (nextUid && room.players?.[nextUid]) {
    await setCurrentTurn(roomCode, nextUid);
  }

  await clearPendingActions(roomCode);
}

// Whether the host should run a DM turn now. Two cases:
// 1. No DM message has been posted yet AND the host has registered a character
//    AND there's a "Campaign begins." system message → run opening turn.
// 2. The current-turn player has submitted a pending action.
export function shouldRunDmTurn(room) {
  if (!room) return false;
  const msgs = Object.values(room.messages || {});
  const hasAnyDmMsg = msgs.some((m) => m && m.type === "dm");
  const hasCampaignBegan = msgs.some((m) => m && m.type === "system" && /Campaign begins/i.test(m.content || ""));
  const hostRegistered = room.host && room.players && room.players[room.host];

  if (!hasAnyDmMsg && hasCampaignBegan && hostRegistered) return true;

  const cur = room.currentTurn;
  if (cur && room.pendingActions && room.pendingActions[cur]) return true;
  return false;
}

// Plant the "Campaign begins." marker so all clients see the opening prompt
// and the host's listener triggers an opening DM call.
export async function triggerCampaignStart({ roomCode }) {
  await postMessage(roomCode, {
    author: "system",
    authorName: "system",
    type: "system",
    content: "Campaign begins.",
  });
}
