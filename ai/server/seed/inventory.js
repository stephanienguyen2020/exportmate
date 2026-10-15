// Synthetic stock for a fictional Vietnamese wood-products and furniture exporter
// (STOCK_PROFILE). Deterministic: the same seed always yields the same items.
// The mix is chosen so real news moves it: EUDR (EU deforestation rules), US
// Section 232 timber/furniture tariffs, US anti-dumping on hardwood plywood,
// imported raw timber and certification schemes (FSC, VNTLAS, FLEGT).
// Nothing outside this file knows the industry: the scan, the assistant and News watch read
// the items' own categories, materials and origins, and STOCK_PROFILE for the rest.

// Whose stock this is and how news talks about it. `goodsTerms` are the words news uses for
// these goods; `otherGoods` are goods that rules covering them also cover, which this company
// doesn't stock (relevance.js drops an article that names only those). Singular words; plurals
// match too.
export const STOCK_PROFILE = {
  company: "Binh Duong Wood Co.",
  about: "a fictional Vietnamese wood-products and furniture manufacturer and exporter",
  goodsTerms: [
    "wood", "wooden", "woodworking", "timber", "lumber", "plywood", "veneer", "sawn", "sawmill",
    "hardwood", "softwood", "furniture", "cabinet", "flooring", "mdf", "particleboard", "pellet",
    "forest products", "rubberwood", "acacia", "oak", "birch", "eucalyptus", "teak", "walnut",
  ],
  otherGoods: ["cocoa", "coffee", "cattle", "beef", "soy", "soya", "soybean", "palm oil", "rubber", "leather", "chocolate", "critical minerals"],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// materials[i] and origins[i] describe names[i]; shorter arrays repeat their values.
const FAMILIES = [
  {
    prefix: "PLY",
    category: "Plywood",
    hsCode: "4412.33",
    unit: "m3",
    names: ["Acacia plywood 18 mm", "Acacia plywood 12 mm", "Eucalyptus plywood 15 mm", "Film-faced plywood 18 mm"],
    materials: ["Acacia mangium", "Acacia mangium", "Eucalyptus urophylla", "Eucalyptus urophylla"],
    origins: ["Vietnam"],
    markets: [["EU"], ["US"], ["EU", "UK"], ["US", "KR"]],
    cost: [380, 520],
    qty: [80, 600],
  },
  {
    prefix: "HWP",
    category: "Hardwood plywood",
    hsCode: "4412.31",
    unit: "m3",
    names: ["Birch-faced plywood 12 mm", "Okoume-faced plywood 9 mm", "Decorative oak veneer plywood"],
    materials: ["Birch veneer", "Okoume veneer", "Oak veneer"],
    origins: ["Russia", "Gabon", "United States"],
    markets: [["US"], ["US", "CA"], ["EU"]],
    cost: [610, 880],
    qty: [40, 300],
  },
  {
    prefix: "FUR",
    category: "Wooden furniture",
    hsCode: "9403.60",
    unit: "pcs",
    names: ["Rubberwood dining table", "Acacia coffee table", "Oak sideboard", "Ash bookshelf", "Walnut bed frame", "Rubberwood kids desk"],
    materials: ["Rubberwood", "Acacia", "White oak", "European ash", "Black walnut", "Rubberwood"],
    origins: ["Vietnam", "Vietnam", "United States", "France", "United States", "Vietnam"],
    markets: [["US"], ["US", "CA"], ["EU"], ["JP"], ["UK", "EU"], ["AU"]],
    cost: [45, 320],
    qty: [200, 4000],
  },
  {
    prefix: "UPH",
    category: "Upholstered seating",
    hsCode: "9401.61",
    unit: "pcs",
    names: ["Upholstered dining chair", "Fabric armchair", "Two-seat sofa frame"],
    materials: ["Rubberwood", "Pine", "Rubberwood"],
    origins: ["Vietnam", "New Zealand", "Vietnam"],
    markets: [["US"], ["US"], ["EU", "UK"]],
    cost: [38, 210],
    qty: [300, 5000],
  },
  {
    prefix: "CAB",
    category: "Kitchen cabinets & vanities",
    hsCode: "9403.40",
    unit: "sets",
    names: ["Shaker kitchen cabinet set", "Bathroom vanity 30 in", "Wall cabinet 36 in"],
    materials: ["Rubberwood", "Birch plywood", "MDF + oak veneer"],
    origins: ["Vietnam", "Russia"],
    markets: [["US"], ["US", "CA"], ["AU"]],
    cost: [120, 640],
    qty: [100, 1800],
  },
  {
    prefix: "OUT",
    category: "Outdoor furniture",
    hsCode: "9401.69",
    unit: "pcs",
    names: ["FSC acacia garden chair", "Eucalyptus folding table", "Teak lounge bed"],
    materials: ["Acacia", "Eucalyptus", "Plantation teak"],
    origins: ["Vietnam", "Laos", "Indonesia"],
    markets: [["EU"], ["EU", "UK"], ["US"], ["AU"]],
    cost: [28, 260],
    qty: [500, 6000],
  },
  {
    prefix: "FLR",
    category: "Engineered flooring",
    hsCode: "4418.75",
    unit: "m2",
    names: ["Engineered oak flooring 14 mm", "Acacia click flooring 12 mm"],
    materials: ["European oak", "Acacia"],
    origins: ["France", "Vietnam"],
    markets: [["US"], ["EU"], ["JP", "KR"]],
    cost: [18, 46],
    qty: [3000, 40000],
  },
  {
    prefix: "PEL",
    category: "Wood pellets",
    hsCode: "4401.31",
    unit: "tonnes",
    names: ["Acacia wood pellets ENplus A1", "Sawdust pellets industrial"],
    materials: ["Acacia sawmill residue", "Mixed hardwood residue"],
    origins: ["Vietnam"],
    markets: [["KR"], ["JP"], ["KR", "JP"]],
    cost: [110, 160],
    qty: [500, 12000],
  },
  {
    prefix: "RAW",
    category: "Imported sawn timber",
    hsCode: "4407.91",
    unit: "m3",
    names: ["US white oak sawn 4/4", "US ash sawn 5/4", "NZ radiata pine sawn", "Brazil eucalyptus sawn", "Cameroon sapele sawn"],
    materials: ["White oak", "White ash", "Radiata pine", "Eucalyptus grandis", "Sapele"],
    origins: ["United States", "United States", "New Zealand", "Brazil", "Cameroon"],
    markets: [["Raw material"]],
    cost: [260, 940],
    qty: [50, 900],
  },
];

const SUPPLIERS = {
  Vietnam: ["Binh Phu Wood", "An Cuong Wood", "Mekong Timber", "Quy Nhon Forest Products"],
  Russia: ["Sibir Veneer Trading"],
  Gabon: ["Libreville Okoume Export"],
  "United States": ["Appalachian Hardwood Co.", "Midwest Lumber Export"],
  France: ["Bois de Bourgogne SA"],
  "New Zealand": ["Kiwi Pine Exports"],
  Laos: ["Savannakhet Timber"],
  Indonesia: ["Java Teak Lestari"],
  Brazil: ["Paraná Florestal"],
  Cameroon: ["Douala Sawmills"],
};

const CERTS = [["FSC 100%"], ["FSC Mix"], ["VNTLAS"], ["FSC Mix", "VNTLAS"], ["PEFC"], []];
const WAREHOUSES = ["Binh Duong WH-1", "Binh Duong WH-2", "Cat Lai port bonded", "Quy Nhon WH"];

export function generateInventory(seed = 20261010) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = ([lo, hi]) => lo + r() * (hi - lo);
  const items = [];
  for (const f of FAMILIES) {
    f.names.forEach((name, i) => {
      const material = f.materials[i % f.materials.length];
      const origin = f.origins[i % f.origins.length];
      const certifications = pick(CERTS);
      items.push({
        sku: `${f.prefix}-${String(101 + i)}`,
        name,
        category: f.category,
        hsCode: f.hsCode,
        material,
        // The country the main material comes from.
        materialOrigin: origin,
        supplier: pick(SUPPLIERS[origin]),
        markets: f.markets[i % f.markets.length],
        certifications,
        // Origin traced to where the material was produced (here, plot geolocation for EU rules).
        originTraced: origin === "Vietnam" ? r() > 0.35 : r() > 0.6,
        warehouse: pick(WAREHOUSES),
        unit: f.unit,
        qtyOnHand: Math.round(between(f.qty)),
        unitCostUsd: Math.round(between(f.cost) * 100) / 100,
        reorderPoint: Math.round(between(f.qty) * 0.25),
        lastReceived: new Date(Date.UTC(2026, 8, 1 + Math.floor(r() * 38)))
          .toISOString()
          .slice(0, 10),
      });
    });
  }
  return items;
}

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const DEFAULT_SOURCES = [
  { id: "ttj", name: "Timber Trades Journal", url: "https://www.ttjonline.com/feed/", kind: "Industry" },
  { id: "vnexpress-business", name: "VnExpress International · Business", url: "https://e.vnexpress.net/rss/business.rss", kind: "Vietnam" },
  { id: "ec-press", name: "European Commission press corner", url: "https://ec.europa.eu/commission/presscorner/api/rss?language=en", kind: "Official" },
  { id: "gn-eudr", name: "Google News · EUDR", url: gnews("EUDR deforestation regulation when:7d"), kind: "News search" },
  { id: "gn-232", name: "Google News · Section 232 timber & furniture tariffs", url: gnews("Section 232 timber lumber furniture cabinets tariff when:30d"), kind: "News search" },
  { id: "gn-plywood", name: "Google News · Plywood trade cases", url: gnews("plywood anti-dumping OR countervailing OR tariff when:30d"), kind: "News search" },
  { id: "gn-vn-wood", name: "Google News · Vietnam wood & furniture exports", url: gnews("Vietnam wood furniture exports tariff when:7d"), kind: "News search" },
];
