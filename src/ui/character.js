import { $, $$, show, toast, el } from "./common.js";
import { STARTER_TECHNIQUES, buildCharacter } from "../game/character.js";
import { addPlayer, currentUid } from "../firebase.js";
import { generateAbilities, loadStoredKey } from "../gemini.js";

export function initCharacter({ onJoined }) {
  const picker = $("#technique-picker");
  picker.innerHTML = "";
  STARTER_TECHNIQUES.forEach((t) => {
    const btn = el("button", {
      type: "button",
      title: t.desc,
      onclick: () => {
        $("#char-technique").value = `${t.name} — ${t.desc}`;
      },
    }, t.name);
    picker.appendChild(btn);
  });

  // Random pick button
  picker.appendChild(el("button", {
    type: "button",
    title: "Pick a random starter technique",
    onclick: () => {
      const t = STARTER_TECHNIQUES[Math.floor(Math.random() * STARTER_TECHNIQUES.length)];
      $("#char-technique").value = `${t.name} — ${t.desc}`;
    },
  }, "🎲 Random"));

  const submitBtn = $("#char-submit");

  submitBtn.addEventListener("click", async () => {
    const roomCode = window.__app.currentRoomCode;
    if (!roomCode) { toast("No active room.", "error"); return; }
    const baseCharacter = buildCharacter({
      name: $("#char-name").value,
      grade: $("#char-grade").value,
      technique: $("#char-technique").value,
      domain: $("#char-domain").value,
      stats: {
        phys: $("#stat-phys").value,
        tech: $("#stat-tech").value,
        spirit: $("#stat-spirit").value,
      },
    });
    if (!baseCharacter.name || baseCharacter.name === "Unnamed sorcerer") {
      toast("Give your sorcerer a name.", "warn");
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;

    // Only the HOST ever calls Gemini — for the DM and for ability generation.
    // Joiners save their character with empty abilities and the host backfills
    // them later (see generateMissingAbilities in game/room.js).
    const isHost = !!window.__app.isHost;
    let abilities = [];
    if (isHost) {
      const apiKey = loadStoredKey();
      if (apiKey) {
        submitBtn.textContent = "Generating abilities…";
        try {
          abilities = await generateAbilities({
            apiKey,
            technique: baseCharacter.technique,
            grade: baseCharacter.grade,
          });
        } catch (err) {
          console.warn("Ability generation failed:", err);
          toast(`Couldn't generate abilities (${err.message}). Joining anyway.`, "warn");
        }
      }
    } else {
      submitBtn.textContent = "Joining…";
    }

    const character = { ...baseCharacter, abilities };

    try {
      await addPlayer(roomCode, currentUid(), character);
      if (abilities.length) {
        toast(`Abilities: ${abilities.map((a) => a.name).join(", ")}`, "ok");
      } else if (!isHost) {
        toast("Joined. Abilities will appear once the host generates them.", "ok");
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

export function setCharacterRoomCode(code) {
  const node = document.getElementById("char-room-code");
  if (node) node.textContent = code || "—";
}
