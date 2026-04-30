// Lightweight client-side profanity filter. Normalizes common leet-speak
// substitutions ("b!tch", "sh1t", "@ss") before comparing against a curated
// word list. Imperfect — bypassable by spacing letters apart or unusual
// substitutions — but catches the common cases.

const LEET_MAP = {
  "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a",
  "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "9": "g",
};

// Severe slurs and common profanity. Grouped intentionally — keep this list
// short and severe rather than catching every mild swear.
const PROFANE_WORDS = [
  // F-word family
  "fuck", "fck", "fuk", "fuq",
  // S-word family
  "shit", "shyt", "sh1t",
  // Misc common
  "bitch", "bich", "biatch", "asshole", "dick", "pussy", "cock", "cunt",
  "whore", "slut", "bastard",
  // Slurs (severe)
  "nigger", "nigga", "faggot", "fag", "tranny", "retard", "kike",
  "chink", "spic", "gook", "wetback", "raghead",
  // Sexual content
  "rape", "pedo", "pedophile",
];

function normalizeChar(c) { return LEET_MAP[c] || c; }

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .split("")
    .map(normalizeChar)
    .join("")
    .replace(/[^a-z]/g, "");
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9!@$+]+/i)
    .filter(Boolean)
    .map((w) => w.split("").map(normalizeChar).join("").replace(/[^a-z]/g, ""))
    .filter(Boolean);
}

// Returns the matched profane word, or null. Uses two checks:
// 1. Exact word match (less false positives)
// 2. Concatenated substring match (catches "fuckyou", "shitbag", etc.)
export function findProfanity(text) {
  if (!text) return null;
  const words = normalizeWords(text);
  for (const w of words) {
    for (const p of PROFANE_WORDS) {
      if (w === p) return p;
      if (w.length >= p.length + 2 && w.includes(p)) return p;
    }
  }
  // Fallback: single-token substring check (catches "f-u-c-k" → "fuck" after
  // stripping non-letters).
  const collapsed = normalize(text);
  for (const p of PROFANE_WORDS) {
    if (collapsed.length >= p.length && collapsed.includes(p)) return p;
  }
  return null;
}

export function containsProfanity(text) {
  return findProfanity(text) !== null;
}
