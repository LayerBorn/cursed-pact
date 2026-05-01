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

// Apply DM-issued mechanics to a player's character. Returns the new character.
// Mechanics shape comes from gemini.js parseDmResponse:
//   { hp: -10, cursedEnergy: -20, statusEffects: { add: [...], remove: [...] }, items: { add, remove }, note }
export function applyMechanicsToCharacter(character, change) {
  const c = { ...(character || {}) };
  c.statusEffects = Array.isArray(c.statusEffects) ? [...c.statusEffects] : [];
  c.items = Array.isArray(c.items) ? [...c.items] : [];

  if (typeof change.hp === "number") {
    const next = (c.hp ?? c.maxHp ?? 0) + change.hp;
    c.hp = Math.max(0, Math.min(c.maxHp ?? next, next));
  }
  if (typeof change.cursedEnergy === "number") {
    const next = (c.cursedEnergy ?? c.maxCursedEnergy ?? 0) + change.cursedEnergy;
    c.cursedEnergy = Math.max(0, Math.min(c.maxCursedEnergy ?? next, next));
  }
  if (change.statusEffects) {
    if (Array.isArray(change.statusEffects.add)) {
      for (const s of change.statusEffects.add) {
        if (s && !c.statusEffects.includes(s)) c.statusEffects.push(s);
      }
    }
    if (Array.isArray(change.statusEffects.remove)) {
      c.statusEffects = c.statusEffects.filter((s) => !change.statusEffects.remove.includes(s));
    }
  }
  if (change.items) {
    if (Array.isArray(change.items.add)) {
      for (const it of change.items.add) {
        if (it) c.items.push(it);
      }
    }
    if (Array.isArray(change.items.remove)) {
      for (const r of change.items.remove) {
        const idx = c.items.indexOf(r);
        if (idx >= 0) c.items.splice(idx, 1);
      }
    }
  }
  // XP delta + auto-promote on threshold.
  if (typeof change.xp === "number" && Number.isFinite(change.xp)) {
    c.xp = Math.max(0, Math.round((c.xp || 0) + change.xp));
    // Cascade promote in case the player crossed multiple thresholds at once.
    while (true) {
      const need = XP_TO_NEXT[c.grade];
      if (!Number.isFinite(need)) break;
      if (c.xp < need) break;
      const promoted = promoteCharacter(c);
      if (promoted.grade === c.grade) break; // already maxed
      // Carry remainder XP into the new grade level.
      const remainder = c.xp - need;
      Object.assign(c, promoted);
      c.xp = remainder;
      c._levelUp = (c._levelUp || []);
      c._levelUp.push(c.grade);
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
