// Bundles cloudflare/worker.ts plus the prebuilt Next.js UI into dist/worker.js.
// Run after `npm run build`. The output contains no secrets: they are Worker secrets at runtime.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const assets = { "/index.html": readFileSync(join(root, ".next/server/app/index.html"), "utf8") };
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk(join(root, ".next/static"))) assets["/_next/static/" + relative(join(root, ".next/static"), f)] = readFileSync(f, "utf8");
writeFileSync(join(root, "cloudflare/assets.generated.js"), `export const ASSETS = ${JSON.stringify(assets)};\n`);
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  entryPoints: [join(root, "cloudflare/worker.ts")], bundle: true, format: "esm", platform: "neutral", target: "es2022",
  outfile: join(root, "dist/worker.js"), external: ["node:*"], conditions: ["workerd", "worker", "import"], mainFields: ["module", "main"],
  alias: { "@": root }, minify: true, legalComments: "none", logLevel: "warning",
});
console.log(`dist/worker.js ${(statSync(join(root, "dist/worker.js")).size / 1024).toFixed(0)} KB, ${Object.keys(assets).length} assets`);
