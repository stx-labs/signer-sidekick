/* Signer Sidekick mockup shell — injects the shared sidebar + topbar and
   wires the theme + network toggles. Static prototype only. */
(function () {
  const NAV = [
    { group: "Operate" },
    { id: "overview", label: "Overview", icon: "ph-gauge", href: "overview.html" },
    { id: "registration", label: "Registration", icon: "ph-seal-check", href: "registration.html" },
    { id: "pool", label: "Pool", icon: "ph-users-three", href: "pool.html" },
    { id: "rewards", label: "Rewards", icon: "ph-coins", href: "rewards.html" },
    { id: "operations", label: "Operations", icon: "ph-list-checks", href: "operations.html", count: "3" },
    { group: "Configure" },
    { id: "setup", label: "Initial Setup", icon: "ph-sliders-horizontal", href: "setup.html" },
    { id: "enrollment", label: "Public Pool Page", icon: "ph-share-network", href: "enrollment.html" },
    { id: "settings", label: "Settings", icon: "ph-gear-six", href: "settings.html" },
  ];

  const STX_GLYPH =
    '<svg viewBox="0 0 17 18" fill="currentColor"><path d="M5.09 5.385C5.067 5.437 5.021 5.467 4.959 5.467H0.496C0.212 5.507 0 5.735 0 6.025V6.973C0 7.273 0.235 7.531 0.551 7.531H15.549C15.851 7.531 16.1 7.287 16.1 6.973V6.025C16.1 5.725 15.865 5.467 15.549 5.467H11.142C11.086 5.467 11.04 5.442 11.009 5.383C10.98 5.332 10.983 5.273 11.014 5.229L13.902 0.865C13.997 0.708 14.025 0.497 13.926 0.306C13.834 0.111 13.633 0 13.436 0H12.315C12.143 0 11.955 0.086 11.851 0.255L8.508 5.349C8.451 5.429 8.364 5.476 8.27 5.476H7.847C7.747 5.476 7.664 5.432 7.611 5.352L4.247 0.261C4.137 0.1 3.964 0.008 3.785 0.008H2.664C2.467 0.008 2.278 0.109 2.177 0.3C2.076 0.482 2.092 0.698 2.2 0.868L5.082 5.215C5.119 5.272 5.119 5.335 5.094 5.378Z"></path><path d="M8.663 12.001L11.86 16.839C11.964 17.008 12.152 17.094 12.324 17.094H13.445C13.648 17.094 13.833 16.979 13.931 16.805C14.032 16.625 14.02 16.398 13.907 16.231L11.037 11.888C11.002 11.834 10.998 11.778 11.027 11.722C11.062 11.662 11.113 11.635 11.161 11.635H15.551C15.853 11.635 16.102 11.391 16.102 11.077V10.129C16.102 9.829 15.867 9.571 15.551 9.571H0.551C0.249 9.571 0 9.815 0 10.129V11.077C0 11.377 0.235 11.635 0.551 11.635H4.949C5.018 11.635 5.056 11.663 5.077 11.71C5.112 11.778 5.106 11.831 5.076 11.873L2.188 16.237C2.093 16.395 2.065 16.608 2.166 16.8C2.263 16.985 2.449 17.102 2.654 17.102H3.775C3.962 17.102 4.128 17.012 4.229 16.858L7.592 11.768C7.645 11.687 7.728 11.643 7.828 11.643H8.251C8.346 11.643 8.433 11.691 8.49 11.772Z"></path></svg>';

  const body = document.body;
  const page = body.dataset.page || "";
  const mode = body.dataset.mode || "assist"; // observe | assist | automate
  const modeMeta = {
    observe: { cls: "mode-observe", label: "Observe" },
    assist: { cls: "mode-assist", label: "Assist" },
    automate: { cls: "mode-automate", label: "Automate" },
  }[mode];

  // ---- Sidebar ----
  const navHtml = NAV.map((n) => {
    if (n.group) return `<div class="nav-label">${n.group}</div>`;
    const active = n.id === page ? " active" : "";
    const count = n.count ? `<span class="count">${n.count}</span>` : "";
    return `<a class="item${active}" href="${n.href}"><i class="ph ${n.icon}"></i>${n.label}${count}</a>`;
  }).join("");

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.innerHTML = `
    <div class="brand">
      <div class="glyph">${STX_GLYPH}</div>
      <div class="name">Signer Sidekick<small>PoX-5 · v1</small></div>
    </div>
    <nav>${navHtml}</nav>
    <div class="spacer"></div>
    <div class="mode-card">
      <div class="l"><i class="ph ph-shield-check" style="font-size:13px"></i> Automation mode</div>
      <div class="m ${modeMeta.cls}"><span class="ind"></span>${modeMeta.label}</div>
    </div>`;

  const app = document.querySelector(".app");
  app.insertBefore(sidebar, app.firstChild);

  // ---- Topbar + freshness ----
  const content = document.querySelector(".content");
  const crumbs = body.dataset.crumbs || body.dataset.title || "";
  const fresh = body.dataset.fresh || "chain tip 962,184 · api synced · updated 4s ago";
  const stale = body.dataset.stale === "true";

  const topbar = document.createElement("div");
  topbar.className = "topbar";
  topbar.innerHTML = `
    <div class="crumbs">${crumbs}</div>
    <div class="right">
      <button class="chip-btn" id="netToggle" title="Toggle network (mockup)"><span class="net-mini"></span></button>
      <button class="chip-btn" id="themeToggle" title="Toggle theme"><i class="ph ph-moon"></i></button>
      <button class="chip-btn"><i class="ph ph-book-open"></i> Docs</button>
    </div>`;

  const freshness = document.createElement("div");
  freshness.className = "freshness" + (stale ? " stale" : "");
  freshness.innerHTML = `
    <span class="dot"></span>
    <span>${stale ? "Indexed data is behind" : "Live"}</span>
    <span class="sep">·</span>
    <span class="mono">${fresh}</span>
    <span class="right">
      <span class="hint-dot-legend">
        <span class="src src-chain">contract read-only</span>
        <span class="src src-api">indexed / estimated</span>
        <span class="src src-local">locally derived</span>
      </span>
    </span>`;

  content.insertBefore(freshness, content.firstChild);
  content.insertBefore(topbar, content.firstChild);

  // ---- Network badge + toggle ----
  function renderNet() {
    const testnet = document.documentElement.dataset.network === "testnet";
    const el = topbar.querySelector(".net-mini");
    el.outerHTML = testnet
      ? `<span class="net net-testnet net-mini"><span class="dot"></span>Testnet</span>`
      : `<span class="net net-mainnet net-mini"><span class="dot"></span>Mainnet</span>`;
  }
  renderNet();
  document.getElementById("netToggle").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.network = root.dataset.network === "testnet" ? "mainnet" : "testnet";
    renderNet();
  });

  // ---- Theme toggle ----
  const themeBtn = document.getElementById("themeToggle");
  function renderTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    themeBtn.innerHTML = dark ? '<i class="ph ph-sun"></i>' : '<i class="ph ph-moon"></i>';
  }
  renderTheme();
  themeBtn.addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    renderTheme();
  });
})();
