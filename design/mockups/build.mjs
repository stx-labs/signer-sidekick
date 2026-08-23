// Builds the reward-operations mockups from design/mockups/src.
//   node design/mockups/build.mjs
// Outputs: pages/<Screen>.html (linked to the real dashboard CSS + fonts), index.html (gallery),
// canvas/<Screen>.dc.html + canvas/canvas.json (Claude Design canvas artboards, CSS inlined).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const pagesDir = join(root, "pages");
const canvasDir = join(root, "canvas");
mkdirSync(pagesDir, { recursive: true });
mkdirSync(canvasDir, { recursive: true });

const read = (path) => readFileSync(path, "utf8");
const include = (html) =>
  html.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_match, name) =>
    include(read(join(src, "partials", `${name}.html`))),
  );

const screens = JSON.parse(read(join(src, "screens.json")));
const tokens = read(join(root, "..", "tokens", "tokens.css"));
const base = read(join(root, "..", "..", "apps", "dashboard", "src", "base.css"));
const styles = read(join(root, "..", "..", "apps", "dashboard", "src", "styles.css"));
const mock = read(join(src, "mockup.css"));
// Cache-bust the mockup stylesheet so the local gallery always shows the current rules.
const stamp = Date.now().toString(36);
// The canvas cannot load the self-hosted brand fonts; drop the @font-face blocks so the token
// fallback stacks apply, and load Instrument Sans from Google Fonts instead.
const canvasCss = [tokens.replace(/@font-face\s*\{[^}]*\}/g, ""), base, styles, mock].join("\n");

for (const screen of screens) {
  const body = include(read(join(src, `${screen.file}.html`)));
  writeFileSync(
    join(pagesDir, `${screen.file}.html`),
    `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${screen.title} · reward operations mockup</title>
<link rel="stylesheet" href="../../tokens/tokens.css">
<link rel="stylesheet" href="../../../apps/dashboard/src/base.css">
<link rel="stylesheet" href="../../../apps/dashboard/src/styles.css">
<link rel="stylesheet" href="../src/mockup.css?v=${stamp}">
<script>
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
</script>
</head>
<body>
${body}
</body>
</html>
`,
  );
  writeFileSync(
    join(canvasDir, `${screen.file}.dc.html`),
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap">
  <style>
${canvasCss}
  a { color: inherit; }
  a:hover { color: var(--text-interactive-hover); }
  </style>
</helmet>
<div data-theme="{{theme}}" style="min-height: 100%; background: var(--surface-tertiary); color: var(--text-primary);">
${body}
</div>
</x-dc>
<script data-dc-script data-props='{"theme":{"editor":"enum","options":["light","dark"],"default":"light","section":"Theme"}}'>
class Component extends DCLogic {
  renderVals() {
    return { theme: this.props.theme ?? "light" };
  }
}
</script>
</body>
</html>
`,
  );
}

writeFileSync(
  join(canvasDir, "canvas.json"),
  `${JSON.stringify(
    {
      artboards: screens.map(({ file, title, x, y, w, h }) => ({
        file: `${file}.dc.html`,
        title,
        x,
        y,
        w,
        h,
      })),
      annotations: JSON.parse(read(join(src, "annotations.json"))),
      launch: { view: "canvas" },
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(root, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reward operations mockups</title>
<link rel="stylesheet" href="../tokens/tokens.css">
<style>
  body { margin: 0; padding: 32px; background: var(--sand-150); color: var(--text-primary); font-family: var(--font-body); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: 24px; margin: 0; }
  p.lede { color: var(--text-secondary); margin: 4px 0 0; font-size: 13px; max-width: 720px; }
  .mock-toggle { font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-primary); background: var(--surface-fourth); cursor: pointer; }
  .mock-grid { display: grid; gap: 32px; }
  .mock-frame h2 { font-family: var(--font-display); font-weight: 500; font-size: 15px; margin: 0 0 8px; }
  .mock-frame h2 small { font-family: var(--font-mono); font-weight: 400; color: var(--text-tertiary); margin-left: 8px; }
  .mock-frame iframe { border: 1px solid var(--border-primary); border-radius: 12px; background: #fff; display: block; max-width: 100%; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Reward operations mockups</h1>
    <p class="lede">Each frame is a standalone page rendered with the real dashboard stylesheet, tokens, and fonts. Source: design/mockups/src. Plan: docs/product/reward-operations-plan.md.</p>
  </div>
  <button class="mock-toggle" type="button" id="theme">Dark theme</button>
</header>
<div class="mock-grid">
${screens
  .map(
    ({ file, title, w, h }) =>
      `  <section class="mock-frame"><h2>${title}<small>${file}.html · ${w}×${h}</small></h2><iframe title="${title}" src="pages/${file}.html" width="${w}" height="${Math.min(h, 1100)}" loading="lazy"></iframe></section>`,
  )
  .join("\n")}
</div>
<script>
  const button = document.getElementById("theme");
  let dark = false;
  button.addEventListener("click", () => {
    dark = !dark;
    button.textContent = dark ? "Light theme" : "Dark theme";
    for (const frame of document.querySelectorAll("iframe")) {
      const url = new URL(frame.getAttribute("src"), location.href);
      url.searchParams.set("theme", dark ? "dark" : "light");
      frame.src = url.pathname.split("/").slice(-2).join("/") + url.search;
    }
  });
</script>
</body>
</html>
`,
);

console.log(`built ${screens.length} screens → pages/, canvas/, index.html`);
