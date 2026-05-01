// Room state helpers + DM-turn orchestration. Only the host calls Gemini.
import {
  postMessage,
  deleteMessage,
  setCurrentTurn,
  updatePlayerCharacter,
  setPendingAction,
  clearPendingActions,
  setObjective,
  setMap,
  setActionPrompt,
  clearVotes,
  castVote,
  setLastSnapshot,
  restoreFromSnapshot,
} from "../firebase.js";
import { applyMechanicsToCharacter, summarizeChange, rollWithStat, formatRoll } from "./combat.js";
import {
  buildTurnUserMessage,
  callDm,
  buildSystemPrompt,
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
  // Don't clear votes here — that would let any joiner wipe other players' votes
  // mid-tally. The host's runDmTurn handles prompt+vote teardown at the end of
  // the chain.
  // We also leave actionPrompt alone; the host clears it after the next DM call.
}

// Returns the canonical eligible-voters list. Both tallyVotes and the UI
// tally must use this so they never disagree.
export function eligibleVoterUids(room) {
  return Object.values(room?.players || {})
    .filter((p) => p && p.uid && p.character)
    .map((p) => p.uid);
}

// Tally a group-vote and decide the winner once all eligible players have voted.
// Returns the winning option text + count, or null if voting still open.
// Deterministic tie-break: when two options tie, the one that appears EARLIER
// in prompt.options wins (so the order is stable across browsers).
export function tallyVotes(room) {
  const prompt = room?.actionPrompt;
  if (!prompt || prompt.optionMode !== "group" || !Array.isArray(prompt.options)) return null;
  // If a previous tally already resolved this prompt, don't double-fire.
  if (room?.votes && room.votes.__resolved) return null;

  const eligible = eligibleVoterUids(room);
  if (eligible.length < 1) return null;

  const votes = room.votes || {};
  const validOptionIds = new Set(prompt.options.map((o) => o.id));
  const cast = eligible.filter((u) => votes[u] && validOptionIds.has(votes[u]));
  if (cast.length < eligible.length) return null;

  const counts = {};
  for (const u of cast) counts[votes[u]] = (counts[votes[u]] || 0) + 1;

  // Iterate prompt.options in order so ties resolve to the first-listed.
  let bestId = null, bestCount = 0;
  for (const opt of prompt.options) {
    const c = counts[opt.id] || 0;
    if (c > bestCount) { bestId = opt.id; bestCount = c; }
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
    systemPrompt: buildSystemPrompt(room.dmTone),
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

export async function runDmTurn({ roomCode, room: initialRoom, hostUid, isRerun = false }) {
  if (!hostHasDmProvider()) {
    await postMessage(roomCode, {
      author: "system",
      authorName: "system",
      type: "system",
      content: "Host has no DM provider configured; DM is silent.",
    });
    return;
  }

  // Capture a snapshot of the room's mutable state BEFORE we start mutating
  // anything. The host can use this to undo the run if the DM was bad.
  // Includes turnOrder + pendingActions so a rerun after a kick or a
  // resolved vote restores the full game state, not just the slice.
  if (!isRerun) {
    try {
      const snapshot = {
        players: initialRoom.players ? JSON.parse(JSON.stringify(initialRoom.players)) : {},
        objective: initialRoom.objective ?? null,
        map: initialRoom.map ?? null,
        actionPrompt: initialRoom.actionPrompt ?? null,
        votes: initialRoom.votes ?? null,
        currentTurn: initialRoom.currentTurn ?? null,
        turnOrder: Array.isArray(initialRoom.turnOrder) ? [...initialRoom.turnOrder] : [],
        pendingActions: initialRoom.pendingActions ? JSON.parse(JSON.stringify(initialRoom.pendingActions)) : {},
        messageIdsBefore: Object.keys(initialRoom.messages || {}),
        capturedAt: Date.now(),
      };
      await setLastSnapshot(roomCode, snapshot);
    } catch (err) {
      console.warn("Failed to capture pre-run snapshot:", err);
    }
  }

  // Post the "thinking" indicator and remember its id so we can DELETE it
  // when the DM actually responds. Otherwise the chat log fills up with stale
  // "thinking" entries from queued actions.
  const thinkingMsgId = await postMessage(roomCode, {
    author: "system",
    authorName: "system",
    type: "system",
    content: isRerun ? "The DM reconsiders…" : "The DM gathers their thoughts…",
  });

  let room = initialRoom;
  let lastMechanics = null;
  let chainOptionsStaged = [];
  let chainOptionMode = "individual";
  let chainNextUidHint = null;

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
      // Drop any stale prompt/votes so players aren't stuck on an old menu.
      try { await setActionPrompt(roomCode, null); await clearVotes(roomCode); } catch {}
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
      // Delete the "thinking" placeholder now that the real DM message is up.
      if (thinkingMsgId && i === 0) {
        try { await deleteMessage(roomCode, thinkingMsgId); } catch {}
      }
    } else if (i === 0) {
      // The DM returned an empty narration on the FIRST chain step. If we
      // don't post anything, shouldRunDmTurn's opening trigger will re-fire
      // forever because hasAnyDmMsg stays false. Post a placeholder so the
      // loop breaks; the host can hit ↻ rerun if the DM keeps doing this.
      await postMessage(roomCode, {
        author: "dm",
        authorName: "DM",
        type: "dm",
        content: "_(The DM returned no narration. Use the ↻ rerun button to retry.)_",
      });
      if (thinkingMsgId) {
        try { await deleteMessage(roomCode, thinkingMsgId); } catch {}
      }
    }

    // Apply mechanical state changes per player.
    if (mechanics?.stateChanges?.length) {
      for (const change of mechanics.stateChanges) {
        const player = room.players?.[change.playerId];
        if (!player) continue;
        const newChar = applyMechanicsToCharacter(player.character, change);
        // _levelUp is a transient marker — strip before persisting.
        const promotedTo = newChar._levelUp;
        if (promotedTo) delete newChar._levelUp;
        await updatePlayerCharacter(roomCode, change.playerId, newChar);
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
        // Post a celebratory level-up message for each grade crossed.
        if (Array.isArray(promotedTo) && promotedTo.length) {
          for (const grade of promotedTo) {
            await postMessage(roomCode, {
              author: "system",
              authorName: "system",
              type: "system",
              content: `🌀 LEVEL UP — ${player.name} promoted to ${grade}.`,
            });
          }
        }
      }
    }

    // Update objective if the DM set one.
    if (typeof mechanics?.objective === "string" && mechanics.objective.trim()) {
      try { await setObjective(roomCode, mechanics.objective.trim()); } catch {}
    }

    // Update the scene map if the DM provided one. Merge with the previous
    // map so dropped player tokens don't disappear when the DM forgets them.
    if (mechanics?.map && typeof mechanics.map === "object") {
      const m = mechanics.map;
      const cleanedTokens = (Array.isArray(m.tokens) ? m.tokens : [])
        .slice(0, 30)
        .filter((t) => t && Array.isArray(t.pos) && t.pos.length === 2)
        .map((t) => {
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
        });

      // Auto-inject a player token for anyone the DM forgot, reusing the prior
      // map's position if known, otherwise placing them in the bottom-left.
      const prevTokens = Array.isArray(room.map?.tokens) ? room.map.tokens : [];
      const presentIds = new Set(cleanedTokens.map((t) => t.id));
      for (const p of Object.values(room.players || {})) {
        if (!p.uid || !p.character) continue;
        if (presentIds.has(p.uid)) continue;
        const prev = prevTokens.find((t) => t.id === p.uid);
        cleanedTokens.push({
          id: p.uid,
          label: (p.character.name || "?").slice(0, 12),
          kind: "player",
          pos: prev?.pos ? prev.pos : [0, Math.max(0, (Array.isArray(m.size) ? Number(m.size[1]) : 5) - 1)],
        });
      }

      const cleaned = {
        scene: typeof m.scene === "string" ? m.scene.slice(0, 200) : "",
        size: Array.isArray(m.size) && m.size.length === 2
          ? [Math.max(2, Math.min(16, Number(m.size[0]) || 8)), Math.max(2, Math.min(12, Number(m.size[1]) || 5))]
          : [8, 5],
        tokens: cleanedTokens,
      };
      try { await setMap(roomCode, cleaned); } catch {}
    }

    // Stage options for THIS chain step. We commit at the end of the chain so
    // a mid-chain auto-roll continuation doesn't wipe the player's existing
    // vote / option panel.
    const optionsArr = Array.isArray(mechanics?.options) ? mechanics.options : [];
    chainOptionsStaged = optionsArr
      .map((o, idx) => {
        const text = typeof o === "string" ? o : (o && typeof o.text === "string" ? o.text : null);
        if (!text) return null;
        return { id: String(o?.id || `opt-${idx}`).slice(0, 16), text: text.slice(0, 100) };
      })
      .filter(Boolean)
      .slice(0, 5);
    chainOptionMode = mechanics?.optionMode === "group" ? "group" : "individual";
    chainNextUidHint = mechanics?.nextTurn || null;

    // If a roll is needed, auto-roll and chain the next call. The DM's
    // suggested playerId must match the current turn — otherwise a
    // hallucinated needsRoll could steal someone else's turn.
    const needsRoll = mechanics?.needsRoll;
    const validRollPlayer = needsRoll?.playerId
      && room.players?.[needsRoll.playerId]
      && (needsRoll.playerId === room.currentTurn || needsRoll.playerId === "__party__" === false);
    if (needsRoll?.playerId && room.players?.[needsRoll.playerId]) {
      // Hard guard: only auto-roll for the actual current-turn player.
      if (needsRoll.playerId !== room.currentTurn) {
        await postMessage(roomCode, {
          author: "system", authorName: "system", type: "system",
          content: `DM tried to auto-roll for ${room.players[needsRoll.playerId]?.name || needsRoll.playerId} but it's not their turn — skipping.`,
        });
        break;
      }
      room = await autoRollAndPost({ roomCode, room, needsRoll });
      continue; // chain
    }

    break; // no more rolls — done
  }

  // Commit the staged action prompt at the END of the chain. If the DM never
  // emitted options on any step, clear any prior stale prompt + votes.
  // clearVotes also wipes the "__resolved" sentinel so a fresh group vote
  // starts clean.
  try {
    if (chainOptionsStaged.length) {
      const nextUid = chainNextUidHint || lastMechanics?.nextTurn || nextTurnUid(room.turnOrder, room.currentTurn);
      const forUid = chainOptionMode === "individual"
        ? (nextUid && room.players?.[nextUid] && nextUid !== "__party__" ? nextUid : null)
        : null;
      await clearVotes(roomCode); // do this BEFORE setting the new prompt
      await setActionPrompt(roomCode, {
        options: chainOptionsStaged,
        optionMode: chainOptionMode,
        forUid,
        openedAt: Date.now(),
      });
    } else {
      await setActionPrompt(roomCode, null);
      await clearVotes(roomCode);
    }
  } catch {}

  // Advance the turn at the end of the chain.
  const nextUid = lastMechanics?.nextTurn || nextTurnUid(room.turnOrder, room.currentTurn);
  if (nextUid && room.players?.[nextUid] && room.turnOrder?.includes(nextUid)) {
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
// Idempotent against double-fire: stamps `votes.__resolved` first; subsequent
// calls of tallyVotes will short-circuit on that flag.
export async function submitPartyAction({ roomCode, content, count, total, optionId }) {
  // Stamp the resolution before doing the rest so a fast next snapshot can't
  // re-tally the same vote and submit a duplicate party action.
  if (optionId) {
    try { await castVote(roomCode, "__resolved", optionId); } catch {}
  }
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
  // Don't clear here — the host will run runDmTurn which clears at chain start.
}

// Host-only: scan the party for any player whose character either:
//   (a) has a technique but no abilities yet, OR
//   (b) is flagged with _needsRebalance because they joined with a saved
//       build whose grade doesn't match the room's locked grade.
// Generates / regenerates abilities + stats at the player's CURRENT grade.
export async function generateMissingAbilities({ roomCode, room }) {
  if (!hostHasDmProvider()) return;
  const players = Object.values(room.players || {});
  for (const p of players) {
    const c = p.character;
    if (!c) continue;
    const tech = (c.technique || "").trim();
    if (!tech || tech === "(undeclared technique)") continue;

    const needsRebalance = !!c._needsRebalance;
    const hasAbilities = Array.isArray(c.abilities) && c.abilities.length > 0;
    if (!hasAbilities || needsRebalance) {
      await generateAbilitiesForPlayer({ roomCode, player: p, isRebalance: needsRebalance });
    }
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

async function generateAbilitiesForPlayer({ roomCode, player, forced = false, isRebalance = false }) {
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
      // Always clear the rebalance flags after a successful regen.
      _needsRebalance: false,
      _rebalanceFrom: null,
    };
    await updatePlayerCharacter(roomCode, player.uid, updated);
    const bits = [];
    if (abilities.length) bits.push(`abilities: ${abilities.map((a) => a.name).join(", ")}`);
    if (stats) bits.push(`stats: P${stats.phys}/T${stats.tech}/S${stats.spirit}`);
    const verb = isRebalance ? "Rebalanced" : "Generated";
    const fromTag = (isRebalance && c._rebalanceFrom && c._rebalanceFrom !== c.grade)
      ? ` (${c._rebalanceFrom} → ${c.grade})` : "";
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: `${verb} for ${c.name}${fromTag} — ${bits.join(" · ")}`,
    });
  } catch (err) {
    console.warn("Ability gen failed for", player.uid, err);
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: `Could not ${isRebalance ? "rebalance" : "generate"} abilities for ${c.name || "player"}: ${err.message}. Host can click ↻ on their card to retry.`,
    });
  }
}

