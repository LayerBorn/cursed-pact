// Entry point. Wires together views, auth, and routing.
import { $, show, toast } from "./ui/common.js";
import { initLobby, setLobbyUid } from "./ui/lobby.js";
import { initCharacter, setCharacterRoomCode } from "./ui/character.js";
import { initGame, joinRoom } from "./ui/game.js";
import { initFirebase, authReady, currentUid } from "./firebase.js";
import { loadStoredKey, saveKey, clearKey } from "./gemini.js";

window.__app = {
  currentRoomCode: null,
};

function bootKeyGate() {
  const input = $("#key-input");
  const status = $("#key-status");
  const stored = loadStoredKey();
  if (stored) {
    input.value = stored;
    status.textContent = "A key is already stored locally. You can re-paste to change it.";
  }

  $("#key-show").addEventListener("change", (e) => {
    input.type = e.target.checked ? "text" : "password";
  });

  $("#key-save").addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key.startsWith("AIza") || key.length < 30) {
      toast("That doesn't look like a Gemini API key (should start with 'AIza').", "warn");
      return;
    }
    saveKey(key);
    status.textContent = "Saved locally.";
    try {
      initFirebase();
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    await authReady();
    setLobbyUid(currentUid());
    show("view-lobby");
  });
}

function bootLobby() {
  initLobby({
    onJoin: (code, isHost) => {
      window.__app.currentRoomCode = code;
      window.__app.isHost = isHost;
      setCharacterRoomCode(code);
      show("view-character");
    },
  });
}

function bootCharacter() {
  initCharacter({
    onJoined: (code) => {
      show("view-game");
      joinRoom({ code, host: !!window.__app.isHost });
    },
  });
}

function bootGame() {
  initGame({
    onLeave: () => {
      window.__app.currentRoomCode = null;
      window.__app.isHost = false;
      show("view-lobby");
    },
  });
}

// Boot
window.addEventListener("DOMContentLoaded", async () => {
  bootKeyGate();
  bootLobby();
  bootCharacter();
  bootGame();

  if (loadStoredKey()) {
    try {
      initFirebase();
      await authReady();
      setLobbyUid(currentUid());
      show("view-lobby");
    } catch (err) {
      console.error(err);
      toast(`Firebase init failed: ${err.message}`, "error");
      show("view-key");
    }
  } else {
    show("view-key");
  }
});
