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
