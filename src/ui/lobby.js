import { $, show, toast } from "./common.js";
import {
  initFirebase,
  authReady,
  currentUid,
  generateRoomCode,
  roomExists,
  createRoom,
  isAnonymous,
  userDisplayName,
} from "../firebase.js";
import { hostHasDmProvider } from "../gemini.js";

export function initLobby({ onJoin, onMyBuilds, onSignOut }) {
  $("#btn-create").addEventListener("click", async () => {
    if (!hostHasDmProvider()) {
      toast("Hosts need a DM provider — pick Gemini key or Ollama.", "warn");
      window.__app.returnViewAfterKey = "view-lobby";
      show("view-key");
      return;
    }
    initFirebase();
    await authReady();
    const uid = currentUid();
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateRoomCode();
      if (!(await roomExists(code))) break;
    }
    if (!code) { toast("Couldn't generate a room code.", "error"); return; }
    const lockedGrade = ($("#lock-grade").value || "").trim() || null;
    const dmTone = ($("#dm-tone")?.value || "balanced").trim();
    try {
      await createRoom(code, uid, { lockedGrade, dmTone });
      toast(`Room ${code} created (${dmTone} DM${lockedGrade ? `, ${lockedGrade}` : ""}). You are the host.`, "ok");
      onJoin(code, /*isHost*/ true);
    } catch (err) {
      console.error(err);
      toast(`Create failed: ${err.message}`, "error");
    }
  });

  $("#btn-join").addEventListener("click", async () => {
    initFirebase();
    await authReady();
    const raw = $("#join-code").value.trim().toUpperCase();
    if (raw.length !== 6) { toast("Enter the 6-character room code.", "warn"); return; }
    if (!(await roomExists(raw))) { toast(`Room ${raw} not found.`, "error"); return; }
    onJoin(raw, /*isHost*/ false);
  });

  $("#join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-join").click();
  });

  $("#join-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  $("#btn-change-key").addEventListener("click", () => {
    window.__app.returnViewAfterKey = "view-lobby";
    show("view-key");
  });

  $("#btn-my-builds").addEventListener("click", () => {
    if (isAnonymous()) {
      toast("Sign up to save builds across sessions.", "warn");
      return;
    }
    onMyBuilds && onMyBuilds();
  });

  $("#btn-sign-out").addEventListener("click", () => {
    onSignOut && onSignOut();
  });
}

export function setLobbyUid(_uid) {
  // Refresh the visible account row.
  const nameEl = document.getElementById("lobby-display-name");
  const badge = document.getElementById("lobby-uid-badge");
  const myBuildsBtn = document.getElementById("btn-my-builds");
  const anonHint = document.getElementById("lobby-anon-hint");
  if (nameEl) nameEl.textContent = userDisplayName();
  if (badge) badge.textContent = isAnonymous() ? "(guest)" : "";
  if (myBuildsBtn) myBuildsBtn.disabled = isAnonymous();
  if (anonHint) anonHint.classList.toggle("hidden", !isAnonymous());
}
