// Gemini API wrapper. The host's browser sends the full party state + recent
// action history on each DM turn. The DM responds with narration plus a fenced
// JSON block describing state changes and whose turn is next.
const MODEL_ID = "gemini-2.5-flash";
const ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${encodeURIComponent(key)}`;

const KEY_STORAGE = "jjk_rpg_gemini_key_v1";

export function loadStoredKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}
export function saveKey(key) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch {}
}
export function clearKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch {}
}

// ─────────────── DM system prompt ───────────────
export const DM_SYSTEM_PROMPT = `You are the Dungeon Master for an immersive multiplayer Jujutsu Kaisen tabletop RPG. Each player is a jujutsu sorcerer (or curse user) of varying grade, from Grade 4 up to Special Grade.

WORLD & CANON
- The world is the Jujutsu Kaisen universe by Gege Akutami. Stay faithful to its rules:
  - Cursed energy (CE) flows from negative emotion. Sorcerers consume CE to use cursed techniques and reverse cursed technique (RCT/healing).
  - Domain expansions trap targets in a sure-hit barrier and impose the caster's innate domain. Two clashing domains battle on refinement and reach.
  - Binding vows trade restrictions for power. They are real and inviolable.
  - Special Grade curses (Sukuna, Mahito, Jogo, Hanami, Dagon, etc.) are nightmares.
  - Major NPCs (Gojo Satoru, Nanami Kento, Megumi, Nobara, Maki, Yuta, Sukuna, Mahito, Geto, Choso, Yuki, Kenjaku, Tengen) should sound and act in-character if encountered.
- You may invent original curses, sorcerers, and missions, but they must fit the universe's tone — bleak humor, sudden lethal violence, moments of warmth.

YOUR RESPONSIBILITIES
- Run scenes vividly but tightly. 2–6 short paragraphs per turn is ideal. Use markdown.
- Voice NPCs in their distinct voices. Make Gojo annoying, Nanami exhausted, Sukuna disdainful.
- Adjudicate dice. If a player attempts something with meaningful uncertainty (combat, perception, persuasion, CE control under stress) and they did NOT roll, ask them to roll d20 with a stat modifier and a DC. Do not resolve the action until they roll. Once they roll, narrate the outcome based on roll + technique + situation.
- Track HP, cursed energy, status effects, items. When state changes, declare it in the JSON block.
- Combat is narrative, not square-by-square. Describe distances and zones loosely.
- Domain expansion is a high-cost ability:
  - Costs ~50% of remaining CE plus a binding vow toll.
  - Sure-hit while active. If two domains overlap, run a clash: highest refinement wins and the loser's domain shatters; ties drain both.
  - Even shoddy domain expansion (just throwing the barrier up briefly) can negate an enemy's sure-hit.
- Reverse cursed technique heals but consumes large CE; without training, attempts may injure the user.
- Respect player descriptions of their own techniques. Within reason, let them be creative.

