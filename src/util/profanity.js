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

// Allow-list of common false positives — words that contain a profane
// substring but should not trigger. Keep narrow.
const SAFE_SUBSTRINGS = [
  "grape", "drape", "rapeseed", "scrape", "trapeze",
  "shitake", "shiitake",
  "peacock", "shuttlecock", "stopcock",
  "dickinson", "moby", // "dick" in proper nouns
  "assassin", "class", "classic", "compass", "embarrass", "harass", "passport",
  "hellfire", "shellfish",
  "analyst", "analytic", "analog", "anaconda",
  "ferret", "scunthorpe",
];

function tokenIsSafe(token) {
  // token is already lowercased + leet-normalized.
  for (const safe of SAFE_SUBSTRINGS) {
    if (token === safe || token.startsWith(safe) || token.endsWith(safe)) return true;
  }
  return false;
}

// Returns the matched profane word, or null. Per-token check so a safe word
// in the same sentence doesn't bypass profanity elsewhere ("asshat embarrass"
// still flags asshat).
//
// For each token:
//   - exact match → flag
//   - if the token is in the SAFE list, allow it (no compound check)
//   - otherwise, allow compound match only if profane word is a clean start
//     or end with ≥2 extra letters on the other side.
export function findProfanity(text) {
  if (!text) return null;
  const words = normalizeWords(text);
  for (const w of words) {
    for (const p of PROFANE_WORDS) {
      if (w === p) return p;
    }
    if (tokenIsSafe(w)) continue;
    for (const p of PROFANE_WORDS) {
      if (w.length < p.length + 2) continue;
      if (w.startsWith(p) && /[a-z]{2,}$/.test(w.slice(p.length))) return p;
      if (w.endsWith(p) && /^[a-z]{2,}/.test(w.slice(0, w.length - p.length))) return p;
    }
  }
  return null;
}

export function containsProfanity(text) {
  return findProfanity(text) !== null;
}
