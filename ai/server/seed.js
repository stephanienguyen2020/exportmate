// Loads the synthetic stock and the default news sources into Firestore.
// Usage: npm run seed            (upserts; keeps custom sources)
import { db, inventory, sources } from "./db.js";
import { generateInventory, DEFAULT_SOURCES } from "./seed/inventory.js";
import { reindexAll } from "./rag.js";

const items = generateInventory();
const batch = db.batch();
for (const item of items) batch.set(inventory.doc(item.sku), item);
for (const { id, ...s } of DEFAULT_SOURCES)
  batch.set(sources.doc(id), { ...s, builtIn: true, enabled: true }, { merge: true });
await batch.commit();
const value = items.reduce((n, i) => n + i.qtyOnHand * i.unitCostUsd, 0);
console.log(`Seeded ${items.length} stock items (USD ${Math.round(value).toLocaleString()} on hand) and ${DEFAULT_SOURCES.length} sources.`);
console.log("Vector index:", await reindexAll());
