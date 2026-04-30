// Room state helpers + DM-turn orchestration. Only the host calls Gemini.
import {
  postMessage,
  setCurrentTurn,
  updatePlayerCharacter,
  setPendingAction,
  clearPendingActions,
  setObjective,
  setMap,
  setActionPrompt,
  clearVotes,
} from "../firebase.js";
import { applyMechanicsToCharacter, summarizeChange, rollWithStat, formatRoll } from "./combat.js";
import {
  buildTurnUserMessage,
  callDm,
  DM_SYSTEM_PROMPT,
  parseDmResponse,
  hostHasDmProvider,
  generateAbilities,
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
  // Submitting an action consumes the current options menu for this player.
  await setActionPrompt(roomCode, null);
  await clearVotes(roomCode);
}

// Tally a group-vote and decide the winner once all online players have voted.
// Returns the winning option text + count, or null if voting still open.
export function tallyVotes(room) {
  const prompt = room?.actionPrompt;
  if (!prompt || prompt.optionMode !== "group" || !Array.isArray(prompt.options)) return null;
  const onlineUids = Object.values(room.players || {})
    .filter((p) => p && p.character)
    .map((p) => p.uid);
  const votes = room.votes || {};
  const eligible = onlineUids;
  const cast = eligible.filter((u) => votes[u]);
  if (!eligible.length) return null;
  if (cast.length < eligible.length) return null; // still waiting

  const counts = {};
  for (const u of cast) {
    const v = votes[u];
    counts[v] = (counts[v] || 0) + 1;
  }
  let bestId = null, bestCount = 0;
  for (const [id, c] of Object.entries(counts)) {
    if (c > bestCount) { bestId = id; bestCount = c; }
  }
  const opt = prompt.options.find((o) => o.id === bestId);
  return opt ? { option: opt, count: bestCount, total: cast.length } : null;
}

