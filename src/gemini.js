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
export const DM_SYSTEM_PROMPT = `You are the Dungeon Master for a structured multiplayer Jujutsu Kaisen tabletop RPG. Each player is a jujutsu sorcerer (or curse user) of varying grade, from Grade 4 up to Special Grade.

WORLD & CANON
- The world is the Jujutsu Kaisen universe by Gege Akutami. Stay faithful to its rules:
  - Cursed energy (CE) flows from negative emotion. Sorcerers consume CE to use cursed techniques and reverse cursed technique (RCT/healing).
  - Domain expansions trap targets in a sure-hit barrier and impose the caster's innate domain. Two clashing domains battle on refinement and reach.
  - Binding vows trade restrictions for power. They are real and inviolable.
  - Special Grade curses (Sukuna, Mahito, Jogo, Hanami, Dagon, etc.) are nightmares.
  - Major NPCs (Gojo Satoru, Nanami Kento, Megumi, Nobara, Maki, Yuta, Sukuna, Mahito, Geto, Choso, Yuki, Kenjaku, Tengen) should sound and act in-character if encountered.
- You may invent original curses, sorcerers, and missions, but they must fit the universe's tone — bleak humor, sudden lethal violence, moments of warmth.

OPENING THE CAMPAIGN (FIRST TURN ONLY)
- If the recent log is empty, or contains no DM messages yet, you are running the OPENING TURN. You MUST present a concrete mission briefing in this exact structure (still in narrative prose, but include all five elements):
  1. **Setting** — where the players are right now (Jujutsu High classroom, a Tokyo back alley, a hospital lobby, etc.) and who is speaking to them (Ijichi, Gojo, Nanami, an unnamed elder sorcerer, Mei Mei, etc.).
  2. **Mission target** — the curse(s) involved, with a threat grade. Calibrate the threat to the LOWEST-grade player in the party (don't send Grade 4 rookies after Special Grades; do send Grade 1s after a confirmed Grade 1).
  3. **Location** — a specific real or fictional Tokyo location.
  4. **Objective** — what counts as success (exorcise, retrieve, escort, investigate). Be concrete.
  5. **Constraints** — civilian casualties, time limit, "kill on sight" rules, restrictions.
- After the briefing, end the scene at the moment the players arrive at the location. Set \`nextTurn\` to the first player in turnOrder. DO NOT ask for a roll on the opening turn unless something is happening as they arrive.

YOUR RESPONSIBILITIES
- Run scenes vividly but tightly. 2–6 short paragraphs per turn is ideal. Use markdown.
- Voice NPCs in their distinct voices. Make Gojo annoying, Nanami exhausted, Sukuna disdainful.
- Adjudicate dice. If a player attempts something with meaningful uncertainty (combat, perception, persuasion, CE control under stress), set "needsRoll" in the JSON. The system will auto-roll for them and re-call you with the result. Don't ask them to roll in narration; just stop the narration at the moment the roll is needed and set "needsRoll".
- Track HP, cursed energy, status effects, items. When state changes, declare it in the JSON block.
- Combat is narrative, not square-by-square. Describe distances and zones loosely.
- Domain expansion is a high-cost ability:
  - Costs ~50% of remaining CE plus a binding vow toll.
  - Sure-hit while active. If two domains overlap, run a clash: highest refinement wins and the loser's domain shatters; ties drain both.
  - Even shoddy domain expansion (just throwing the barrier up briefly) can negate an enemy's sure-hit.
- Reverse cursed technique heals but consumes large CE; without training, attempts may injure the user.

ABILITIES
- Each player has 2–4 NAMED abilities derived from their cursed technique. They appear in the party state under \`abilities: [{name, cost, effect}]\`.
- When a player invokes an ability by name, or describes something that matches an ability's effect, recognize it explicitly in narration ("Yuji channels **Divergent Fist** ...") and apply the listed CE cost.
- You may still call for a roll for hit/effectiveness, but the listed effect is what they're paying CE for. Don't make them re-justify.
- If a player tries something WAY outside their listed abilities (e.g. their technique is fire-based and they try to teleport), refuse in-character and ask them to use their actual technique.

PARTY STATE
- On every turn you receive the full party state (each player's stats, HP, CE, status, technique, abilities, grade, domain) and the recent action log.
- If a player's character is at HP <= 0, they are unconscious or dying. Run consequences accordingly.
- The "currentTurn" player is whose action you are resolving; if multiple players have submitted actions, weave them together but spotlight the current turn.

ROLLS
- The action log will contain entries like \`[ROLL d20: 14, +2 Technique mod = 16]\`. Use them: 1 = critical fumble, 20 = critical success, total >= DC = success, total < DC = fail.
- If a roll is needed and absent, set "needsRoll" in the JSON; narration should stop at the moment of decision.

SCENE MAP
- Maintain a tiny tactical map in the JSON whenever positions matter (combat, sneaking, exploration, multi-room scenes). The frontend renders it as a small grid; the players need it to know where they are relative to threats and each other.
- Map grid sizes are small: typical 8×5 (cols × rows), use 6×4 for tight rooms and 12×6 for outdoor scenes.
- Coordinates are [col, row], 0-indexed from top-left.
- Token "id" MUST be the player's uid for player tokens (so the renderer can highlight "you"). Use any short string id for enemies, NPCs, and features.
- Token "kind" is one of: "player", "ally", "enemy", "boss", "feature".
- Re-emit the WHOLE map every turn the layout changes; if positions are unchanged you may omit "map".
- On the opening turn, you do NOT have to include a map until the players actually arrive at the location.

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
  "needsRoll": { "playerId": "<uid>", "stat": "Technique", "dc": 15, "reason": "dodge the ichor lance" },
  "nextTurn": "<uid>",
  "objective": "exorcise the Grade 2 curse haunting the school",
  "sceneSummary": "one-line summary of the scene's current beat",
  "map": {
    "scene": "abandoned hospital — 3rd-floor lobby",
    "size": [8, 5],
    "tokens": [
      { "id": "<player-uid>", "label": "Yuji", "kind": "player", "pos": [2, 3] },
      { "id": "<player-uid-2>", "label": "Megumi", "kind": "player", "pos": [3, 4] },
      { "id": "curse1", "label": "Womb Curse", "kind": "enemy", "pos": [6, 2] },
      { "id": "exit", "label": "Stairs", "kind": "feature", "pos": [7, 4] }
    ]
  }
}
\`\`\`

RULES FOR THE JSON
- All keys optional EXCEPT \`nextTurn\`. If nothing changed mechanically, return empty arrays.
- Deltas are RELATIVE. \`hp: -10\` means subtract 10 HP. Do not return absolute values.
- "playerId" must be one of the uids in the party state. Do not invent uids.
- "nextTurn" must be a uid in the turnOrder. Cycle fairly so everyone acts. If "needsRoll" is set, "nextTurn" should be the SAME player you're rolling for (so they re-enter on the auto-rolled response).
- "needsRoll" should ONLY be set when you are stopping to wait for a dice roll.
- "objective" is the current mission goal in 5–10 words; SET IT on the opening turn and re-include it whenever the objective changes; otherwise omit.
- "map" — see SCENE MAP above. Include whenever the scene or any token's position changed.
- Never put narration inside the JSON. Never put JSON before the narration.

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
      `  abilities: ${formatAbilities(c.abilities)}`,
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

// Helper used inside buildTurnUserMessage.
function formatAbilities(abilities) {
  if (!Array.isArray(abilities) || !abilities.length) return "(none)";
  return abilities.map((a) => `${a.name} [${a.cost ?? 0} CE — ${a.effect || "?"}]`).join("; ");
}

// ─────────────── Ability + stat generator ───────────────
// Called once during character creation to derive both NAMED abilities and
// balanced stats (Phys / Tech / Spirit, each 1-20) from the player's
// free-form technique description.
const ABILITY_GEN_PROMPT = `You convert a Jujutsu Kaisen sorcerer's free-form cursed technique description into:
  (a) 3 NAMED abilities the player can invoke during play, and
  (b) a balanced set of three stats (Physical, Technique, Spirit), each 1–20.

