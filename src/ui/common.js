// Tiny vanilla UI helpers shared across views.

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");
}

export function toast(message, kind = "") {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// marked is loaded as a global script tag.
export function renderMarkdown(text) {
  if (typeof window.marked?.parse === "function") {
    return window.marked.parse(text || "", { breaks: true });
  }
  return escapeHtml(text || "");
}

// Animate a d20 roll. Calls onResult(result) with the final number.
export function animateD20(displayEl, finalValue) {
  return new Promise((resolve) => {
    if (!displayEl) { resolve(); return; }
    displayEl.classList.add("d20-rolling");
    let ticks = 0;
    const interval = setInterval(() => {
      displayEl.textContent = String(1 + Math.floor(Math.random() * 20));
      ticks++;
      if (ticks > 8) {
        clearInterval(interval);
        displayEl.textContent = String(finalValue);
        displayEl.classList.remove("d20-rolling");
        resolve();
      }
    }, 60);
  });
}
