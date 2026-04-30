import { $, $$, show, toast, el } from "./common.js";
import { STARTER_TECHNIQUES, buildCharacter } from "../game/character.js";
import { addPlayer, currentUid } from "../firebase.js";

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

  $("#char-submit").addEventListener("click", async () => {
    const roomCode = window.__app.currentRoomCode;
    if (!roomCode) { toast("No active room.", "error"); return; }
    const character = buildCharacter({
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
    if (!character.name || character.name === "Unnamed sorcerer") {
      toast("Give your sorcerer a name.", "warn");
      return;
    }
    try {
      await addPlayer(roomCode, currentUid(), character);
      onJoined(roomCode);
    } catch (err) {
      console.error(err);
      toast(`Could not join room: ${err.message}`, "error");
    }
  });
}

export function setCharacterRoomCode(code) {
  const node = document.getElementById("char-room-code");
  if (node) node.textContent = code || "—";
}