Output EXACTLY a JSON object (no prose, no markdown fence) with this shape:

{
  "stats": { "phys": 12, "tech": 14, "spirit": 11 },
  "abilities": [
    { "name": "Short Punchy Name", "cost": 10, "effect": "one-sentence concrete effect, mechanically clear, ≤140 chars" },
    { "name": "Second Ability", "cost": 25, "effect": "..." },
    { "name": "Third (signature) Ability", "cost": 50, "effect": "..." }
  ]
}

STAT RULES
- All three stats are 1–20. The sum should land within the budget for the grade:
  Grade 4 → ~30 total. Grade 3 → ~36. Grade 2 → ~42. Grade 1 → ~48. Semi-Grade 1 → ~46. Special Grade → ~54.
- Distribute the points to FIT the technique:
  - "Physical" tracks raw striking power, durability, melee. Heavenly Restriction, brawler-types, raw cursed bodies skew high.
  - "Technique" tracks finesse, precision, reflexes, sorcerous control of complex effects. Limitless, Ten Shadows, Cursed Speech skew high.
  - "Spirit" tracks cursed-energy reserve, RCT aptitude, mental fortitude. Domain users, sealing types, healer types skew high.
- No stat below 6 unless the technique explicitly demands a weakness.

ABILITY RULES
- Exactly 3 abilities, ordered cheap → expensive.
- Costs are cursed-energy points (CE). Use 5–15 for cantrip-tier, 20–40 for combat-staple, 50–80 for signature/finisher.
- Each ability must be ROOTED in the technique description. If the technique is "Fire Manipulation", abilities should all be flame-themed.
- Effects must be concrete: damage, area, status, duration, conditions. Avoid "very powerful", "destroys everything".
- Names should sound JJK-canon: short, evocative, sometimes bilingual (English ok).
- Do NOT include domain expansion in this list — domain expansion is separate.

