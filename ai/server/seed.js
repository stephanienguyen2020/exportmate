// Loads the synthetic stock, as the demo company's goods (access.js DEMO_COMPANY_ID), and the
// default news sources into Firestore.
// Usage: npm run seed            (upserts; keeps custom sources and when the scan first read news
// for the stock, `backfilledAt`)
import { db, goodsByCompany, sources } from "./db.js";
import { DEMO_COMPANY_ID } from "./access.js";
import { generateInventory, DEFAULT_SOURCES, STOCK_PROFILE } from "./seed/inventory.js";
import { reindexAll } from "./rag.js";

const items = generateInventory().sort((a, b) => a.sku.localeCompare(b.sku));
const batch = db.batch();
batch.set(goodsByCompany.doc(DEMO_COMPANY_ID), { profile: STOCK_PROFILE, items, updatedAt: new Date().toISOString() }, { merge: true });
for (const { id, ...s } of DEFAULT_SOURCES)
  batch.set(sources.doc(id), { ...s, builtIn: true, enabled: true }, { merge: true });
await batch.commit();
const value = items.reduce((n, i) => n + i.qtyOnHand * i.unitCostUsd, 0);
console.log(`Seeded ${items.length} stock items (USD ${Math.round(value).toLocaleString()} on hand) and ${DEFAULT_SOURCES.length} sources.`);
console.log("Vector index:", await reindexAll());
