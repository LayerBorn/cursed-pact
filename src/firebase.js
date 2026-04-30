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

export async function createRoom(roomCode, hostUid) {
  const initial = {
    host: hostUid,
    createdAt: serverTimestamp(),
    status: "lobby", // lobby | playing
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

  // Append to turnOrder if not already there.
  await runTransaction(roomRef(roomCode, "turnOrder"), (current) => {
    const order = current || [];
    if (!order.includes(uid)) order.push(uid);
    return order;
  });

  // If no current turn yet, set this player.
  await runTransaction(roomRef(roomCode, "currentTurn"), (current) => {
    return current || uid;
  });

  // Mark them offline if they disconnect.
  onDisconnect(roomRef(roomCode, `players/${uid}/online`)).set(false);
  onDisconnect(roomRef(roomCode, `players/${uid}/lastSeen`)).set(serverTimestamp());
}

export async function setPlayerOnline(roomCode, uid, online) {
  await update(roomRef(roomCode, `players/${uid}`), {
    online,
    lastSeen: serverTimestamp(),
  });
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

export { ref, set, get, update };