// Re-fetch the room state (passed via callback so we don't import firebase get
// at module scope unnecessarily). The host always passes the latest snapshot in.
async function callDmOnce({ roomCode, room, hostUid }) {
  const messages = messagesArray(room.messages).slice(-30);
  const userMsg = buildTurnUserMessage(
    room.players,
    room.turnOrder,
    room.currentTurn,
    messages,
    hostUid
  );

  const raw = await callDm({
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
  if (!hostHasDmProvider()) {
    await postMessage(roomCode, {
      author: "system",
      authorName: "system",
      type: "system",
      content: "Host has no DM provider configured; DM is silent.",
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
      result = await callDmOnce({ roomCode, room, hostUid });
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
          ? m.tokens.slice(0, 30).filter((t) => t && Array.isArray(t.pos) && t.pos.length === 2).map((t) => {
              const tok = {
                id: String(t.id || "").slice(0, 64),
                label: String(t.label || "?").slice(0, 24),
                kind: ["player", "ally", "enemy", "boss", "feature"].includes(t.kind) ? t.kind : "feature",
                pos: [Math.max(0, Math.min(15, Number(t.pos[0]) || 0)), Math.max(0, Math.min(11, Number(t.pos[1]) || 0))],
              };
              const hp = Number(t.hp);
              const maxHp = Number(t.maxHp);
              if (Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0) {
                tok.hp = Math.max(0, Math.min(9999, Math.round(hp)));
                tok.maxHp = Math.max(1, Math.min(9999, Math.round(maxHp)));
              }
              return tok;
            })
          : [],
      };
      try { await setMap(roomCode, cleaned); } catch {}
    }

    // Action prompt + options. Cleared on next DM turn so we don't carry stale buttons.
    const optionsArr = Array.isArray(mechanics?.options) ? mechanics.options : [];
    const cleanedOptions = optionsArr
      .map((o, idx) => {
        const text = typeof o === "string" ? o : (o && typeof o.text === "string" ? o.text : null);
        if (!text) return null;
        return { id: String(o?.id || `opt-${idx}`).slice(0, 16), text: text.slice(0, 100) };
      })
      .filter(Boolean)
      .slice(0, 5);
    if (cleanedOptions.length) {
      const optionMode = mechanics?.optionMode === "group" ? "group" : "individual";
      const forUid = optionMode === "individual" ? (mechanics?.nextTurn || room.currentTurn) : null;
      try {
        await setActionPrompt(roomCode, {
          options: cleanedOptions,
          optionMode,
          forUid,
          openedAt: Date.now(),
        });
        await clearVotes(roomCode);
      } catch {}
    } else {
      // No options on this turn — clear any stale prompt.
      try {
        await setActionPrompt(roomCode, null);
        await clearVotes(roomCode);
      } catch {}
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

// Whether the host should run a DM turn now.
//   1. Opening turn: campaign begun + no DM message yet + host registered.
//   2. Any pending action exists (a player submitted, OR group vote resolved).
export function shouldRunDmTurn(room) {
  if (!room) return false;
  const msgs = Object.values(room.messages || {});
  const hasAnyDmMsg = msgs.some((m) => m && m.type === "dm");
  const hasCampaignBegan = msgs.some((m) => m && m.type === "system" && /Campaign begins/i.test(m.content || ""));
  const hostRegistered = room.host && room.players && room.players[room.host];

  if (!hasAnyDmMsg && hasCampaignBegan && hostRegistered) return true;

  const pendings = room.pendingActions || {};
  if (Object.keys(pendings).length > 0) return true;
  return false;
}

// Submit the resolved group-vote as a party action so the DM picks it up.
export async function submitPartyAction({ roomCode, content, count, total }) {
  const tag = count != null ? ` (${count}/${total})` : "";
  await postMessage(roomCode, {
    author: "__party__",
    authorName: `Party${tag}`,
    type: "player",
    content,
  });
  await setPendingAction(roomCode, "__party__", {
    content,
    rolls: [],
    submittedAt: Date.now(),
  });
  await setActionPrompt(roomCode, null);
  await clearVotes(roomCode);
}

// Host-only: scan the party for any player whose character has a technique
// but no abilities yet, and generate a set for them via Gemini. Runs one
// player at a time to keep API quota predictable. Surfaces both successes
// and failures as system messages so the host (and players) can see what
// happened instead of having to open the console.
export async function generateMissingAbilities({ roomCode, room }) {
  if (!hostHasDmProvider()) return;
  const players = Object.values(room.players || {});
  for (const p of players) {
    const c = p.character;
    if (!c) continue;
    const tech = (c.technique || "").trim();
    const hasAbilities = Array.isArray(c.abilities) && c.abilities.length > 0;
    if (!tech || tech === "(undeclared technique)" || hasAbilities) continue;
    await generateAbilitiesForPlayer({ roomCode, player: p });
  }
}

// Host-only: regenerate abilities for a specific player on demand. Used by
// the regenerate button on the party panel.
export async function regenerateForPlayer({ roomCode, player }) {
  if (!hostHasDmProvider()) {
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: "Cannot regenerate — host has no DM provider configured.",
    });
    return;
  }
  await generateAbilitiesForPlayer({ roomCode, player, forced: true });
}

async function generateAbilitiesForPlayer({ roomCode, player, forced = false }) {
  const c = player.character || {};
  const tech = (c.technique || "").trim();
  if (!tech || tech === "(undeclared technique)") {
    if (forced) {
      await postMessage(roomCode, {
        author: "system", authorName: "system", type: "system",
        content: `Cannot generate for ${c.name || "player"} — no technique described.`,
      });
    }
    return;
  }
  try {
    const { abilities, stats } = await generateAbilities({
      technique: tech,
      grade: c.grade,
    });
    if (!abilities.length && !stats) {
      await postMessage(roomCode, {
        author: "system", authorName: "system", type: "system",
        content: `Generation returned nothing for ${c.name}. Try regenerating.`,
      });
      return;
    }
    const updated = {
      ...c,
      ...(abilities.length ? { abilities } : {}),
      ...(stats ? { stats } : {}),
    };
    await updatePlayerCharacter(roomCode, player.uid, updated);
    const bits = [];
    if (abilities.length) bits.push(`abilities: ${abilities.map((a) => a.name).join(", ")}`);
    if (stats) bits.push(`stats: P${stats.phys}/T${stats.tech}/S${stats.spirit}`);
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: `Generated for ${c.name} — ${bits.join(" · ")}`,
    });
  } catch (err) {
    console.warn("Ability gen failed for", player.uid, err);
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: `Could not generate abilities for ${c.name || "player"}: ${err.message}. Host can click ↻ on their card to retry.`,
    });
  }
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
