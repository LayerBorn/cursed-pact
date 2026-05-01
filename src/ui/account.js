// Account settings view — change display name, password, delete account.
// Also hosts the verification-banner wiring on the lobby.
import { $, show, toast } from "./common.js";
import {
  cpUser, cpIsSignedIn,
  cpUpdateDisplayName, cpChangePassword, cpDeleteAccount,
  cpResendVerification, cpVerifyEmail, cpRefreshMe,
} from "../cpApi.js";

export function initAccount({ onBack, onAccountDeleted }) {
  $("#btn-account-back").addEventListener("click", onBack);

  $("#btn-account-save-name").addEventListener("click", async () => {
    const name = ($("#account-display-name").value || "").trim();
    if (!name) { toast("Display name can't be empty.", "warn"); return; }
    try {
      await cpUpdateDisplayName(name);
      toast("Saved.", "ok");
      hydrateAccountView();
    } catch (err) { setStatus(err.message, true); }
  });

  $("#btn-account-change-pw").addEventListener("click", async () => {
    const cur = $("#account-current-pw").value;
    const next = $("#account-new-pw").value;
    if (!cur || !next) { toast("Both passwords required.", "warn"); return; }
    if (next.length < 6) { toast("New password must be 6+ chars.", "warn"); return; }
    try {
      await cpChangePassword({ currentPassword: cur, newPassword: next });
      $("#account-current-pw").value = "";
      $("#account-new-pw").value = "";
      toast("Password changed.", "ok");
    } catch (err) { setStatus(err.message, true); }
  });

  $("#btn-account-delete").addEventListener("click", async () => {
    const pw = $("#account-delete-pw").value;
    if (!pw) { toast("Confirm with your current password.", "warn"); return; }
    if (!confirm("Permanently delete your account and ALL saved builds? This cannot be undone.")) return;
    try {
      await cpDeleteAccount(pw);
      toast("Account deleted.", "ok");
      onAccountDeleted && onAccountDeleted();
    } catch (err) { setStatus(err.message, true); }
  });
}

export function showAccountView() {
  if (!cpIsSignedIn()) {
    toast("Sign in to manage your account.", "warn");
    return false;
  }
  hydrateAccountView();
  show("view-account");
  return true;
}

function hydrateAccountView() {
  const u = cpUser() || {};
  const av = $("#account-avatar"); if (av) av.textContent = avatarLetters(u);
  const em = $("#account-email"); if (em) em.textContent = u.email || "—";
  const tag = $("#account-verified-tag");
  if (tag) {
    tag.textContent = u.verified ? "✓ Verified" : "Unverified — check your inbox";
    tag.classList.toggle("verified", !!u.verified);
  }
  const nm = $("#account-display-name");
  if (nm) nm.value = u.displayName || (u.email ? u.email.split("@")[0] : "");
}

function setStatus(text, isError = false) {
  const el = $("#account-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

// ─────────────── Verification banner (lobby) ───────────────
export function initVerifyBanner() {
  $("#btn-verify-resend").addEventListener("click", async () => {
    try {
      const r = await cpResendVerification();
      if (r?.alreadyVerified) {
        toast("Already verified.", "ok");
        await cpRefreshMe();
        renderVerifyBanner();
      } else if (r?.devAutoVerified) {
        toast("Dev mode — auto-verified.", "ok");
        await cpRefreshMe();
        renderVerifyBanner();
      } else {
        toast("Verification email sent.", "ok");
      }
    } catch (err) {
      toast(`Couldn't resend: ${err.message}`, "error");
    }
  });
  $("#btn-verify-dismiss").addEventListener("click", () => {
    sessionStorage.setItem("cp_verify_dismissed", "1");
    $("#verify-banner").classList.add("hidden");
  });
}

export function renderVerifyBanner() {
  const banner = $("#verify-banner");
  if (!banner) return;
  if (!cpIsSignedIn()) { banner.classList.add("hidden"); return; }
  const u = cpUser();
  if (!u || u.verified) { banner.classList.add("hidden"); return; }
  if (sessionStorage.getItem("cp_verify_dismissed") === "1") { banner.classList.add("hidden"); return; }
  banner.classList.remove("hidden");
  const msg = $("#verify-banner-msg");
  if (msg) msg.textContent = `We sent a link to ${u.email}.`;
}

// ─────────────── ?verify= and ?reset= URL parameter handlers ───────────────
// On page load, if a verify token is present, exchange it; show a toast.
export async function handleVerifyParam() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("verify");
  if (!token) return;
  // Strip the param from the URL so refreshes don't re-send.
  params.delete("verify");
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
  window.history.replaceState({}, "", newUrl);
  try {
    const r = await cpVerifyEmail(token);
    if (r?.alreadyVerified) toast("Email was already verified.", "ok");
    else toast("Email verified! 🌀", "ok");
    if (r?.user) await cpRefreshMe();
  } catch (err) {
    toast(`Verification failed: ${err.message}`, "error");
  }
}

// ─────────────── Avatar helpers ───────────────
export function avatarLetters(user) {
  if (!user) return "?";
  const src = user.displayName || user.email || "";
  const letters = src.trim().split(/[\s._-]+/).filter(Boolean).map(p => p[0]).join("").slice(0, 2).toUpperCase();
  return letters || (src[0] || "?").toUpperCase();
}

// Hash a string to a stable color from a small palette so each user has a
// recognizable avatar tint across sessions.
const AV_COLORS = ["#8a5cff", "#5ee0a6", "#6fb5ff", "#ffb84d", "#ff7b8a", "#7adfd1", "#ffaa7a", "#a7e85b"];
export function avatarColorFor(user) {
  const seed = user?.uid || user?.email || "?";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AV_COLORS[Math.abs(hash) % AV_COLORS.length];
}
