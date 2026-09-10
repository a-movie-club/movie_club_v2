const variants = [
  { key: "A", label: "Token specimen" },
  { key: "B", label: "Club night" },
  { key: "C", label: "Admin stress test" },
];

const templates = {
  A: `
    <section class="specimen" aria-labelledby="specimen-title">
      <div class="specimen-header">
        <div>
          <p class="eyebrow">Specimen A · semantics</p>
          <h1 class="page-title" id="specimen-title">One palette, named by purpose.</h1>
          <p class="lede">The v1 identity colors survive as centralized primitives. Components only see shadcn's semantic tokens.</p>
        </div>
      </div>
      <div class="token-grid">
        ${[
          ["Background", "--background"],
          ["Foreground", "--foreground"],
          ["Card", "--card"],
          ["Primary", "--primary"],
          ["Secondary", "--secondary"],
          ["Muted", "--muted"],
          ["Accent", "--accent"],
          ["Destructive", "--destructive"],
          ["Border", "--border"],
          ["Ring", "--ring"],
        ]
          .map(
            ([name, token]) => `
              <article class="token-chip">
                <div class="token-swatch" style="--swatch: var(${token})"></div>
                <strong>${name}</strong>
                <code>${token}</code>
              </article>`,
          )
          .join("")}
      </div>
      <div class="component-row" aria-label="Component token examples">
        <button class="button button-primary" type="button">Primary action</button>
        <button class="button button-secondary" type="button">Secondary</button>
        <button class="button button-destructive" type="button">Delete</button>
        <span class="badge">Muted metadata</span>
        <span class="badge badge-accent">Current session</span>
        <input class="input" aria-label="Movie search example" value="Search movies…" readonly />
      </div>
    </section>`,
  B: `
    <section class="specimen" aria-labelledby="session-title">
      <p class="eyebrow">Specimen B · real content pressure</p>
      <div class="session-shell">
        <div class="session-main">
          <span class="session-kicker">September session</span>
          <h1 id="session-title">Difficult Moms</h1>
          <p class="session-meta">Saturday, September 19 · 7:30 PM<br />Two films. Twelve opinions. One deeply unserious scorecard.</p>
          <button class="button button-primary" type="button">View this session →</button>
        </div>
        <div class="poster-pair" aria-label="This session's movies">
          <article class="poster">
            <span class="poster-number">FILM 01</span>
            <strong>All About<br />My Mother</strong>
          </article>
          <article class="poster">
            <span class="poster-number">FILM 02</span>
            <strong>Mommy<br />Dearest</strong>
          </article>
        </div>
      </div>
    </section>`,
  C: `
    <section class="specimen" aria-labelledby="admin-title">
      <div class="specimen-header">
        <div>
          <p class="eyebrow">Specimen C · edge states</p>
          <h1 class="page-title" id="admin-title">Can the tokens handle the boring bits?</h1>
        </div>
      </div>
      <div class="admin-grid">
        <nav class="admin-nav" aria-label="Admin sections">
          <h2>Club admin</h2>
          <button class="active" type="button">Upcoming session</button>
          <button type="button">Movie catalog</button>
          <button type="button">Members</button>
        </nav>
        <div class="admin-panel">
          <p class="eyebrow">October 2026</p>
          <h1>Schedule a session</h1>
          <div class="form-grid">
            <label class="field">
              <span>Theme</span>
              <input class="input" value="Heist!" />
            </label>
            <label class="field">
              <span>Meeting date</span>
              <input class="input" type="date" value="2026-10-17" />
            </label>
          </div>
          <div class="alert-stack">
            <div class="alert alert-muted">Empty: add two sibling movies when the picks are ready.</div>
            <div class="alert alert-success">Saved: the session is visible to all members.</div>
            <div class="alert alert-destructive">Database unavailable. Your changes were not saved.</div>
          </div>
          <div class="form-actions">
            <button class="button button-primary" type="button">Save session</button>
            <button class="button button-secondary" type="button">Cancel</button>
            <button class="button button-destructive" type="button">Delete session</button>
          </div>
        </div>
      </div>
    </section>`,
};

const params = new URLSearchParams(window.location.search);
let currentVariant = variants.some(({ key }) => key === params.get("variant"))
  ? params.get("variant")
  : "A";
let currentTheme = params.get("theme") === "dark" ? "dark" : "light";
let currentFont = params.get("font") === "legacy" ? "legacy" : "system";

const app = document.querySelector("#app");
const variantLabel = document.querySelector("#variant-label");
const stateReadout = document.querySelector("#state-readout");
const themeToggle = document.querySelector("#theme-toggle");
const fontToggle = document.querySelector("#font-toggle");

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", currentVariant);
  url.searchParams.set("theme", currentTheme);
  url.searchParams.set("font", currentFont);
  window.history.replaceState(null, "", url);
}

function render() {
  document.documentElement.classList.toggle("dark", currentTheme === "dark");
  document.documentElement.dataset.font = currentFont;
  app.innerHTML = templates[currentVariant];

  const selected = variants.find(({ key }) => key === currentVariant);
  variantLabel.textContent = `${selected.key} (${selected.label})`;
  themeToggle.textContent = currentTheme === "dark" ? "Light mode" : "Dark mode";
  fontToggle.textContent = `Font: ${currentFont}`;
  stateReadout.textContent = `variant=${currentVariant} · theme=${currentTheme} · font=${currentFont}`;
  syncUrl();
}

function cycleVariant(direction) {
  const index = variants.findIndex(({ key }) => key === currentVariant);
  currentVariant = variants[(index + direction + variants.length) % variants.length].key;
  render();
}

document.querySelector("#previous-variant").addEventListener("click", () => cycleVariant(-1));
document.querySelector("#next-variant").addEventListener("click", () => cycleVariant(1));

themeToggle.addEventListener("click", () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  render();
});

fontToggle.addEventListener("click", () => {
  currentFont = currentFont === "system" ? "legacy" : "system";
  render();
});

document.addEventListener("keydown", (event) => {
  const tagName = event.target.tagName;
  const isEditing = ["INPUT", "TEXTAREA", "SELECT"].includes(tagName) || event.target.isContentEditable;
  if (isEditing) return;

  if (event.key === "ArrowLeft") cycleVariant(-1);
  if (event.key === "ArrowRight") cycleVariant(1);
});

render();