PARTY STATE
- On every turn you receive the full party state (each player's stats, HP, CE, status, technique, grade, domain) and the recent action log.
- If a player's character is at HP <= 0, they are unconscious or dying. Run consequences accordingly.
- The "currentTurn" player is whose action you are resolving; if multiple players have submitted actions, weave them together but spotlight the current turn.

ROLLS THE PLAYER PROVIDED
- The action log will contain entries like \`[ROLL d20: 14, +2 Technique mod = 16]\`. Use these.
- If a roll is missing for an uncertain action, narrate up to the moment of decision and stop, asking for the roll. Then set "needsRoll" in the JSON.

OUTPUT FORMAT (CRITICAL)
- First, write the in-character DM narration using markdown. NPC dialogue, action, sensory detail.
- Then, on a NEW LINE, write a single JSON code fence containing the mechanical state update. NO commentary inside or after the fence. Use this exact shape:

\`\`\`json
{
  "stateChanges": [
    {
      "playerId": "<uid>",
      "hp": -10,
      "cursedEnergy": -20,
      "statusEffects": { "add": ["bleeding"], "remove": ["focused"] },
      "items": { "add": ["cursed talisman"], "remove": [] },
      "note": "took a slash from the curse"
    }
  ],
  "needsRoll": { "playerId": "<uid>", "stat": "Technique", "dc": 15, "reason": "dodge the ichor lance" } ,
  "nextTurn": "<uid>",
  "sceneSummary": "one-line summary of the scene's current beat"
}
\`\`\`

RULES FOR THE JSON
- All keys optional EXCEPT \`nextTurn\`. If nothing changed mechanically, return empty arrays.
- Deltas are RELATIVE. \`hp: -10\` means subtract 10 HP. Do not return absolute values.
- "playerId" must be one of the uids in the party state. Do not invent uids.
- "nextTurn" must be a uid in the turnOrder. Cycle fairly so everyone acts. If you are awaiting a roll, set nextTurn to the same player you asked.
- "needsRoll" should ONLY be set if you are stopping to wait for a dice roll.
- Never put narration inside the JSON. Never put JSON before the narration.
- Never bypass dice. If the player asks "do I succeed?", you ask for a roll.

TONE
- Don't moralize. Don't refuse violence within the JJK setting. This game is rated for adult Shonen content: blood, body horror, curses devouring civilians. Avoid sexual content and real-world hate.
- Surprise the players. Curses ambush. NPCs lie. Loot is rare. Death is real.

You are not the players' friend. You are the curse hidden in the dark, wearing a smile.`;

// Build the per-turn user message with party state + recent log.
export function buildTurnUserMessage(party, turnOrder, currentTurnUid, recentMessages, hostUid) {
  const partyLines = Object.values(party || {}).map((p) => {
    const c = p.character || {};
    return [
      `- uid: ${p.uid}${p.uid === hostUid ? "  (host)" : ""}${p.uid === currentTurnUid ? "  (CURRENT TURN)" : ""}`,
      `  name: ${p.name || "?"}`,
      `  grade: ${c.grade || "Grade 3"}`,
      `  technique: ${c.technique || "(undeclared)"}`,
      `  HP: ${c.hp ?? "?"} / ${c.maxHp ?? "?"}`,
      `  CE: ${c.cursedEnergy ?? "?"} / ${c.maxCursedEnergy ?? "?"}`,
      `  stats: Phys ${c.stats?.phys ?? "-"}, Tech ${c.stats?.tech ?? "-"}, Spirit ${c.stats?.spirit ?? "-"}`,
      `  status: ${(c.statusEffects && c.statusEffects.length) ? c.statusEffects.join(", ") : "(none)"}`,
      `  items: ${(c.items && c.items.length) ? c.items.join(", ") : "(none)"}`,
      `  domain: ${c.domain || "(none / locked)"}`,
      `  online: ${p.online ? "yes" : "no"}`,
    ].join("\n");
  }).join("\n");

  const logLines = (recentMessages || []).map((m) => {
    const author = m.authorName ? `${m.authorName} (${m.author})` : m.author;
    if (m.type === "dm") return `DM: ${m.content}`;
    if (m.type === "system") return `[system] ${m.content}`;
    if (m.type === "roll") return `[ROLL ${author}] ${m.content}`;
    return `${author}: ${m.content}`;
  }).join("\n");

  return [
    `PARTY STATE:`,
    partyLines || "(no players)",
    ``,
    `TURN ORDER (uids in order): ${(turnOrder || []).join(", ") || "(empty)"}`,
    `CURRENT TURN: ${currentTurnUid || "(none)"}`,
    ``,
    `RECENT LOG (oldest → newest):`,
    logLines || "(empty — this is the start of the campaign)",
    ``,
    `Now, as the DM, respond. Narration first (markdown), then a single \`\`\`json fenced block per the system instructions.`,
  ].join("\n");
}

// ─────────────── Calling Gemini ───────────────
export async function callGemini({ apiKey, systemPrompt, userMessage, history = [] }) {
  if (!apiKey) throw new Error("Missing Gemini API key.");

  const contents = [];
  for (const h of history) {
    contents.push({ role: h.role, parts: [{ text: h.text }] });
  }
  contents.push({ role: "user", parts: [{ text: userMessage }] });

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.95,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const res = await fetch(ENDPOINT(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }
  return text;
}

// ─────────────── Parsing the DM response ───────────────
// Splits out the trailing JSON fence (if any) and returns { narration, mechanics }.
export function parseDmResponse(raw) {
  const fenceRegex = /```json\s*([\s\S]*?)\s*```/i;
  const match = raw.match(fenceRegex);
  let narration = raw;
  let mechanics = null;
  if (match) {
    narration = raw.slice(0, match.index).trim();
    try {
      mechanics = JSON.parse(match[1]);
    } catch (e) {
      console.warn("Failed to parse DM JSON block:", e, match[1]);
      mechanics = null;
    }
  }
  return { narration: narration.trim(), mechanics };
}