// Host action: revert to the snapshot captured before the most recent DM run,
// then re-call the DM with the same context. Used when the DM hallucinates
// or breaks canon.
export async function rerunLastDmTurn({ roomCode, room, hostUid }) {
  if (!hostHasDmProvider()) {
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: "Cannot rerun — host has no DM provider configured.",
    });
    return;
  }
  const snap = room?._lastSnapshot;
  if (!snap || !snap.players) {
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: "Nothing to rerun yet.",
    });
    return;
  }
  // Restore the snapshot's state.
  try {
    await restoreFromSnapshot(roomCode, snap);
  } catch (err) {
    console.error("Snapshot restore failed:", err);
    await postMessage(roomCode, {
      author: "system", authorName: "system", type: "system",
      content: `Rerun failed: ${err.message}`,
    });
    return;
  }
  await postMessage(roomCode, {
    author: "system", authorName: "system", type: "system",
    content: "↻ Reverting to before the last DM turn.",
  });
  // Build a synthetic restored room state to pass into the DM call. The
  // listener will catch up shortly with the real Firebase state, but we
  // shouldn't wait for that round-trip.
  const restoredRoom = {
    ...room,
    players: snap.players,
    objective: snap.objective ?? null,
    map: snap.map ?? null,
    actionPrompt: snap.actionPrompt ?? null,
    votes: snap.votes ?? null,
    currentTurn: snap.currentTurn ?? null,
    messages: Object.fromEntries(
      Object.entries(room.messages || {}).filter(([id]) => (snap.messageIdsBefore || []).includes(id))
    ),
  };
  // Re-run with isRerun=true so we don't capture a NEW snapshot (we want to
  // be able to rerun-the-rerun and end up at the same place).
  await runDmTurn({ roomCode, room: restoredRoom, hostUid, isRerun: true });
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
