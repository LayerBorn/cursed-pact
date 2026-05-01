import { $, show, toast, el, escapeHtml } from "./common.js";
import { STARTER_TECHNIQUES, buildCharacter } from "../game/character.js";
import { addPlayer, currentUid, listenRoom } from "../firebase.js";
import { cpIsSignedIn, cpListBuilds } from "../cpApi.js";
import { generateAbilities, hostHasDmProvider } from "../gemini.js";
import { findProfanity } from "../util/profanity.js";

let unsubscribeLockedGradeWatch = null;
let onJoinedRef = null;
let savedBuildsRoomGrade = null; // current room's locked grade, if any

const DRAFT_STORAGE_KEY = "jjk_char_draft_v1";
function saveDraft() {
  try {
    const draft = {
      name: $("#char-name")?.value || "",
      grade: $("#char-grade")?.value || "",
      technique: $("#char-technique")?.value || "",
      domain: $("#char-domain")?.value || "",
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch {}
}

export function initCharacter({ onJoined }) {
  onJoinedRef = onJoined;
  const picker = $("#technique-picker");
  picker.innerHTML = "";
  STARTER_TECHNIQUES.forEach((t) => {
    const btn = el("button", {
      type: "button",
      title: t.desc,
      onclick: () => {
        const value = `${t.name} — ${t.desc}`;
        $("#char-technique").value = value.slice(0, 400);
        updateCounter("char-technique", "char-technique-counter", 400);
      },
    }, t.name);
    picker.appendChild(btn);
  });
  picker.appendChild(el("button", {
    type: "button",
    title: "Pick a random starter technique",
    onclick: () => {
      const t = STARTER_TECHNIQUES[Math.floor(Math.random() * STARTER_TECHNIQUES.length)];
      const value = `${t.name} — ${t.desc}`;
      $("#char-technique").value = value.slice(0, 400);
      updateCounter("char-technique", "char-technique-counter", 400);
    },
  }, "🎲 Random"));

  // Live char counters
  bindCounter("char-technique", "char-technique-counter", 400);
  bindCounter("char-domain", "char-domain-counter", 300);

  // Hydrate draft if the user accidentally refreshed the page mid-build.
  const draft = loadDraft();
  if (draft) {
    if (draft.name) $("#char-name").value = draft.name;
    if (draft.grade) $("#char-grade").value = draft.grade;
    if (draft.technique) {
      $("#char-technique").value = draft.technique;
      const ev = new Event("input");
      $("#char-technique").dispatchEvent(ev);
    }
    if (draft.domain) {
      $("#char-domain").value = draft.domain;
      const ev = new Event("input");
      $("#char-domain").dispatchEvent(ev);
    }
  }
  // Save on every keystroke / change.
  for (const id of ["char-name", "char-grade", "char-technique", "char-domain"]) {
    const node = document.getElementById(id);
    if (node) node.addEventListener("input", saveDraft);
    if (node) node.addEventListener("change", saveDraft);
  }

  const submitBtn = $("#char-submit");

  submitBtn.addEventListener("click", async () => {
    const roomCode = window.__app.currentRoomCode;
    if (!roomCode) { toast("No active room.", "error"); return; }

    const name = ($("#char-name").value || "").trim();
    const technique = ($("#char-technique").value || "").trim();
    const domain = ($("#char-domain").value || "").trim();
    let grade = $("#char-grade").value;

    // Length guards (defense in depth — maxlength on the inputs already caps).
    if (name.length > 32) { toast("Name too long (max 32).", "warn"); return; }
    if (technique.length > 400) { toast("Technique too long (max 400).", "warn"); return; }
    if (domain.length > 300) { toast("Domain too long (max 300).", "warn"); return; }

    if (!name) { toast("Give your sorcerer a name.", "warn"); return; }

    // Profanity filter — block submission if the name, technique, or domain
    // contains profanity. Better message than just refusing silently.
    for (const [field, value] of [["name", name], ["technique", technique], ["domain", domain]]) {
      const word = findProfanity(value);
      if (word) {
        toast(`Profanity detected in ${field} — please rephrase.`, "error");
        return;
      }
    }

    // Enforce locked grade if host set one for this room.
    const lockedGrade = window.__app.lockedGrade;
    if (lockedGrade) grade = lockedGrade;

    const baseCharacter = buildCharacter({ name, grade, technique, domain });

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    const isHost = !!window.__app.isHost;
    let abilities = [];
    let aiStats = null;
    if (isHost && hostHasDmProvider()) {
      submitBtn.textContent = "Generating abilities & stats…";
      try {
        const result = await generateAbilities({
          technique: baseCharacter.technique,
          grade: baseCharacter.grade,
        });
        abilities = result.abilities || [];
        aiStats = result.stats || null;
      } catch (err) {
        console.warn("Ability generation failed:", err);
        toast(`Couldn't generate abilities (${err.message}). Joining anyway.`, "warn");
      }
    } else if (!isHost) {
      submitBtn.textContent = "Joining…";
    }

    const character = {
      ...baseCharacter,
      abilities,
      ...(aiStats ? { stats: aiStats } : {}),
    };

    try {
      await addPlayer(roomCode, currentUid(), character);
      if (abilities.length) {
        toast(`Abilities: ${abilities.map((a) => a.name).join(", ")}`, "ok");
      } else if (!isHost) {
        toast("Joined. The host will generate your abilities + stats.", "ok");
      }
      clearDraft();
      onJoined(roomCode);
    } catch (err) {
      console.error(err);
      toast(`Could not join room: ${err.message}`, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

function bindCounter(inputId, counterId, max) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener("input", () => updateCounter(inputId, counterId, max));
  updateCounter(inputId, counterId, max);
}

function updateCounter(inputId, counterId, max) {
  const input = document.getElementById(inputId);
  const counter = document.getElementById(counterId);
  if (!input || !counter) return;
  const len = (input.value || "").length;
  counter.textContent = `${len} / ${max}`;
  counter.classList.toggle("near-limit", len > max * 0.85);
}

export function setCharacterRoomCode(code) {
  const node = document.getElementById("char-room-code");
  if (node) node.textContent = code || "—";

  if (unsubscribeLockedGradeWatch) {
    try { unsubscribeLockedGradeWatch(); } catch {}
    unsubscribeLockedGradeWatch = null;
  }
  if (!code) {
    window.__app.lockedGrade = null;
    return;
  }
  unsubscribeLockedGradeWatch = listenRoom(code, async (room) => {
    if (!room) return;
    const locked = room.lockedGrade || null;
    window.__app.lockedGrade = locked;
    savedBuildsRoomGrade = locked;
    const sel = document.getElementById("char-grade");
    if (sel) {
      if (locked) {
        sel.value = locked;
        sel.disabled = true;
        sel.title = `Host locked grade to ${locked}`;
      } else {
        sel.disabled = false;
        sel.title = "";
      }
    }
    // Refresh the saved-builds list whenever the locked grade changes.
    await renderSavedBuilds();
  });
}

async function renderSavedBuilds() {
  const panel = document.getElementById("saved-build-panel");
  const list = document.getElementById("saved-build-list");
  const empty = document.getElementById("saved-build-empty");
  if (!panel || !list || !empty) return;

  // Guests (not signed in to a CP account) have no builds.
  if (!cpIsSignedIn()) {
    panel.classList.add("hidden");
    return;
  }

  let builds = [];
  try { builds = await cpListBuilds(); } catch { builds = []; }
  const lockedGrade = savedBuildsRoomGrade;
  const matching = lockedGrade
    ? builds.filter((b) => b.grade === lockedGrade)
    : builds;

  if (!builds.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  list.innerHTML = "";
  if (!matching.length) {
    empty.classList.remove("hidden");
    empty.textContent = lockedGrade
      ? `No saved builds match the locked grade (${lockedGrade}).`
      : "No saved builds.";
    return;
  }
  empty.classList.add("hidden");
  for (const b of matching) {
    const card = el("button", {
      type: "button",
      class: "saved-build-card",
      onclick: () => useSavedBuild(b),
    }, [
      el("div", { class: "saved-build-title" }, [
        el("span", { class: "saved-build-name" }, escapeHtml(b.name || "?")),
        el("span", { class: "saved-build-grade" }, escapeHtml(b.grade || "Grade 3")),
      ]),
      el("div", { class: "saved-build-tech muted small" }, escapeHtml(truncate(b.technique || "(no technique)", 90))),
    ]);
    list.appendChild(card);
  }
}

async function useSavedBuild(build) {
  const roomCode = window.__app.currentRoomCode;
  if (!roomCode) { toast("No active room.", "error"); return; }

  // Decide the actual joining grade. A locked room overrides the build's grade.
  const lockedGrade = window.__app.lockedGrade;
  const buildGrade = build.grade || "Grade 3";
  const joiningGrade = lockedGrade || buildGrade;
  const gradeMismatch = lockedGrade && lockedGrade !== buildGrade;

  // Pull the matching HP/CE pool for the joining grade so the player isn't
  // sitting at "Grade 1 maxHp" while playing as a Grade 4.
  const baseGradePool = STARTER_GRADE_HP_FOR(joiningGrade);

  const character = {
    name: build.name,
    grade: joiningGrade,
    technique: build.technique || "",
    domain: build.domain || "",
    backstory: build.backstory || "",
    personality: build.personality || "",
    stats: build.stats || { phys: 12, tech: 12, spirit: 12 },
    abilities: Array.isArray(build.abilities) ? build.abilities : [],
    hp: baseGradePool.hp,
    maxHp: baseGradePool.hp,
    cursedEnergy: baseGradePool.ce,
    maxCursedEnergy: baseGradePool.ce,
    statusEffects: [],
    items: [],
    xp: build.xp || 0,
  };

  // If the room forced a different grade, flag the character for the host
  // to auto-rebalance. The host's listener picks this up and regenerates
  // abilities + stats at the joining grade.
  if (gradeMismatch) {
    character._rebalanceFrom = buildGrade;
    character._needsRebalance = true;
  }

  try {
    await addPlayer(roomCode, currentUid(), character);
    toast(
      gradeMismatch
        ? `Joined as ${character.name}. Host will auto-rebalance from ${buildGrade} to ${joiningGrade}.`
        : `Joined as ${character.name}.`,
      "ok"
    );
    onJoinedRef && onJoinedRef(roomCode);
  } catch (err) {
    console.error(err);
    toast(`Could not join with build: ${err.message}`, "error");
  }
}

// Per-grade HP/CE starter pools — duplicated from game/character.js so we
// don't expose internal constants. Keep these in sync.
function STARTER_GRADE_HP_FOR(grade) {
  const table = {
    "Grade 4":      { hp: 70,  ce: 60 },
    "Grade 3":      { hp: 90,  ce: 80 },
    "Grade 2":      { hp: 110, ce: 110 },
    "Grade 1":      { hp: 140, ce: 150 },
    "Semi-Grade 1": { hp: 130, ce: 140 },
    "Special Grade":{ hp: 180, ce: 220 },
  };
  return table[grade] || table["Grade 3"];
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
