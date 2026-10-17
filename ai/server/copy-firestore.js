// Copies the top-level collections from one project's Firestore to another's, keeping document
// ids. Used to move the AI service's data (stock, sources, company source settings, articles,
// alerts, scans, audits, eval runs) into the consolidated project. Documents already in the
// target are kept: it runs the newer code (alerts with mentions), and copying again just before
// the switch only adds what the source gained meanwhile.
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
// Not data, or tied to the source project. locks: runtime state. rag_files: the source's RAG
// Engine files (copied, the target's index would think those records were already in it).
// chat_sessions: the source's Agent Platform sessions. answer_cache: rebuilt as people ask.
// companyGoods: rebuilt from the backend; a copy would carry the source's backfilledAt, so the
// target's first scan wouldn't read back each company's recent news. kb: the old vector index.
const SKIP = new Set(["locks", "rag_files", "chat_sessions", "answer_cache", "companyGoods", "kb"]);

const source = new Firestore({ projectId: from });
const target = new Firestore({ projectId: to });

let total = 0;
for (const collection of await source.listCollections()) {
  if (SKIP.has(collection.id)) continue;
  const there = new Set((await target.collection(collection.id).select().get()).docs.map((d) => d.id));
  const docs = (await collection.get()).docs.filter((d) => !there.has(d.id));
  if (!dryRun)
    for (let i = 0; i < docs.length; i += 400) {
      const batch = target.batch();
      for (const doc of docs.slice(i, i + 400)) batch.set(target.collection(collection.id).doc(doc.id), doc.data());
      await batch.commit();
    }
  total += docs.length;
  console.log(`${dryRun ? "would copy" : "copied"} ${String(docs.length).padStart(5)}  ${collection.id}${there.size ? ` (${there.size} already there, kept)` : ""}`);
}
console.log(`${total} documents ${dryRun ? "to copy" : "copied"} from ${from} to ${to}.`);
