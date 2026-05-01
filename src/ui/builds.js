import { $, show, toast, el, escapeHtml } from "./common.js";
import {
  cpIsSignedIn,
  cpListBuilds,
  cpGetBuild,
  cpSaveBuild,
  cpDeleteBuild,
  onCpAuthChange,
} from "../cpApi.js";
import { STARTER_TECHNIQUES, buildCharacter } from "../game/character.js";
import { generateAbilities, hostHasDmProvider } from "../gemini.js";
import { findProfanity } from "../util/profanity.js";

let editingBuildId = null;
let editingPreview = null; // { stats, abilities } before save
let unsubscribeBuilds = null;

// ──────────────────────────────────────────────────────────────────
// MY BUILDS LIST
// ──────────────────────────────────────────────────────────────────
export function initBuilds({ onBack, onEdit, onCreate }) {
  $("#btn-builds-back").addEventListener("click", onBack);
  $("#btn-builds-new").addEventListener("click", onCreate);
}

export async function showBuildsList() {
  if (!cpIsSignedIn()) {
    toast("Sign up for a free account to save builds across rooms.", "warn");
    return false;
  }
  show("view-builds");
  await refreshBuildsList();
  // Re-fetch when auth state changes (sign out etc.)
  if (unsubscribeBuilds) { try { unsubscribeBuilds(); } catch {} unsubscribeBuilds = null; }
  unsubscribeBuilds = onCpAuthChange((u) => {
    if (!u) renderBuildsList([]);
    else refreshBuildsList().catch(() => {});
  });
  return true;
}

export function leaveBuildsList() {
  if (unsubscribeBuilds) { try { unsubscribeBuilds(); } catch {} unsubscribeBuilds = null; }
}

async function refreshBuildsList() {
  try {
    const builds = await cpListBuilds();
    renderBuildsList(builds);
  } catch (err) {
    console.error(err);
    toast(`Couldn't load builds: ${err.message}`, "error");
  }
}

function renderBuildsList(builds) {
  const list = $("#builds-list");
  const empty = $("#builds-empty");
  list.innerHTML = "";
  if (!builds || !builds.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  // Sort by updatedAt desc
  builds.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const b of builds) {
    const card = el("div", { class: "build-card" });
    card.appendChild(el("div", { class: "build-card-header" }, [
      el("div", { class: "build-card-name" }, escapeHtml(b.name || "?")),
      el("div", { class: "build-card-grade" }, escapeHtml(b.grade || "Grade 3")),
    ]));
    if (b.technique) {
      card.appendChild(el("div", { class: "build-card-technique" }, escapeHtml(truncate(b.technique, 140))));
    }
    if (Array.isArray(b.abilities) && b.abilities.length) {
      card.appendChild(el("div", { class: "build-card-abilities" },
        b.abilities.map((a) => `${a.name} (${a.cost} CE)`).join(" · ")
      ));
    }
    if (b.stats) {
      card.appendChild(el("div", { class: "build-card-stats" },
        `Phys ${b.stats.phys} · Tech ${b.stats.tech} · Spirit ${b.stats.spirit}`
      ));
    }
    const actions = el("div", { class: "build-card-actions" });
    actions.appendChild(el("button", {
      class: "ghost small",
      onclick: () => window.__app.editBuild(b.id),
    }, "Edit"));
    actions.appendChild(el("button", {
      class: "ghost small",
      onclick: async () => {
        try {
          await cpSaveBuild({ ...b, id: undefined, name: `${b.name} (copy)`, createdAt: undefined, updatedAt: undefined });
          toast("Duplicated.", "ok");
          await refreshBuildsList();
        } catch (err) {
          toast(`Duplicate failed: ${err.message}`, "error");
        }
      },
    }, "Duplicate"));
    actions.appendChild(el("button", {
      class: "ghost small btn-delete",
      onclick: async () => {
        if (!confirm(`Delete "${b.name}"? This can't be undone.`)) return;
        try {
          await cpDeleteBuild(b.id);
          toast("Deleted.", "ok");
          await refreshBuildsList();
        } catch (err) {
          toast(`Delete failed: ${err.message}`, "error");
        }
      },
    }, "Delete"));
    card.appendChild(actions);
    list.appendChild(card);
  }
}

