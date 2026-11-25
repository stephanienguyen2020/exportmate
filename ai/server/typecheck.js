// Static type check of the service (TypeScript over plain JS, jsconfig.json). Fails on any
// error not in typecheck-baseline.txt: the errors from before CI ran it, mostly where inference
// can't see an optional argument's shape. Kept without line numbers, so edits elsewhere don't
// shift them. `npm run typecheck`; `npm run typecheck -- --update` after fixing baseline errors.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const BASELINE = new URL("./typecheck-baseline.txt", import.meta.url);
const ERROR = /^(?<file>[^(]+)\(\d+,\d+\): error (?<code>TS\d+): (?<message>.*)$/;

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const run = spawnSync(process.execPath, [tsc, "-p", "jsconfig.json", "--pretty", "false"], {
  cwd: new URL(".", import.meta.url),
  encoding: "utf8",
});
const lines = run.stdout.split("\n").filter((l) => ERROR.test(l));
if (run.status !== 0 && !lines.length) {
  console.error(run.stdout, run.stderr);
  process.exit(2);
}
const key = (line) => {
  const { file, code, message } = line.match(ERROR).groups;
  return `${file}: ${code} ${message}`;
};
const count = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
const current = lines.map(key);

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, current.sort().map((k) => k + "\n").join(""));
  console.log(`Wrote ${current.length} errors to typecheck-baseline.txt.`);
  process.exit(0);
}

const known = count(existsSync(BASELINE) ? readFileSync(BASELINE, "utf8").split("\n").filter(Boolean) : []);
const left = new Map(known);
const fresh = [];
for (const [i, k] of current.entries()) {
  if (left.get(k) > 0) left.set(k, left.get(k) - 1);
  else fresh.push(lines[i]);
}
if (fresh.length) {
  console.error("New type errors (not in typecheck-baseline.txt):");
  for (const line of fresh) console.error("  " + line);
  process.exit(1);
}
const fixed = [...left.values()].reduce((a, b) => a + b, 0);
console.log(`typecheck: no new errors (${current.length} known in typecheck-baseline.txt).`);
if (fixed) console.log(`${fixed} baseline errors are fixed; run with --update to drop them.`);
