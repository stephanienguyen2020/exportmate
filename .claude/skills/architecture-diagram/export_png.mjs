// Render an .excalidraw file to PNG with Excalidraw's own exporter, in headless Chromium, so the image
// looks exactly like excalidraw.com (fonts, arrow labels where Excalidraw puts them).
// Run from frontend/ (it borrows that folder's Playwright):
//   cd frontend && node ../.claude/skills/architecture-diagram/export_png.mjs ../docs/<name>.excalidraw ../docs/<name>.png
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(`${process.cwd()}/`)("@playwright/test");
const [input, output] = process.argv.slice(2);
const scene = JSON.parse(readFileSync(input, "utf8"));
const base = "https://unpkg.com/@excalidraw/excalidraw@0.17.6/dist/";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
  `<!doctype html><html><head>
<style>@font-face { font-family: "Virgil"; src: url("${base}excalidraw-assets/Virgil.woff2"); }</style>
<script>window.EXCALIDRAW_ASSET_PATH = "${base}";</script>
<script src="https://unpkg.com/react@18.2.0/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
<script src="${base}excalidraw.production.min.js"></script>
</head><body></body></html>`,
  { waitUntil: "networkidle" },
);
const png = await page.evaluate(async (data) => {
  await document.fonts.load('20px "Virgil"');
  const blob = await window.ExcalidrawLib.exportToBlob({
    elements: data.elements,
    files: data.files,
    appState: { ...data.appState, exportBackground: true, viewBackgroundColor: "#ffffff", exportScale: 2 },
    mimeType: "image/png",
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}, scene);
writeFileSync(output, Buffer.from(png, "base64"));
await browser.close();
console.log(`wrote ${output}`);
