// Room state helpers + DM-turn orchestration. Only the host calls Gemini.
import {
  postMessage,
  setCurrentTurn,
  updatePlayerCharacter,
  setPendingAction,
  clearPendingActions,
} from "../firebase.js";
import { applyMechanicsToCharacter, summarizeChange } from "./combat.js";
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
  // Append to the chat log immediately so all clients see it.
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
  // Mark a pending action so the host knows to call the DM.
  await setPendingAction(roomCode, uid, {
    content,
    rolls,
    submittedAt: Date.now(),
  });
}

// Host-side: take the current room snapshot, call Gemini, write back the response.
// `room` is the latest snapshot; returns nothing.
export async function runDmTurn({ roomCode, room, hostUid }) {
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

  const messages = messagesArray(room.messages).slice(-30); // last 30 entries
  const userMsg = buildTurnUserMessage(
    room.players,
    room.turnOrder,
    room.currentTurn,
    messages,
    hostUid
  );

  // Mark a system "DM is thinking" message so others see something is happening.
  const thinkingId = await postMessage(roomCode, {
    author: "system",
    authorName: "system",
    type: "system",
    content: "The DM gathers their thoughts…",
  });

  let raw;
  try {
    raw = await callGemini({
      apiKey,
      systemPrompt: DM_SYSTEM_PROMPT,
      userMessage: userMsg,
    });
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

  const { narration, mechanics } = parseDmResponse(raw);

  // Post the DM narration.
  await postMessage(roomCode, {
    author: "dm",
    authorName: "DM",
    type: "dm",
    content: narration || "(the DM falls silent)",
  });

  // Apply mechanical state changes per player.
  if (mechanics?.stateChanges?.length) {
    for (const change of mechanics.stateChanges) {
      const player = room.players?.[change.playerId];
      if (!player) continue;
      const newChar = applyMechanicsToCharacter(player.character, change);
      await updatePlayerCharacter(roomCode, change.playerId, newChar);
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

  // Surface "needsRoll" hints in chat — useful for the player whose turn it is.
  if (mechanics?.needsRoll?.playerId) {
    const r = mechanics.needsRoll;
    const target = room.players?.[r.playerId];
    if (target) {
      await postMessage(roomCode, {
        author: "system",
        authorName: "system",
        type: "system",
        content: `Roll needed — ${target.name}: d20 + ${r.stat || "stat"} mod vs DC ${r.dc ?? "?"} (${r.reason || "—"}).`,
      });
    }
  }

  // Advance the turn.
  const nextUid = mechanics?.nextTurn || nextTurnUid(room.turnOrder, room.currentTurn);
  if (nextUid && room.players?.[nextUid]) {
    await setCurrentTurn(roomCode, nextUid);
  }

  await clearPendingActions(roomCode);
}

// Decide whether the host should run a DM turn now.
// Trigger when: pendingActions has the current-turn player's submission.
export function shouldRunDmTurn(room) {
  if (!room) return false;
  const cur = room.currentTurn;
  if (!cur) return false;
  return Boolean(room.pendingActions && room.pendingActions[cur]);
}
