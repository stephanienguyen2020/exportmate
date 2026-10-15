// A fixed check after Gemini's assessment. The prompt says goods the company doesn't stock are
// not relevant, but the model still flags some articles about them when they mention a rule
// that also covers the company's goods (e.g. "Ghana's cocoa faces EU deforestation test" for a
// wood exporter). An article that names one of the stock's `otherGoods` and none of its
// `goodsTerms` (seed/inventory.js STOCK_PROFILE) is dropped whatever the model said. Articles
// about trade measures that name no goods are left to the model, and so is every article when
// the profile lists no other goods.
import { STOCK_PROFILE } from "./seed/inventory.js";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole words or phrases, plurals included.
const wordsPattern = (words) => (words?.length ? new RegExp(`\\b(${words.map(escape).join("|")})(s|es)?\\b`, "i") : null);
const patterns = new WeakMap();
function patternsOf(profile) {
  if (!patterns.has(profile)) patterns.set(profile, { own: wordsPattern(profile.goodsTerms), other: wordsPattern(profile.otherGoods) });
  return patterns.get(profile);
}

/** False when an article is about goods the stock doesn't hold and not about its own goods. */
export function aboutStockedGoods({ title = "", snippet = "" }, profile = STOCK_PROFILE) {
  const { own, other } = patternsOf(profile);
  const text = `${title} ${snippet}`;
  return !other || Boolean(own?.test(text)) || !other.test(text);
}

/**
 * The scan's verdict on one article, from Gemini's assessment `r` of it (article number `n`
 * in its batch). SKUs the model named that are not in stock are dropped; an article is
 * relevant only if the model said so, at least one real SKU is affected, it is not a repeat
 * of another article in the batch and it passes aboutStockedGoods. Shared by the scan and its eval.
 */
export function decide(article, r, n, bySku, profile = STOCK_PROFILE) {
  const affected = (r.affected || [])
    .filter((x) => bySku.has(x.sku))
    .map((x) => {
      const it = bySku.get(x.sku);
      // A company's goods have no quantity or cost, so no stock value.
      const value = Math.round(it.qtyOnHand * it.unitCostUsd);
      return { sku: x.sku, name: it.name, reason: x.reason, ...(Number.isFinite(value) ? { stockValueUsd: value } : {}) };
    });
  const duplicate = Number.isInteger(r.sameAs) && r.sameAs !== n;
  const otherCommodity = Boolean(r.relevant) && !aboutStockedGoods(article, profile);
  return { relevant: Boolean(r.relevant && affected.length && !duplicate && !otherCommodity), affected, duplicate, otherCommodity };
}
