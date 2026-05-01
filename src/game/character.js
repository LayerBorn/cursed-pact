// Character creation defaults + curated technique list.

export const STARTER_TECHNIQUES = [
  { name: "Ten Shadows", desc: "Summon shikigami from your shadow. Tame defeated foes." },
  { name: "Limitless / Infinity", desc: "Manipulate space at the atomic level. Untouchable barrier between you and incoming attacks." },
  { name: "Disaster Flames", desc: "Generate volcanic flames. Heat warps the air." },
  { name: "Boogie Woogie", desc: "Swap the position of two anything (incl. yourself) on a clap." },
  { name: "Construction", desc: "Materialize objects from cursed energy at a CE cost proportional to mass." },
  { name: "Cursed Speech", desc: "Words become commands. Throat damage scales with refusal." },
  { name: "Idle Transfiguration", desc: "Reshape the souls of others — bodies follow." },
  { name: "Straw Doll Technique", desc: "Channel curses through nails and straw effigies into a target's body." },
  { name: "Projection Sorcery", desc: "Move at filmic 24fps. Touch a frozen subject to freeze them too." },
  { name: "Ratio Technique", desc: "Identify a 7:3 weak point. A clean strike there cuts deeper than it should." },
  { name: "Blood Manipulation", desc: "Control the volume, density, and trajectory of your own blood." },
  { name: "Cursed Spirit Manipulation", desc: "Capture defeated cursed spirits and deploy them yourself." },
  { name: "Heavenly Restriction", desc: "No CE. In exchange, unreasonable physical body." },
  { name: "Barrier-type", desc: "Specialize in casting and breaking barriers. Read others' domains." },
  { name: "Manipulation-type (custom)", desc: "Bend some specific phenomenon to your will. Describe it." },
  { name: "Shikigami-type (custom)", desc: "Bind cursed spirits to serve you. Describe what kind." },
];

const STARTER_GRADE_HP = {
  "Grade 4": { hp: 70, ce: 60 },
  "Grade 3": { hp: 90, ce: 80 },
  "Grade 2": { hp: 110, ce: 110 },
  "Grade 1": { hp: 140, ce: 150 },
  "Semi-Grade 1": { hp: 130, ce: 140 },
  "Special Grade": { hp: 180, ce: 220 },
};

// Order of grades from weakest to strongest. Used for leveling.
export const GRADE_ORDER = [
  "Grade 4",
  "Grade 3",
  "Grade 2",
  "Semi-Grade 1",
  "Grade 1",
  "Special Grade",
];

// XP required to advance FROM that grade to the next. The last grade caps.
export const XP_TO_NEXT = {
  "Grade 4":      120,
  "Grade 3":      280,
  "Grade 2":      520,
  "Semi-Grade 1": 850,
  "Grade 1":      1300,
  "Special Grade": Infinity,
};

// Returns the grade above the current one, or null if maxed.
export function nextGrade(currentGrade) {
  const i = GRADE_ORDER.indexOf(currentGrade);
  if (i < 0 || i === GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[i + 1];
}

// Promote a character to the next grade in-place, awarding the bigger HP/CE
// pool of the new grade. Existing HP/CE are scaled to preserve %, and the
// player gets a small "freshly-promoted" buff to refill above 80%.
export function promoteCharacter(character) {
  const next = nextGrade(character.grade);
  if (!next) return character;
  const before = STARTER_GRADE_HP[character.grade] || STARTER_GRADE_HP["Grade 3"];
  const after  = STARTER_GRADE_HP[next] || before;
  const hpPct  = (character.hp ?? before.hp) / (character.maxHp ?? before.hp);
  const cePct  = (character.cursedEnergy ?? before.ce) / (character.maxCursedEnergy ?? before.ce);
  const newMaxHp = after.hp;
  const newMaxCe = after.ce;
  // Refill to at least 80% on promotion.
  const restoredHp = Math.max(Math.round(newMaxHp * 0.8), Math.round(newMaxHp * hpPct));
  const restoredCe = Math.max(Math.round(newMaxCe * 0.8), Math.round(newMaxCe * cePct));
  return {
    ...character,
    grade: next,
    maxHp: newMaxHp,
    hp: Math.min(newMaxHp, restoredHp),
    maxCursedEnergy: newMaxCe,
    cursedEnergy: Math.min(newMaxCe, restoredCe),
  };
}

export function defaultCharacter(name) {
  return {
    name: name || "Unnamed sorcerer",
    grade: "Grade 3",
    technique: "",
    domain: "",
    stats: { phys: 12, tech: 12, spirit: 12 },
    hp: 90,
    maxHp: 90,
    cursedEnergy: 80,
    maxCursedEnergy: 80,
    statusEffects: [],
    items: [],
    abilities: [],
    xp: 0,
  };
}

export function buildCharacter({ name, grade, technique, domain, stats, abilities }) {
  const base = STARTER_GRADE_HP[grade] || STARTER_GRADE_HP["Grade 3"];
  return {
    name: (name || "").trim() || "Unnamed sorcerer",
    grade: grade || "Grade 3",
    technique: (technique || "").trim() || "(undeclared technique)",
    domain: (domain || "").trim(),
    stats: {
      phys: clampStat(stats?.phys),
      tech: clampStat(stats?.tech),
      spirit: clampStat(stats?.spirit),
    },
    hp: base.hp,
    maxHp: base.hp,
    cursedEnergy: base.ce,
    maxCursedEnergy: base.ce,
    statusEffects: [],
    items: [],
    abilities: Array.isArray(abilities) ? abilities : [],
    xp: 0,
  };
}

function clampStat(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 12;
  return Math.max(1, Math.min(20, Math.round(v)));
}

// Rolls modifier from a 1-20 stat (D&D-style: (stat-10)/2 floored).
export function statModifier(stat) {
  return Math.floor((Number(stat || 10) - 10) / 2);
}
