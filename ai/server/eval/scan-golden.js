// Labeled articles for the news scan's relevance judgment (scan.js assess + relevance.js
// decide). The articles are written for this eval, not real news: each one isolates a
// link the scan should find (HS code, market, timber origin, missing geolocation) or a
// trap it should ignore (other commodities, exchange rates, fuel, measures on other goods
// from Vietnam). Expected SKUs are computed from the stock the scan will see and dates
// from today, so the set stays right when the seed or the calendar changes.
//
// Ratchet: when the scan raises a false alarm or misses an article, add it here first,
// then fix the scan's RULES or relevance.js until it passes.

// expect fields:
//   relevant    whether the scan should raise an alert
//   skus        SKUs the alert must name             allowed    SKUs it may also name
//   severity    acceptable severities                direction  acceptable directions
// Cases sharing an `event` report the same news: exactly one of them should be kept.
export function scanCases(items, { today = new Date() } = {}) {
  const day = (offset) => new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const skus = (pred) => items.filter(pred).map((i) => i.sku);
  const sells = (market) => (i) => i.markets.includes(market);
  const published = day(-1);
  const article = (title, snippet) => ({ title, snippet, publisher: "Eval fixture", publishedAt: published });

  const usPlywood = skus((i) => i.hsCode.startsWith("4412") && sells("US")(i));
  const usCabinets = skus((i) => i.category === "Kitchen cabinets & vanities" && sells("US")(i));
  const euNoGeo = skus((i) => sells("EU")(i) && !i.geolocationOnFile);
  const fromRussia = skus((i) => i.timberOrigin === "Russia");
  const usSeating = skus((i) => i.category === "Upholstered seating" && sells("US")(i));

  return [
    // Duplicate reports of one event come first so they share a batch, as they would in a scan.
    {
      id: "eudr-date",
      category: "trade-measure",
      event: "eudr-date",
      article: article(
        "EU confirms deforestation regulation start date; plot geolocation required for timber and furniture",
        `Operators placing wood products, plywood and wooden furniture on the EU market must file due diligence statements with plot geolocation from ${day(75)}. Goods without geolocation will be refused at customs.`,
      ),
      expect: { relevant: true, skus: euNoGeo, allowed: skus(sells("EU")), severity: ["high", "medium"], direction: ["risk"] },
    },
    {
      id: "eudr-date-repeat",
      category: "duplicate",
      event: "eudr-date",
      article: article(
        "EUDR deadline set: what furniture exporters to Europe need before customs checks begin",
        `The European Commission has confirmed that the EU Deforestation Regulation applies from ${day(75)}. Exporters of wood furniture and timber must provide geolocation of the forest plots their wood came from.`,
      ),
      expect: { relevant: true, skus: euNoGeo, allowed: skus(sells("EU")), severity: ["high", "medium"], direction: ["risk"] },
    },
    {
      id: "us-plywood-antidumping",
      category: "trade-measure",
      article: article(
        "US sets preliminary anti-dumping duties on hardwood and decorative plywood from Vietnam",
        `The Commerce Department announced preliminary duties of 12% to 110% on hardwood and decorative plywood (HS 4412) imported from Vietnam. Cash deposits will be collected from ${day(30)}.`,
      ),
      expect: { relevant: true, skus: usPlywood, allowed: [...usPlywood, ...skus((i) => /plywood/i.test(i.species) && sells("US")(i))], severity: ["high"], direction: ["risk"] },
    },
    {
      id: "copper-232",
      category: "off-topic",
      article: article(
        "US raises Section 232 tariffs on copper imports to 50%",
        "The new rate applies to refined copper and semi-finished copper products from all countries, including Vietnam, starting next month.",
      ),
      expect: { relevant: false },
    },
    {
      id: "us-232-cabinets",
      category: "trade-measure",
      article: article(
        "US raises Section 232 tariff on kitchen cabinets and vanities to 50%",
        `Imports of wooden kitchen cabinets and bathroom vanities will face a 50% tariff from ${day(60)}, up from 25%. No exemptions were announced for Vietnam.`,
      ),
      expect: { relevant: true, skus: usCabinets, allowed: usCabinets, severity: ["high"], direction: ["risk"] },
    },
    {
      id: "cocoa-eudr",
      category: "off-topic",
      article: article(
        "Ghana's cocoa farmers race to map farms before EU deforestation rules",
        "Cooperatives say they need help collecting geolocation data for smallholder cocoa plots to keep supplying European chocolate makers.",
      ),
      expect: { relevant: false },
    },
    {
      id: "jp-pellet-certification",
      category: "trade-measure",
      article: article(
        "Japan tightens sustainability proof for imported wood pellets used in biomass power",
        `Power plants claiming feed-in tariff support must show third-party sustainability certification for every pellet shipment from ${day(170)}.`,
      ),
      expect: { relevant: true, skus: skus((i) => i.category === "Wood pellets" && sells("JP")(i)), allowed: skus((i) => i.category === "Wood pellets" && sells("JP")(i)), severity: ["medium", "low"] },
    },
    {
      id: "vnd-exchange-rate",
      category: "off-topic",
      article: article(
        "Vietnam dong slides to record low against the US dollar",
        "The State Bank of Vietnam widened the trading band as exporters converted fewer dollar receipts.",
      ),
      expect: { relevant: false },
    },
    {
      id: "kr-pellet-opportunity",
      category: "market",
      article: article(
        "South Korea raises renewable credit weighting for imported wood pellets",
        "Utilities will earn more renewable energy certificates per tonne of certified wood pellets burned, which traders expect to lift Korean demand next year.",
      ),
      expect: { relevant: true, skus: skus((i) => i.category === "Wood pellets" && sells("KR")(i)), allowed: skus((i) => i.category === "Wood pellets" && sells("KR")(i)), direction: ["opportunity"] },
    },
    {
      id: "bunker-fuel",
      category: "off-topic",
      article: article(
        "Bunker fuel prices rise 8% as Red Sea diversions continue",
        "Shipping lines on Asia-Europe routes are adding fuel surcharges to cover longer voyages around the Cape of Good Hope.",
      ),
      expect: { relevant: false },
    },
    {
      id: "russia-birch-sanctions",
      category: "supply",
      article: article(
        "US and EU widen sanctions to Russian birch veneer routed through third countries",
        "Products made with Russian-origin birch veneer or birch plywood will be barred even when finished in another country, including Vietnam.",
      ),
      expect: { relevant: true, skus: fromRussia, allowed: fromRussia, severity: ["high", "medium"], direction: ["risk"] },
    },
    {
      id: "rubber-tyres",
      category: "off-topic",
      article: article(
        "Vietnam's natural rubber exports hit record as tyre demand rises",
        "Shipments of natural rubber to China rose 18% in the first nine months as tyre makers rebuilt stocks.",
      ),
      expect: { relevant: false },
    },
    {
      id: "cameroon-sapele-suspension",
      category: "supply",
      article: article(
        "Cameroon suspends sawn sapele exports pending legality audit",
        "The forestry ministry halted export permits for sawn sapele for at least three months while it audits concession records.",
      ),
      expect: { relevant: true, skus: skus((i) => i.timberOrigin === "Cameroon"), allowed: skus((i) => i.timberOrigin === "Cameroon"), severity: ["high", "medium"], direction: ["risk"] },
    },
    {
      id: "shrimp-antidumping",
      category: "off-topic",
      article: article(
        "US sets anti-dumping duties on frozen shrimp from Vietnam",
        "Seafood exporters face duties of up to 25% after the Commerce Department's final review.",
      ),
      expect: { relevant: false },
      note: "A trade measure on Vietnam and the US, but on goods the company doesn't sell.",
    },
    {
      id: "upholstered-tariff-talk",
      category: "vague",
      article: article(
        "US officials weigh tariffs on upholstered furniture imports, people familiar say",
        "No decision is expected before next year, and the scope and rate have not been set.",
      ),
      expect: { relevant: true, skus: usSeating, allowed: skus((i) => i.hsCode.startsWith("94") && sells("US")(i)), severity: ["medium", "low"], direction: ["watch"] },
    },
    {
      id: "vn-gdp",
      category: "off-topic",
      article: article(
        "Vietnam's economy grows 7.1% in third quarter on manufacturing exports",
        "Electronics and textiles led export growth, the statistics office said.",
      ),
      expect: { relevant: false },
    },
    {
      id: "uk-laos-due-diligence",
      category: "trade-measure",
      article: article(
        "UK adds extra due-diligence checks for timber products from Laos",
        "Importers must provide concession-level legality evidence for any wood product containing Laotian timber, including outdoor furniture.",
      ),
      expect: { relevant: true, skus: skus((i) => i.timberOrigin === "Laos" && sells("UK")(i)), allowed: skus(sells("UK")), direction: ["risk"] },
    },
    {
      id: "industrial-land",
      category: "off-topic",
      article: article(
        "Binh Duong industrial land rents climb 12% as factories relocate from China",
        "Developers report occupancy above 90% across the province's main industrial parks.",
      ),
      expect: { relevant: false },
    },
    {
      id: "china-us-hardwood-retaliation",
      category: "supply",
      article: article(
        "China's tariffs on US hardwood lumber push oak and ash prices down for other Asian buyers",
        "US sawmills are discounting white oak and ash lumber to buyers in Vietnam and Malaysia after losing Chinese orders.",
      ),
      expect: {
        relevant: true,
        skus: skus((i) => i.category === "Imported sawn timber" && i.timberOrigin === "United States"),
        allowed: skus((i) => i.timberOrigin === "United States"),
        direction: ["opportunity", "watch"],
      },
    },
  ];
}
