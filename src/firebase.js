// Firebase init + helpers. Uses the v10 modular SDK from Google's CDN so this
// works without a bundler.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  push,
  onValue,
  onDisconnect,
  serverTimestamp,
  off,
  child,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

import { firebaseConfig } from "./firebase.config.js";

let _app, _auth, _db;
let _user = null;
const authReadyResolvers = [];

export function initFirebase() {
  if (_app) return { app: _app, auth: _auth, db: _db };
  if (firebaseConfig.apiKey === "YOUR_FIREBASE_WEB_API_KEY") {
    throw new Error(
      "Firebase config not set. Edit src/firebase.config.js with your project's values. See README."
    );
  }
  _app = initializeApp(firebaseConfig);
  _auth = getAuth(_app);
  _db = getDatabase(_app);

  onAuthStateChanged(_auth, (user) => {
    if (user) {
      _user = user;
      while (authReadyResolvers.length) authReadyResolvers.shift()(user);
    }
  });

  signInAnonymously(_auth).catch((err) => {
    console.error("Anonymous sign-in failed:", err);
    throw err;
  });

  return { app: _app, auth: _auth, db: _db };
}

export function authReady() {
  if (_user) return Promise.resolve(_user);
  return new Promise((resolve) => authReadyResolvers.push(resolve));
}

export function currentUid() {
  return _user?.uid ?? null;
}

// ─────────────── Room helpers ───────────────
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip ambiguous I/O/0/1
export function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

export function roomRef(roomCode, sub = "") {
  return ref(_db, `rooms/${roomCode}${sub ? "/" + sub : ""}`);
}

export async function roomExists(roomCode) {
  const snap = await get(roomRef(roomCode));
  return snap.exists();
}

export async function createRoom(roomCode, hostUid, options = {}) {
  const initial = {
    host: hostUid,
    createdAt: serverTimestamp(),
    status: "lobby",
    lockedGrade: options.lockedGrade || null,
    players: {},
    turnOrder: [],
    currentTurn: null,
    messages: {},
    pendingActions: {},
  };
  await set(roomRef(roomCode), initial);
}

export async function addPlayer(roomCode, uid, character) {
  const playerData = {
    uid,
    name: character.name,
    character,
    online: true,
    lastSeen: serverTimestamp(),
  };
  await set(roomRef(roomCode, `players/${uid}`), playerData);

  await runTransaction(roomRef(roomCode, "turnOrder"), (current) => {
    const order = current || [];
    if (!order.includes(uid)) order.push(uid);
    return order;
  });

  await runTransaction(roomRef(roomCode, "currentTurn"), (current) => {
    return current || uid;
  });

  // We deliberately DO NOT set online=false on disconnect any more — closing
  // a tab no longer marks the player offline. Inactivity is tracked via
  // lastSeen instead. We still bump lastSeen on disconnect so other clients
  // see how stale the player is.
  onDisconnect(roomRef(roomCode, `players/${uid}/lastSeen`)).set(serverTimestamp());
}

// Just bump lastSeen — used as a heartbeat from the active tab.
export async function bumpLastSeen(roomCode, uid) {
  await update(roomRef(roomCode, `players/${uid}`), {
    lastSeen: serverTimestamp(),
  });
}

export async function setPlayerOnline(roomCode, uid, online) {
  // Kept for backwards compatibility, but UI no longer reads `online`.
  await update(roomRef(roomCode, `players/${uid}`), {
    online,
    lastSeen: serverTimestamp(),
  });
}

// Host action: remove a player from the room and from the turn order.
export async function kickPlayer(roomCode, uid) {
  // Refuse to kick the host — bricks the room.
  const hostSnap = await get(roomRef(roomCode, "host"));
  if (hostSnap.exists() && hostSnap.val() === uid) {
    throw new Error("Cannot kick the host.");
  }

  await set(roomRef(roomCode, `players/${uid}`), null);
  await runTransaction(roomRef(roomCode, "turnOrder"), (order) => {
    if (!Array.isArray(order)) return order;
    return order.filter((u) => u !== uid);
  });
  // If they were the current turn, advance.
  const curRef = roomRef(roomCode, "currentTurn");
  const snap = await get(curRef);
  if (snap.exists() && snap.val() === uid) {
    const orderSnap = await get(roomRef(roomCode, "turnOrder"));
    const order = orderSnap.val() || [];
    await set(curRef, order[0] || null);
  }
  // Clear any pending action and any in-flight vote they cast — otherwise the
  // tally counts kicked-uid votes and never reaches the threshold.
  await set(roomRef(roomCode, `pendingActions/${uid}`), null);
  await set(roomRef(roomCode, `votes/${uid}`), null);
}

export function listenRoom(roomCode, callback) {
  const r = roomRef(roomCode);
  const unsub = onValue(r, (snap) => callback(snap.val()));
  return () => off(r, "value", unsub);
}

export async function postMessage(roomCode, message) {
  const msgsRef = roomRef(roomCode, "messages");
  const newRef = push(msgsRef);
  await set(newRef, { ...message, timestamp: serverTimestamp() });
  return newRef.key;
}

export async function setCurrentTurn(roomCode, uid) {
  await set(roomRef(roomCode, "currentTurn"), uid);
}

export async function updatePlayerCharacter(roomCode, uid, characterPatch) {
  const updates = {};
  for (const [k, v] of Object.entries(characterPatch)) {
    updates[`character/${k}`] = v;
  }
  await update(roomRef(roomCode, `players/${uid}`), updates);
}

export async function setPendingAction(roomCode, uid, action) {
  if (action == null) {
    await set(roomRef(roomCode, `pendingActions/${uid}`), null);
  } else {
    await set(roomRef(roomCode, `pendingActions/${uid}`), action);
  }
}

export async function clearPendingActions(roomCode) {
  await set(roomRef(roomCode, "pendingActions"), null);
}

export async function setRoomStatus(roomCode, status) {
  await set(roomRef(roomCode, "status"), status);
}

export async function setObjective(roomCode, objective) {
  await set(roomRef(roomCode, "objective"), objective || null);
}

export async function setMap(roomCode, map) {
  await set(roomRef(roomCode, "map"), map || null);
}

export async function setActionPrompt(roomCode, prompt) {
  // prompt = { options: [{id, text}], optionMode: "individual"|"group", forUid?: string, openedAt: number }
  await set(roomRef(roomCode, "actionPrompt"), prompt || null);
}

export async function castVote(roomCode, uid, optionId) {
  // Tolerate the special "__resolved" sentinel used by the host to mark a
  // group vote as already settled; otherwise validate against the current
  // actionPrompt to reject stale or made-up option ids.
  if (optionId && uid !== "__resolved") {
    try {
      const promptSnap = await get(roomRef(roomCode, "actionPrompt"));
      const prompt = promptSnap.val();
      const valid = prompt && Array.isArray(prompt.options)
        && prompt.options.some((o) => o && o.id === optionId);
      if (!valid) throw new Error("Vote ignored: option not in current prompt.");
    } catch (e) {
      if (e?.message?.startsWith?.("Vote ignored")) throw e;
      // network error reading prompt → fall through, allow the write
    }
  }
  await set(roomRef(roomCode, `votes/${uid}`), optionId || null);
}

export async function clearVotes(roomCode) {
  await set(roomRef(roomCode, "votes"), null);
}

export { ref, set, get, update };
