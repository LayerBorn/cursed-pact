import { $, show, toast } from "./common.js";
import { cpSignIn, cpSignUp, cpSignOut } from "../cpApi.js";
import { signInAsGuest, initFirebase } from "../firebase.js";

export function initAuth({ onSignedIn }) {
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
      await cpSignIn({ email, password });
      // Also sign into Firebase anonymously so the user can join multiplayer rooms.
      try { initFirebase(); await signInAsGuest(); } catch (e) { console.warn("Anon Firebase failed:", e); }
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = err.message || "Sign-in failed.";
    }
  });

  $("#btn-signup").addEventListener("click", async () => {
    const displayName = ($("#signup-name").value || "").trim();
    const email = ($("#signup-email").value || "").trim();
    const password = $("#signup-password").value || "";
    if (!email || !password) { toast("Email and password required.", "warn"); return; }
    if (password.length < 6) { toast("Password must be at least 6 characters.", "warn"); return; }
    try {
      await cpSignUp({ email, password, displayName });
      try { initFirebase(); await signInAsGuest(); } catch (e) { console.warn("Anon Firebase failed:", e); }
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = err.message || "Sign-up failed.";
    }
  });

  $("#btn-guest").addEventListener("click", async () => {
    try {
      initFirebase();
      await signInAsGuest();
      onSignedIn();
    } catch (err) {
      console.error(err);
      $("#auth-status").textContent = err.message || "Guest sign-in failed.";
    }
  });

  $("#signin-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-signin").click();
  });
  $("#signup-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-signup").click();
  });
}

export async function doSignOut() {
  try { await cpSignOut(); } catch {}
  // Don't sign out of Firebase — guest auth is needed for multiplayer.
}
