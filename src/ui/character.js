import { $, show, toast, el } from "./common.js";
import { STARTER_TECHNIQUES, buildCharacter } from "../game/character.js";
import { addPlayer, currentUid, listenRoom } from "../firebase.js";
import { generateAbilities, hostHasDmProvider } from "../gemini.js";
import { findProfanity } from "../util/profanity.js";

let unsubscribeLockedGradeWatch = null;

export function initCharacter({ onJoined }) {
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

  // Watch the room for a locked grade and force-enable/disable the dropdown.
  if (unsubscribeLockedGradeWatch) {
    try { unsubscribeLockedGradeWatch(); } catch {}
    unsubscribeLockedGradeWatch = null;
  }
  if (!code) {
    window.__app.lockedGrade = null;
    return;
  }
  unsubscribeLockedGradeWatch = listenRoom(code, (room) => {
    if (!room) return;
    const locked = room.lockedGrade || null;
    window.__app.lockedGrade = locked;
    const sel = document.getElementById("char-grade");
    if (!sel) return;
    if (locked) {
      sel.value = locked;
      sel.disabled = true;
      sel.title = `Host locked grade to ${locked}`;
    } else {
      sel.disabled = false;
      sel.title = "";
    }
  });
}
