// packages/pwa/scripts/build-icons.mjs
// Regenerate PNG icons from public/icon.svg.
// Run: bun run --filter @cc-remote/pwa icons
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "..", "public");
const svg = readFileSync(resolve(pub, "icon.svg"));

await Promise.all([
  sharp(svg).resize(192, 192).png().toFile(resolve(pub, "icon-192.png")),
  sharp(svg).resize(512, 512).png().toFile(resolve(pub, "icon-512.png")),
  sharp(svg).resize(410, 410).extend({
    top: 51, bottom: 51, left: 51, right: 51,
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  }).png().toFile(resolve(pub, "icon-512-maskable.png")),
]);
console.log("icons regenerated");