// ──────────────────────────────────────────────────────────────────
// BUILD EDITOR
// ──────────────────────────────────────────────────────────────────
export function initBuildEditor({ onSaved, onCancel }) {
  // Populate the technique-picker buttons.
  const picker = $("#build-technique-picker");
  picker.innerHTML = "";
  STARTER_TECHNIQUES.forEach((t) => {
    picker.appendChild(el("button", {
      type: "button",
      title: t.desc,
      onclick: () => {
        const v = `${t.name} — ${t.desc}`;
        $("#build-technique").value = v.slice(0, 400);
        $("#build-technique").dispatchEvent(new Event("input"));
      },
    }, t.name));
  });
  picker.appendChild(el("button", {
    type: "button",
    title: "Pick at random",
    onclick: () => {
      const t = STARTER_TECHNIQUES[Math.floor(Math.random() * STARTER_TECHNIQUES.length)];
      $("#build-technique").value = `${t.name} — ${t.desc}`.slice(0, 400);
      $("#build-technique").dispatchEvent(new Event("input"));
    },
  }, "🎲 Random"));

  // Char counters
  bindCounter("build-technique", "build-technique-counter", 400);
  bindCounter("build-domain", "build-domain-counter", 300);

  // Generate stats + abilities
  $("#btn-build-generate").addEventListener("click", async () => {
    const technique = ($("#build-technique").value || "").trim();
    const grade = $("#build-grade").value;
    if (!technique) { toast("Describe your technique first.", "warn"); return; }
    if (findProfanity(technique)) { toast("Profanity detected — please rephrase.", "error"); return; }

    if (!hostHasDmProvider()) {
      toast("Set up your DM provider (key or Ollama) to generate abilities.", "warn");
      window.__app.returnViewAfterKey = "view-build-editor";
      show("view-key");
      return;
    }

    const btn = $("#btn-build-generate");
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Generating…";
    try {
      const result = await generateAbilities({ technique, grade });
      editingPreview = result;
      renderPreview(result);
      $("#build-editor-status").textContent = "Generated. Click Save when you're happy.";
    } catch (err) {
      console.error(err);
      $("#build-editor-status").textContent = `Generation failed: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Save
  $("#btn-build-save").addEventListener("click", async () => {
    const name = ($("#build-name").value || "").trim();
    const grade = $("#build-grade").value;
    const technique = ($("#build-technique").value || "").trim();
    const domain = ($("#build-domain").value || "").trim();
    if (!name) { toast("Give the build a name.", "warn"); return; }
    if (!technique) { toast("Describe a cursed technique.", "warn"); return; }
    if (findProfanity(name) || findProfanity(technique) || findProfanity(domain)) {
      toast("Profanity detected — please rephrase.", "error"); return;
    }

    // Construct the saved character record.
    const base = buildCharacter({ name, grade, technique, domain });
    const saved = {
      ...base,
      ...(editingPreview?.abilities ? { abilities: editingPreview.abilities } : {}),
      ...(editingPreview?.stats ? { stats: editingPreview.stats } : {}),
    };

    try {
      const result = await cpSaveBuild(saved, editingBuildId);
      toast(editingBuildId ? "Saved." : "Build created.", "ok");
      onSaved(result?.id || editingBuildId);
    } catch (err) {
      console.error(err);
      $("#build-editor-status").textContent = `Save failed: ${err.message}`;
    }
  });

  $("#btn-build-editor-back").addEventListener("click", onCancel);
}

export async function openBuildEditor({ buildId } = {}) {
  editingBuildId = buildId || null;
  editingPreview = null;
  $("#build-editor-title").textContent = buildId ? "Edit build" : "New build";
  $("#build-editor-status").textContent = "";
  $("#build-preview").classList.add("hidden");
  $("#build-preview-stats").textContent = "";
  $("#build-preview-abilities").innerHTML = "";

  if (buildId) {
    try {
      const b = await cpGetBuild(buildId);
      if (b) {
        $("#build-name").value = b.name || "";
        $("#build-grade").value = b.grade || "Grade 3";
        $("#build-technique").value = b.technique || "";
        $("#build-domain").value = b.domain || "";
        $("#build-technique").dispatchEvent(new Event("input"));
        $("#build-domain").dispatchEvent(new Event("input"));
        if (Array.isArray(b.abilities) && b.abilities.length) {
          editingPreview = { abilities: b.abilities, stats: b.stats || null };
          renderPreview(editingPreview);
        }
      }
    } catch (err) {
      console.error("Could not load build:", err);
    }
  } else {
    // Reset for new build
    $("#build-name").value = "";
    $("#build-grade").value = "Grade 3";
    $("#build-technique").value = "";
    $("#build-domain").value = "";
    $("#build-technique").dispatchEvent(new Event("input"));
    $("#build-domain").dispatchEvent(new Event("input"));
  }
  show("view-build-editor");
}

function renderPreview(preview) {
  const statsRoot = $("#build-preview-stats");
  const abilitiesRoot = $("#build-preview-abilities");
  $("#build-preview").classList.remove("hidden");
  if (preview?.stats) {
    statsRoot.textContent = `Stats — Phys ${preview.stats.phys} · Tech ${preview.stats.tech} · Spirit ${preview.stats.spirit}`;
  } else {
    statsRoot.textContent = "";
  }
  abilitiesRoot.innerHTML = "";
  if (Array.isArray(preview?.abilities)) {
    for (const a of preview.abilities) {
      abilitiesRoot.appendChild(el("div", { class: "builds-ability-row" }, [
        el("span", { class: "builds-ability-name" }, escapeHtml(a.name)),
        el("span", { class: "builds-ability-cost" }, `${a.cost} CE`),
        el("div", { class: "builds-ability-effect muted small" }, escapeHtml(a.effect)),
      ]));
    }
  }
}

function bindCounter(inputId, counterId, max) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const update = () => {
    const c = document.getElementById(counterId);
    if (!c) return;
    const len = (input.value || "").length;
    c.textContent = `${len} / ${max}`;
    c.classList.toggle("near-limit", len > max * 0.85);
  };
  input.addEventListener("input", update);
  update();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
