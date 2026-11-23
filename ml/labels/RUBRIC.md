# Severity rubric (version 1, 22 Nov 2026)

One question per item: **how hard does this measure or news hit a Vietnamese wood-products and
furniture exporter?** The exporter makes plywood, sawn timber, flooring, pellets and furniture (HS 44
and 94), sells to the EU, US, UK, Canada, Japan, Korea and Australia, and buys some timber abroad
(e.g. Russia, Cameroon, US, New Zealand). Rate the measure itself, not any one company's orders:
that is added later per company.

Rate from what the item says (an article's headline and snippet; a measure's title, type, countries,
goods and dates). Don't look anything up. Severity is the size of the effect, **risk or opportunity
alike**: a big tariff cut in a main market is `high` too.

| Level | Meaning | Typical examples |
| --- | --- | --- |
| `high` | Blocks, or clearly changes the cost or paperwork of, shipping wood or furniture to one of those markets (or buying its timber), in force or taking effect within about 90 days | New or raised tariff or anti-dumping duty on wood or furniture into the US or EU; an import or export ban on timber; a final duty order; a due-diligence or certificate rule (EUDR) about to apply; a trade deal or preference opened or ended for these goods |
| `medium` | A real effect that is uncertain, partial, further off, or indirect | A proposed or consulted rule; a date more than ~90 days away; a postponement or a dilution debate; a measure on inputs (a log export ban by a supplier country, a freight or currency shock); a tariff on related goods; an investigation opened but not decided |
| `low` | Little or no effect on exporting wood or furniture | Grants, loans or tax relief to firms in another country; public procurement rules; measures on unrelated goods; company or market news; commentary with no measure in it |

Tie-breaks:
- **Wood or furniture not named** (only "goods from China", a horizontal tariff): a broad tariff in a
  main market is `medium`; anything narrower is `low`.
- **Market we don't sell to** (e.g. India, Brazil): at most `medium` for an input-supply effect,
  else `low`.
- **Removed or expired measure:** `low`, unless its removal is the news (then rate the removal).
- **GTA subsidies** (grants, loans, state aid) are `low` unless they are an export subsidy competing
  head-on with Vietnamese wood in a main market (then `medium`).
- **A duty on wood or furniture into one of our markets from other origins** (e.g. US duties on
  Chinese plywood, EU duties on Russian birch plywood): `medium` (competitors' prices change, and
  scrutiny of transshipment follows).
- **A broad tariff in a main market on a big competitor** (US tariffs on all Chinese goods): `medium`;
  on small exporters (Fiji, Libya): `low`.
- **An explainer, guide or debate about a rule that hits us** (EUDR guides, lobbying to dilute it):
  `medium`; EUDR news about other countries' farm goods (cocoa, coffee, rubber): `low`.
- **Commentary on tariffs already on our goods** with no new measure: `medium`.
- **Rate as of the item's own date**: a GTA measure from 2021 is rated as it was announced then.
- **Unsure between two levels:** pick the lower and write `unsure` in `note`.

Two examples each:
- `high`: "US issues final duty orders on hardwood plywood from China, Indonesia and Vietnam";
  "United States: 25% Section 232 tariff on upholstered furniture and kitchen cabinets from 14 Oct".
- `medium`: "EU Agribusiness Groups Seek Easing of Deforestation Rules"; "Gabon: log export ban
  extended to 2027".
- `low`: "US sawmill announces it will close in 2027"; "Germany: KfW loan to a furniture maker".

## Who rated
`rated.csv` column `rater`: `claude` (Claude Opus, by this rubric) or a person's initials. A person
checks a random 50 of Claude's ratings; agreement under 80% means the rubric gets fixed before any
model is trained on it.