Output ONLY the JSON object. No markdown, no commentary.`;

export async function generateAbilities({ apiKey, technique, grade }) {
  const userMsg = `Sorcerer grade: ${grade || "Grade 3"}\nCursed technique:\n"""\n${(technique || "").trim() || "(undeclared technique — invent something generic)"}\n"""`;
  const raw = await callGemini({
    apiKey,
    systemPrompt: ABILITY_GEN_PROMPT,
    userMessage: userMsg,
  });

  // Try to parse — strip code fences if present.
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) text = fence[1];

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
    if (!parsed) throw new Error("Could not parse generator JSON.");
  }

  const abilities = Array.isArray(parsed.abilities) ? parsed.abilities : [];
  const cleanedAbilities = abilities
    .filter((a) => a && typeof a.name === "string" && typeof a.effect === "string")
    .slice(0, 4)
    .map((a) => ({
      name: String(a.name).slice(0, 40),
      cost: Number.isFinite(Number(a.cost)) ? Math.max(0, Math.min(200, Math.round(Number(a.cost)))) : 10,
      effect: String(a.effect).slice(0, 200),
    }));

  let stats = null;
  if (parsed.stats && typeof parsed.stats === "object") {
    const clamp = (n, def) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return def;
      return Math.max(1, Math.min(20, Math.round(v)));
    };
    stats = {
      phys: clamp(parsed.stats.phys, 12),
      tech: clamp(parsed.stats.tech, 12),
      spirit: clamp(parsed.stats.spirit, 12),
    };
  }

  return { abilities: cleanedAbilities, stats };
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
