import { $, show, toast } from "./common.js";
import {
  initFirebase,
  authReady,
  currentUid,
  generateRoomCode,
  roomExists,
  createRoom,
} from "../firebase.js";
import { cpIsSignedIn, cpUser } from "../cpApi.js";
import { avatarLetters, avatarColorFor } from "./account.js";
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
    if (!cpIsSignedIn()) {
      toast("Sign up to save builds across sessions.", "warn");
      return;
    }
    onMyBuilds && onMyBuilds();
  });

  $("#btn-sign-out").addEventListener("click", () => {
    onSignOut && onSignOut();
  });

  $("#btn-account-open").addEventListener("click", () => {
    if (window.__app?.openAccount) window.__app.openAccount();
  });
}

export function setLobbyUid(_uid) {
  const nameEl = document.getElementById("lobby-display-name");
  const badge = document.getElementById("lobby-uid-badge");
  const myBuildsBtn = document.getElementById("btn-my-builds");
  const anonHint = document.getElementById("lobby-anon-hint");
  const accountBtn = document.getElementById("btn-account-open");
  const avatar = document.getElementById("lobby-avatar");
  const guest = !cpIsSignedIn();
  const u = cpUser();
  const display = u?.displayName || u?.email?.split("@")[0] || "Guest";
  if (nameEl) nameEl.textContent = display;
  if (badge) badge.textContent = guest ? "(guest)" : (u?.verified ? "" : "(unverified)");
  if (myBuildsBtn) myBuildsBtn.disabled = guest;
  if (anonHint) anonHint.classList.toggle("hidden", !guest);
  if (accountBtn) accountBtn.disabled = guest;
  if (avatar) {
    if (guest) {
      avatar.textContent = "?";
      avatar.style.background = "var(--surface3)";
    } else {
      avatar.textContent = avatarLetters(u);
      avatar.style.background = avatarColorFor(u);
    }
  }
}
