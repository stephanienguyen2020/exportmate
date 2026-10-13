// Copies every top-level collection from one project's Firestore to another's,
// keeping document ids and vector embeddings. Used to move the AI service's data
// (stock, sources, articles, alerts, scans, vector index, audits, eval runs) into
// the consolidated project. Documents in the target with the same id are replaced.
//
// Usage: node copy-firestore.js --from=exportmate-app --to=skilful-scarab-511320-q9 [--dry-run]
import { Firestore } from "@google-cloud/firestore";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const from = arg("from");
const to = arg("to");
const dryRun = process.argv.includes("--dry-run");
if (!from || !to || from === to) {
  console.error("Usage: node copy-firestore.js --from=<project> --to=<project> [--dry-run]");
  process.exit(2);
}
// Locks are per-database runtime state, not data.
const SKIP = new Set(["locks"]);

const source = new Firestore({ projectId: from });
const target = new Firestore({ projectId: to });

let total = 0;
for (const collection of await source.listCollections()) {
  if (SKIP.has(collection.id)) continue;
  const snap = await collection.get();
  if (!dryRun)
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = target.batch();
      for (const doc of snap.docs.slice(i, i + 400)) batch.set(target.collection(collection.id).doc(doc.id), doc.data());
      await batch.commit();
    }
  total += snap.size;
  console.log(`${dryRun ? "would copy" : "copied"} ${String(snap.size).padStart(5)}  ${collection.id}`);
}
console.log(`${total} documents ${dryRun ? "to copy" : "copied"} from ${from} to ${to}.`);
