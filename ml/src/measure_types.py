"""The one closed list of measure types, shared by GTA measures and articles.

GTA's intervention types map onto it here; for articles, Gemini picks from the same list
(src/extract.py). GTA does not record technical rules (due diligence, certificates, labels,
phytosanitary checks), so `document_rule` only comes from articles.
"""

MEASURE_TYPES = {
    "tariff": "a new or changed import tariff, import tax or charge, or minimum import price",
    "trade_defence": "anti-dumping, anti-subsidy (countervailing), safeguard or anti-circumvention duty",
    "import_ban": "a ban on importing the goods",
    "import_quota": "an import quota or tariff-rate quota",
    "import_licence": "an import licence, monitoring, inspection or port restriction",
    "document_rule": "a document, certificate, due diligence, traceability, labelling or phytosanitary rule",
    "export_ban": "a ban on exporting the goods (for example a log export ban)",
    "export_restriction": "an export licence, export tax, export quota or export price rule",
    "export_support": "export finance, export credit, export subsidy or another export incentive",
    "subsidy": "a grant, loan, tax relief or other state aid to firms",
    "procurement": "a public procurement preference or localisation rule",
    "investment": "a foreign investment, capital, payment or local content rule",
    "trade_deal": "a trade agreement or tariff preference opened, changed, suspended or ended",
    "other": "anything else, or no specific measure",
}

GTA_TYPE = {
    "Import tariff": "tariff",
    "Internal taxation of imports": "tariff",
    "Other import charges": "tariff",
    "Minimum import price (tariff-based)": "tariff",
    "Anti-dumping": "trade_defence",
    "Anti-subsidy": "trade_defence",
    "Safeguard": "trade_defence",
    "Anti-circumvention": "trade_defence",
    "Import ban": "import_ban",
    "Import tariff quota": "import_quota",
    "Import quota": "import_quota",
    "Import licensing requirement": "import_licence",
    "Import monitoring": "import_licence",
    "Port restriction": "import_licence",
    "Import-related non-tariff measure, nes": "import_licence",
    "Export ban": "export_ban",
    "Export licensing requirement": "export_restriction",
    "Export tax": "export_restriction",
    "Export quota": "export_restriction",
    "Export tariff quota": "export_restriction",
    "Export price benchmark": "export_restriction",
    "Export-related non-tariff measure, nes": "export_restriction",
    "Local supply requirement for exports": "export_restriction",
    "Trade finance": "export_support",
    "Other export incentive": "export_support",
    "Tax-based export incentive": "export_support",
    "Financial assistance in foreign market": "export_support",
    "Export subsidy": "export_support",
}

GTA_CHAPTER_TYPE = {
    "L: Subsidies (excl. export subsidies)": "subsidy",
    "M: Government procurement restrictions": "procurement",
    "FDI measures": "investment",
    "Capital control measures": "investment",
    "G: Finance measures": "investment",
    "I: Trade-related investment measures": "investment",
}


def gta_measure_type(intervention_type: str, mast_chapter: str) -> str:
    return GTA_TYPE.get(intervention_type) or GTA_CHAPTER_TYPE.get(mast_chapter.strip()) or "other"
