// Entry point. Wires together views, auth, and routing.
import { $, show, toast } from "./ui/common.js";
import { initLobby, setLobbyUid } from "./ui/lobby.js";
import { initCharacter, setCharacterRoomCode } from "./ui/character.js";
import { initGame, joinRoom } from "./ui/game.js";
import { initFirebase, authReady, currentUid } from "./firebase.js";
import {
  loadStoredKey, saveKey, clearKey,
  loadStoredProvider, saveProvider,
  loadOllamaConfig, saveOllamaConfig,
} from "./gemini.js";

window.__app = {
  currentRoomCode: null,
  // Where to return after the key gate is dismissed (default: lobby).
  returnViewAfterKey: "view-lobby",
};

function bootKeyGate() {
  const keyInput = $("#key-input");
  const status = $("#key-status");
  const ollamaUrlInput = $("#ollama-url");
  const ollamaModelInput = $("#ollama-model");

  // Hydrate from storage
  const storedKey = loadStoredKey();
  if (storedKey) {
    keyInput.value = storedKey;
    status.textContent = "A Gemini key is already stored.";
  }
  const ollCfg = loadOllamaConfig();
  ollamaUrlInput.value = ollCfg.url;
  ollamaModelInput.value = ollCfg.model;

  // Pre-select the right tab
  const currentProvider = loadStoredProvider();
  document.querySelectorAll('input[name="provider"]').forEach((r) => {
    r.checked = r.value === currentProvider;
  });
  showProviderPanel(currentProvider);

  document.querySelectorAll('input[name="provider"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) showProviderPanel(r.value);
    });
  });

  $("#key-show").addEventListener("change", (e) => {
    keyInput.type = e.target.checked ? "text" : "password";
  });

  // Test the Ollama connection
  $("#ollama-test").addEventListener("click", async () => {
    const url = (ollamaUrlInput.value || "").trim().replace(/\/+$/, "");
    if (!url) { toast("Enter the Ollama URL.", "warn"); return; }
    status.textContent = `Testing ${url} ...`;
    try {
      const res = await fetch(url + "/api/tags", { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data?.models || []).map((m) => m.name).join(", ") || "(none pulled yet)";
      status.textContent = `Connected. Models on host: ${models}`;
      toast("Ollama reachable.", "ok");
    } catch (err) {
      status.textContent = `Test failed: ${err.message}`;
      toast(`Couldn't reach Ollama: ${err.message}`, "error");
    }
  });

  $("#key-save").addEventListener("click", async () => {
    const provider = (document.querySelector('input[name="provider"]:checked') || {}).value || "gemini";

    if (provider === "gemini") {
      const key = keyInput.value.trim();
      if (!key.startsWith("AIza") || key.length < 30) {
        toast("That doesn't look like a Gemini API key (should start with 'AIza').", "warn");
        return;
      }
      saveKey(key);
      saveProvider("gemini");
      status.textContent = "Saved (Gemini).";
    } else if (provider === "ollama") {
      const url = (ollamaUrlInput.value || "").trim().replace(/\/+$/, "");
      const model = (ollamaModelInput.value || "").trim();
      if (!url) { toast("Enter the Ollama URL.", "warn"); return; }
      if (!model) { toast("Enter the model name (e.g. qwen2.5:14b).", "warn"); return; }
      saveOllamaConfig({ url, model });
      saveProvider("ollama");
      status.textContent = `Saved (Ollama → ${model}).`;
    }

    try { initFirebase(); }
    catch (err) { toast(err.message, "error"); return; }
    await authReady();
    setLobbyUid(currentUid());
    show(window.__app.returnViewAfterKey || "view-lobby");
    window.__app.returnViewAfterKey = "view-lobby";
  });

  $("#key-back").addEventListener("click", () => {
    show("view-lobby");
    window.__app.returnViewAfterKey = "view-lobby";
  });

  $("#key-clear").addEventListener("click", () => {
    clearKey();
    keyInput.value = "";
    status.textContent = "Cleared stored Gemini key.";
    toast("API key forgotten.", "ok");
  });
}

function showProviderPanel(provider) {
  document.getElementById("provider-gemini").classList.toggle("hidden", provider !== "gemini");
  document.getElementById("provider-ollama").classList.toggle("hidden", provider !== "ollama");
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

  // Always boot to the lobby. The key gate is now on-demand for hosts only.
  try {
    initFirebase();
    await authReady();
    setLobbyUid(currentUid());
    show("view-lobby");
  } catch (err) {
    console.error(err);
    toast(`Firebase init failed: ${err.message}`, "error");
  }
});
