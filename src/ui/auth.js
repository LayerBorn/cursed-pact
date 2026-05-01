import { $, show, toast } from "./common.js";
import {
  initFirebase,
  signIn,
  signUp,
  signInAsGuest,
  signOut,
} from "../firebase.js";

export function initAuth({ onSignedIn }) {
  // Tab switching
  document.querySelectorAll('input[name="auth-mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      const mode = (document.querySelector('input[name="auth-mode"]:checked') || {}).value || "signin";
      $("#auth-panel-signin").classList.toggle("hidden", mode !== "signin");
      $("#auth-panel-signup").classList.toggle("hidden", mode !== "signup");
    });
  });

  $("#btn-signin").addEventListener("click", async () => {
    const email = ($("#signin-email").value || "").trim();
    const password = $("#signin-password").value || "";
    if (!email || !password) { toast("Email and password required.", "warn"); return; }
    try {
      initFirebase();
      await signIn({ email, password });
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = friendlyAuthError(err);
    }
  });

  $("#btn-signup").addEventListener("click", async () => {
    const displayName = ($("#signup-name").value || "").trim();
    const email = ($("#signup-email").value || "").trim();
    const password = $("#signup-password").value || "";
    if (!email || !password) { toast("Email and password required.", "warn"); return; }
    if (password.length < 6) { toast("Password must be at least 6 characters.", "warn"); return; }
    try {
      initFirebase();
      await signUp({ email, password, displayName });
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = friendlyAuthError(err);
    }
  });

  $("#btn-guest").addEventListener("click", async () => {
    try {
      initFirebase();
      await signInAsGuest();
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = friendlyAuthError(err);
    }
  });

  // Enter key submits the active panel
  $("#signin-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-signin").click();
  });
  $("#signup-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-signup").click();
  });
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  switch (code) {
    case "auth/invalid-email": return "That email doesn't look right.";
    case "auth/email-already-in-use": return "An account already exists for that email. Try signing in.";
    case "auth/weak-password": return "Password too short — use at least 6 characters.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password incorrect.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in isn't enabled in Firebase. Host needs to enable it.";
    case "auth/network-request-failed": return "Network error — try again.";
    default: return err?.message || "Sign-in failed.";
  }
}

export async function doSignOut() {
  try { await signOut(); } catch {}
}
