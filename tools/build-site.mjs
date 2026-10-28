#!/usr/bin/env node
// Builds the GitHub Pages site for the course into ../_site.
//
//   cd tools && npm install && npm run build      -> ../_site, ready to preview or publish
//   npm run publish                               -> build, then push ../_site to the gh-pages branch
//
// Guides (course/*.md) become styled HTML pages; the handout, slide deck and images are copied as is.
// If course/instructor/instructor-guide.md exists (it does in the instructor's checkout, not in the
// public repo), it is rendered to an unlinked page at instructor/index.html.
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COURSE = join(ROOT, "course");
const OUT = join(ROOT, "_site");
const REPO = "https://github.com/varoonsahgal/opencode-mcp-course";

const PAGES = [
  ["README.md", "index.html", "Course home"],
  ["00-setup.md", "00-setup.html", "00 · Setup"],
  ["01-connecting-agents-with-mcp.md", "01-connecting-agents-with-mcp.html", "01 · Connect"],
  ["02-configuring-mcp-in-opencode.md", "02-configuring-mcp-in-opencode.html", "02 · Configure"],
  ["03-building-a-custom-mcp-server.md", "03-building-a-custom-mcp-server.html", "03 · Build"],
  ["04-securing-mcp-integrations.md", "04-securing-mcp-integrations.html", "04 · Secure"],
  ["05-applied-challenge.md", "05-applied-challenge.html", "05 · Apply"],
  ["06-advanced-mcp.md", "06-advanced-mcp.html", "06 · Go remote"],
];

const CALLOUT = { NOTE: ["note", "Note"], TIP: ["tip", "Tip"], IMPORTANT: ["important", "Important"], WARNING: ["warning", "Warning"], CAUTION: ["caution", "Caution"] };

function render(md, { instructor = false } = {}) {
  let html = marked.parse(md, { gfm: true });
  // GitHub-style alerts: > [!TIP] ... become styled callouts.
  html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, (_, k) => `<blockquote class="callout ${CALLOUT[k][0]}"><p>`);
  // Links between guides point at the rendered pages; links into the lab folders point at GitHub.
  html = html.replace(/href="([^"#:]+?)\.md(#[^"]*)?"/g, (_, p, h = "") => `href="${p === "README" ? "index" : p}.html${h}"`);
  html = html.replace(/href="(labs\/[^"]*)"/g, (_, p) => `href="${REPO}/tree/main/course/${p}"`);
  html = html.replace(/href="(slides\/)index\.html"/g, 'href="slides/index.html"');
  // Headings get ids so deep links work.
  html = html.replace(/<h([23])>(.*?)<\/h\1>/g, (_, n, t) => {
    const id = t.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    return `<h${n} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${t}</h${n}>`;
  });
  if (instructor) html = html.replace(/<h1>/, '<h1 class="instr">');
  return html;
}

function page({ title, body, current, depth = 0, instructor = false }) {
  const up = "../".repeat(depth);
  const nav = PAGES.map(([, out, label]) => `<a href="${up}${out}"${out === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${instructor ? '<meta name="robots" content="noindex, nofollow">\n' : ""}<title>${title} · MCP with AI Agents</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="${up}assets/site.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%234f46e5'/%3E%3C/svg%3E">
</head>
<body${instructor ? ' class="instructor"' : ""}>
<header class="top">
  <a class="brand" href="${up}index.html"><span class="dot"></span>MCP with AI Agents</a>
  <nav class="links">${nav}<span class="sep"></span><a href="${up}handout.html">Handout</a><a href="${up}slides/index.html">Slides</a><a href="${REPO}">GitHub</a></nav>
  <button class="menu" type="button" aria-label="Menu" onclick="document.body.classList.toggle('open')">☰</button>
</header>
<main class="doc">
${instructor ? '<p class="instr-banner">Instructor guide · not linked from the student site · answer keys below</p>\n' : ""}${body}
</main>
<footer class="foot">MCP with AI Agents · OpenCode + MCP course · <a href="${REPO}">source and labs on GitHub</a></footer>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
  document.querySelectorAll("pre code").forEach((el) => {
    const m = el.className.match(/language-(\\w+)/);
    if (m && m[1] === "jsonc") el.className = "language-json";
    if (!m) el.classList.add("nohighlight");
    window.hljs && hljs.highlightElement(el);
    const b = document.createElement("button"); b.className = "copy"; b.type = "button"; b.textContent = "Copy";
    b.onclick = () => { navigator.clipboard.writeText(el.innerText).then(() => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); }); };
    el.parentElement.appendChild(b);
  });
  document.querySelectorAll("main table").forEach((t) => { const w = document.createElement("div"); w.className = "tbl"; t.replaceWith(w); w.appendChild(t); });
</script>
</body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "assets"), { recursive: true });
writeFileSync(join(OUT, ".nojekyll"), "");
cpSync(join(ROOT, "tools", "site.css"), join(OUT, "assets", "site.css"));
cpSync(join(COURSE, "images"), join(OUT, "images"), { recursive: true });
cpSync(join(COURSE, "slides"), join(OUT, "slides"), { recursive: true });
writeFileSync(join(OUT, "handout.html"), readFileSync(join(COURSE, "handout.html"), "utf8").replace(/href="([0-9][^"#:]*?)\.md"/g, 'href="$1.html"'));

for (const [src, out, label] of PAGES) {
  let md = readFileSync(join(COURSE, src), "utf8");
  if (src === "README.md") {
    md = md.replace("## Quick start", `## Get the labs\n\nEverything you run lives in the repository: \`git clone ${REPO}.git\`, then follow the quick start below from the \`course/\` folder.\n\n## Quick start`);
  }
  const title = (md.match(/^# (.+)$/m)?.[1] ?? label).replace(/[`*]/g, "");
  writeFileSync(join(OUT, out), page({ title, body: render(md), current: out }));
}

const guide = join(COURSE, "instructor", "instructor-guide.md");
if (existsSync(guide)) {
  mkdirSync(join(OUT, "instructor"), { recursive: true });
  writeFileSync(join(OUT, "instructor", "index.html"), page({ title: "Instructor guide", body: render(readFileSync(guide, "utf8"), { instructor: true }), depth: 1, instructor: true }));
  console.log("built instructor/index.html (unlinked)");
}
console.log(`built ${PAGES.length} guide pages, handout, slides and ${readdirSync(join(OUT, "images")).length} images into _site/`);
