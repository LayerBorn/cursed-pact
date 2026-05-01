// Dice + applying state changes from the DM JSON block.
import { statModifier, XP_TO_NEXT, nextGrade, promoteCharacter } from "./character.js";

export function rollD20() {
  return 1 + Math.floor(Math.random() * 20);
}

// stat: "Physical" | "Technique" | "Spirit" (matches DM prompt vocabulary)
export function rollWithStat(character, statName) {
  const map = { Physical: "phys", Technique: "tech", Spirit: "spirit", phys: "phys", tech: "tech", spirit: "spirit" };
  const key = map[statName] || null;
  const stat = key ? character?.stats?.[key] : null;
  const mod = statModifier(stat ?? 10);
  const d = rollD20();
  return { die: d, mod, total: d + mod, statName: statName || "raw", crit: d === 20, fumble: d === 1 };
}

export function formatRoll(roll) {
  const sign = roll.mod >= 0 ? `+${roll.mod}` : `${roll.mod}`;
  let suffix = "";
  if (roll.crit) suffix = " — NAT 20!";
  else if (roll.fumble) suffix = " — natural 1.";
  return `d20: **${roll.die}** ${sign} ${roll.statName} = **${roll.total}**${suffix}`;
}

// Per-turn caps on state-change deltas. These prevent a hallucinating DM
// (or compromised JSON) from one-shotting players or cascade-promoting them
// from Grade 4 to Special Grade in one turn. Tuned to allow normal play —
// a brutal hit can wipe a character but not exceed their max pool.
const MAX_XP_PER_TURN = 250;        // covers "complete a Special Grade encounter"
const MAX_STATUS_TAGS_ADDED = 3;
const MAX_STATUS_TAGS_REMOVED = 5;
const MAX_ITEMS_ADDED = 5;

// Apply DM-issued mechanics to a player's character. Returns the new character.
// Mechanics shape comes from gemini.js parseDmResponse:
//   { hp: -10, cursedEnergy: -20, xp: 25, statusEffects: { add, remove }, items: { add, remove } }
// Every numeric delta is bounded so a misbehaving DM can't corrupt state.
export function applyMechanicsToCharacter(character, change) {
  const c = { ...(character || {}) };
  c.statusEffects = Array.isArray(c.statusEffects) ? [...c.statusEffects] : [];
  c.items = Array.isArray(c.items) ? [...c.items] : [];

  if (typeof change.hp === "number" && Number.isFinite(change.hp)) {
    // Cap |hp delta| at the character's maxHp so a single turn can't deal
    // more damage than the player's full pool (no "you take 99999 damage").
    const maxHp = c.maxHp || 100;
    const dh = Math.max(-maxHp, Math.min(maxHp, change.hp));
    const next = (c.hp ?? maxHp) + dh;
    c.hp = Math.max(0, Math.min(maxHp, next));
  }
  if (typeof change.cursedEnergy === "number" && Number.isFinite(change.cursedEnergy)) {
    const maxCe = c.maxCursedEnergy || 80;
    const dce = Math.max(-maxCe, Math.min(maxCe, change.cursedEnergy));
    const next = (c.cursedEnergy ?? maxCe) + dce;
    c.cursedEnergy = Math.max(0, Math.min(maxCe, next));
  }
  if (change.statusEffects) {
    if (Array.isArray(change.statusEffects.add)) {
      const adds = change.statusEffects.add.slice(0, MAX_STATUS_TAGS_ADDED);
      for (const s of adds) {
        if (typeof s === "string" && s.length <= 40 && !c.statusEffects.includes(s)) {
          c.statusEffects.push(s);
        }
      }
      // Cap total status effects per character — a 50-tag list is absurd.
      if (c.statusEffects.length > 12) c.statusEffects = c.statusEffects.slice(-12);
    }
    if (Array.isArray(change.statusEffects.remove)) {
      const removes = change.statusEffects.remove.slice(0, MAX_STATUS_TAGS_REMOVED);
      c.statusEffects = c.statusEffects.filter((s) => !removes.includes(s));
    }
  }
  if (change.items) {
    if (Array.isArray(change.items.add)) {
      const adds = change.items.add.slice(0, MAX_ITEMS_ADDED);
      for (const it of adds) {
        if (typeof it === "string" && it.length <= 80) c.items.push(it);
      }
      if (c.items.length > 30) c.items = c.items.slice(-30);
    }
    if (Array.isArray(change.items.remove)) {
      for (const r of change.items.remove.slice(0, 10)) {
        const idx = c.items.indexOf(r);
        if (idx >= 0) c.items.splice(idx, 1);
      }
    }
  }
  // XP delta + auto-promote on threshold. Cap |delta| at MAX_XP_PER_TURN
  // so the DM can't cascade-promote Grade 4 → Special Grade in one call.
  if (typeof change.xp === "number" && Number.isFinite(change.xp)) {
    const dxp = Math.max(-MAX_XP_PER_TURN, Math.min(MAX_XP_PER_TURN, change.xp));
    c.xp = Math.max(0, Math.round((c.xp || 0) + dxp));
    // Limit cascade depth so even runaway XP can't promote multiple grades.
    let promotions = 0;
    while (promotions < 1) {
      const need = XP_TO_NEXT[c.grade];
      if (!Number.isFinite(need)) break;
      if (c.xp < need) break;
      const promoted = promoteCharacter(c);
      if (promoted.grade === c.grade) break;
      const remainder = c.xp - need;
      Object.assign(c, promoted);
      c.xp = remainder;
      c._levelUp = (c._levelUp || []);
      c._levelUp.push(c.grade);
      promotions++;
    }
  }
  return c;
}

// Convenience: build a status-line string for chat log.
export function summarizeChange(change, characterName) {
  const bits = [];
  if (typeof change.hp === "number" && change.hp !== 0) {
    bits.push(`${change.hp > 0 ? "+" : ""}${change.hp} HP`);
  }
  if (typeof change.cursedEnergy === "number" && change.cursedEnergy !== 0) {
    bits.push(`${change.cursedEnergy > 0 ? "+" : ""}${change.cursedEnergy} CE`);
  }
  if (typeof change.xp === "number" && change.xp !== 0) {
    bits.push(`${change.xp > 0 ? "+" : ""}${change.xp} XP`);
  }
  if (change.statusEffects?.add?.length) bits.push(`+status: ${change.statusEffects.add.join(", ")}`);
  if (change.statusEffects?.remove?.length) bits.push(`-status: ${change.statusEffects.remove.join(", ")}`);
  if (change.items?.add?.length) bits.push(`+items: ${change.items.add.join(", ")}`);
  if (change.items?.remove?.length) bits.push(`-items: ${change.items.remove.join(", ")}`);
  if (!bits.length) return null;
  return `${characterName}: ${bits.join(" · ")}`;
}
