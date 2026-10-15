// Each company's goods (goods.js), kept in Firestore companyGoods/{companyId} for the daily
// scan, which runs without anyone's token. A member's read (News watch's stock list, a chat)
// rebuilds them from the company's profile and orders, with that member's own token, when they
// are older than GOODS_TTL_MS. `backfilledAt` says the scan has read back over recent news for them.
import { goodsByCompany } from "./db.js";
import { companyGoods, goodsFingerprint } from "./goods.js";
import { log } from "./log.js";

export const GOODS_TTL_MS = 15 * 60_000;
const NONE = Object.freeze({ profile: null, items: [] });

/**
 * A company's goods ({ profile, items, updatedAt, backfilledAt }). `read` is { company, orders }
 * (the profile and GET /api/v1/trade-map's orders, read with the member's token), or null when
 * there is no token: the stored goods are then used as they are.
 */
export async function companyStock(companyId, read, now = Date.now()) {
  const ref = goodsByCompany.doc(companyId);
  const snap = await ref.get();
  const stored = snap.exists ? snap.data() : null;
  if (!read || (stored && now - Date.parse(stored.updatedAt) < GOODS_TTL_MS)) return stored ?? NONE;
  try {
    const [company, orders] = await Promise.all([read.company(), read.orders()]);
    if (!company) return stored ?? NONE;
    const goods = companyGoods(company, orders);
    const fingerprint = goodsFingerprint(goods);
    const updatedAt = new Date(now).toISOString();
    await ref.set({ ...goods, fingerprint, updatedAt }, { merge: true });
    if (fingerprint !== stored?.fingerprint) log("INFO", "goods.updated", { companyId, items: goods.items.length });
    return { ...stored, ...goods, fingerprint, updatedAt };
  } catch (e) {
    log("WARNING", "goods.refresh_failed", { companyId, error: String(e?.message || e) });
    return stored ?? NONE;
  }
}

/** `read` for companyStock from a GET-with-the-member's-token function ({ status, body }). */
export function goodsReader(get, company) {
  return {
    company,
    orders: async () => {
      const { status, body } = await get("/api/v1/trade-map");
      if (status !== 200) throw new Error(`trade map ${status}`);
      return body.data?.orders ?? [];
    },
  };
}
