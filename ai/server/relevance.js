// A fixed check after Gemini's assessment. The prompt says other commodities are not
// relevant, but the model still flags some of them when they mention EU deforestation rules
// (e.g. "Ghana's cocoa faces EU deforestation test"). An article that names another
// commodity and never mentions wood goods is dropped whatever the model said. Articles about
// trade measures that name no commodity at all are left to the model.
const WOOD =
  /\b(wood|wooden|woodworking|timber|lumber|plywood|veneers?|sawn|sawmills?|hardwoods?|softwoods?|furniture|cabinets?|flooring|mdf|particleboard|pellets?|forest products|rubberwood|acacia|oak|birch|eucalyptus|teak|walnut)\b/i;
const OTHER_COMMODITY = /\b(cocoa|coffee|cattle|beef|soy|soya|soybeans?|palm oil|rubber|leather|chocolate)\b/i;

/** False when an article is about another commodity and not about wood goods. */
export function aboutWoodGoods({ title = "", snippet = "" }) {
  const text = `${title} ${snippet}`;
  return WOOD.test(text) || !OTHER_COMMODITY.test(text);
}

/**
 * The scan's verdict on one article, from Gemini's assessment `r` of it (article number `n`
 * in its batch). SKUs the model named that are not in stock are dropped; an article is
 * relevant only if the model said so, at least one real SKU is affected, it is not a repeat
 * of another article in the batch and it passes aboutWoodGoods. Shared by the scan and its eval.
 */
export function decide(article, r, n, bySku) {
  const affected = (r.affected || [])
    .filter((x) => bySku.has(x.sku))
    .map((x) => {
      const it = bySku.get(x.sku);
      return { sku: x.sku, name: it.name, reason: x.reason, stockValueUsd: Math.round(it.qtyOnHand * it.unitCostUsd) };
    });
  const duplicate = Number.isInteger(r.sameAs) && r.sameAs !== n;
  const otherCommodity = Boolean(r.relevant) && !aboutWoodGoods(article);
  return { relevant: Boolean(r.relevant && affected.length && !duplicate && !otherCommodity), affected, duplicate, otherCommodity };
}
