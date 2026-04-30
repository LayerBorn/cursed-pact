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
