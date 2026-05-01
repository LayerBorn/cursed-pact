// Firebase init + helpers. Uses the v10 modular SDK from Google's CDN so this
// works without a bundler.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile as fbUpdateProfile,
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
const authStateListeners = [];

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
    _user = user || null;
    for (const cb of authStateListeners) {
      try { cb(_user); } catch (e) { console.warn(e); }
    }
  });

  return { app: _app, auth: _auth, db: _db };
}

// Subscribe to auth state changes. Returns an unsubscribe function.
export function onAuthChange(cb) {
  authStateListeners.push(cb);
  // Fire immediately with current state.
  if (_auth) cb(_user);
  return () => {
    const i = authStateListeners.indexOf(cb);
    if (i >= 0) authStateListeners.splice(i, 1);
  };
}

// Wait until we have ANY signed-in user (anonymous or registered).
export function authReady() {
  if (_user) return Promise.resolve(_user);
  return new Promise((resolve) => {
    const stop = onAuthChange((u) => {
      if (u) { stop(); resolve(u); }
    });
  });
}

// Sign in anonymously — used by the "Continue as guest" button.
export async function signInAsGuest() {
  if (!_auth) initFirebase();
  const cred = await signInAnonymously(_auth);
  return cred.user;
}

// Sign up a new account.
export async function signUp({ email, password, displayName }) {
  if (!_auth) initFirebase();
  const cred = await createUserWithEmailAndPassword(_auth, email, password);
  if (displayName) {
    try { await fbUpdateProfile(cred.user, { displayName }); } catch {}
  }
  // Seed a small profile record. Builds live under /users/{uid}/builds.
  try {
    await set(ref(_db, `users/${cred.user.uid}/profile`), {
      displayName: displayName || email.split("@")[0],
      email,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn("Could not seed profile:", e);
  }
  return cred.user;
}

// Sign in to an existing account.
export async function signIn({ email, password }) {
  if (!_auth) initFirebase();
  const cred = await signInWithEmailAndPassword(_auth, email, password);
  return cred.user;
}

export async function signOut() {
  if (!_auth) return;
  await fbSignOut(_auth);
  _user = null;
}

export function isAnonymous() {
  return Boolean(_user?.isAnonymous);
}

export function userDisplayName() {
  return _user?.displayName || (isAnonymous() ? "Guest" : (_user?.email?.split("@")[0] || "Sorcerer"));
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
    dmTone: options.dmTone || "balanced",
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
  // Debug log so turn transitions are inspectable in the console. The caller
  // should pass a string-ish uid (or null between scenes).
  try {
    console.log(`[turn] → ${uid ?? "(none)"}  (room ${roomCode})`);
  } catch {}
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

// Save a snapshot of the room's mutable state so the host can revert the last
// DM run if the response was bad. Stored at /rooms/$id/_lastSnapshot.
export async function setLastSnapshot(roomCode, snapshot) {
  await set(roomRef(roomCode, "_lastSnapshot"), snapshot || null);
}

// Restore players, objective, map, actionPrompt, votes from a saved snapshot,
// and delete any messages added after the snapshot was taken.
export async function restoreFromSnapshot(roomCode, snapshot) {
  if (!snapshot) return;
  const updates = {};
  if (snapshot.players) {
    // Rewrite each player's full record so we don't merge with stale changes.
    for (const [uid, playerRecord] of Object.entries(snapshot.players)) {
      updates[`players/${uid}`] = playerRecord;
    }
  }
  updates.objective    = snapshot.objective ?? null;
  updates.map          = snapshot.map ?? null;
  updates.actionPrompt = snapshot.actionPrompt ?? null;
  updates.votes        = snapshot.votes ?? null;
  updates.currentTurn  = snapshot.currentTurn ?? null;
  await update(roomRef(roomCode), updates);

  // Delete any messages added after the snapshot was captured.
  const before = new Set(snapshot.messageIdsBefore || []);
  const allSnap = await get(roomRef(roomCode, "messages"));
  const all = allSnap.val() || {};
  const toDelete = {};
  for (const id of Object.keys(all)) {
    if (!before.has(id)) toDelete[`messages/${id}`] = null;
  }
  if (Object.keys(toDelete).length) {
    await update(roomRef(roomCode), toDelete);
  }
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

// ─────────────── Saved character builds ───────────────
// Stored at /users/{uid}/builds/{buildId}. Builds are reusable templates
// (name + grade + technique + abilities + stats + domain). Pick one when
// joining a room instead of building from scratch.

function userBuildsRef(uid, sub = "") {
  return ref(_db, `users/${uid}/builds${sub ? "/" + sub : ""}`);
}

function newBuildId() {
  // Short, URL-safe id; collisions extremely unlikely per user.
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export async function saveBuild(uid, build, buildId = null) {
  if (!uid) throw new Error("Not signed in.");
  const id = buildId || newBuildId();
  const record = {
    ...build,
    updatedAt: serverTimestamp(),
    ...(buildId ? {} : { createdAt: serverTimestamp() }),
  };
  await set(userBuildsRef(uid, id), record);
  return id;
}

export async function listBuilds(uid) {
  if (!uid) return [];
  const snap = await get(userBuildsRef(uid));
  const all = snap.val() || {};
  return Object.entries(all).map(([id, b]) => ({ id, ...b }));
}

export async function getBuild(uid, buildId) {
  const snap = await get(userBuildsRef(uid, buildId));
  return snap.exists() ? { id: buildId, ...snap.val() } : null;
}

export async function deleteBuild(uid, buildId) {
  await set(userBuildsRef(uid, buildId), null);
}

// Listen for changes to the user's builds list (used by the My Builds view).
export function listenBuilds(uid, cb) {
  const r = userBuildsRef(uid);
  const unsub = onValue(r, (snap) => {
    const all = snap.val() || {};
    cb(Object.entries(all).map(([id, b]) => ({ id, ...b })));
  });
  return () => off(r, "value", unsub);
}

export { ref, set, get, update };
