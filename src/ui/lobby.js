import { $, show, toast } from "./common.js";
import {
  initFirebase,
  authReady,
  currentUid,
  generateRoomCode,
  roomExists,
  createRoom,
} from "../firebase.js";

export function initLobby({ onJoin }) {
  $("#btn-create").addEventListener("click", async () => {
    initFirebase();
    await authReady();
    const uid = currentUid();
    let code;
    for (let attempt = 0; attempt < 10; attempt++) {
      code = generateRoomCode();
      if (!(await roomExists(code))) break;
    }
    if (!code) { toast("Couldn't generate a room code.", "error"); return; }
    try {
      await createRoom(code, uid);
      toast(`Room ${code} created. You are the host.`, "ok");
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
    show("view-key");
  });
}

export function setLobbyUid(uid) {
  const node = document.getElementById("lobby-uid");
  if (node) node.textContent = uid ? uid.slice(0, 8) : "—";
}
