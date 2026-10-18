"""The offline chain pipeline: sources, code checks, writer → review → one revision, release,
and the reference seed loading a released industry."""

import json

import pytest
from sqlalchemy import select

import app.knowledge_graph as graph_data
from app.database.models import GraphEdge, GraphNode
from app.database.session import open_session
from app.knowledge_graph import build_chain
from app.knowledge_graph.build_chain import (
    WrittenLink,
    WrittenProduct,
    build_sources,
    check_links,
    check_products,
    known_hs_codes,
    quote_in_source,
)
from app.seed_reference_data import seed_reference_data

COCOA = {
    "key": "cocoa",
    "name": "Cocoa and chocolate",
    "eudrCommodity": "Cocoa",
    "hsPrefixes": ["1801", "1802", "1803", "1804", "1805", "1806"],
}


def product(key, codes, stage="first processing"):
    return {
        "key": key,
        "name": key.replace("-", " ").title(),
        "hs_codes": codes,
        "stage": stage,
        "aliases": [key.split("-")[-1]],
    }


def link(start, end, quote, source="hs-nomenclature", relation="used_to_make"):
    return {
        "from_key": start,
        "to_key": end,
        "relation": relation,
        "source": source,
        "quote": quote,
        "confidence": 0.9,
    }


WRITTEN = {
    "products": [
        product("cocoa-beans", ["1801"], "raw"),
        product("cocoa-shells", ["1802"], "by-product"),
        product("cocoa-paste", ["1803"]),
        product("cocoa-butter", ["1804"], "further processing"),
        product("cocoa-powder", ["1805"], "further processing"),
        product("chocolate", ["1806"], "final"),
        product(
            "cocoa-wine", ["2204"]
        ),  # an HS code outside the sources' lines is fine if it exists
        product("Bad Key", ["1806"]),
    ],
    "links": [
        link("cocoa-beans", "cocoa-paste", "1803: Cocoa paste, whether or not defatted"),
        link(
            "cocoa-beans",
            "cocoa-shells",
            "Cocoa shells, husks, skins and other cocoa waste",
            relation="by_product",
        ),
        link("cocoa-paste", "cocoa-butter", "Cocoa butter, fat and oil"),
        link("cocoa-paste", "cocoa-powder", "Cocoa powder, not containing added sugar"),
        # Made up: not in any source, so it fails the check and goes back to the writer.
        link("cocoa-butter", "chocolate", "chocolate is made from cocoa butter"),
        # The reviewer disagrees with this one.
        link("cocoa-shells", "chocolate", "Chocolate and other food preparations containing cocoa"),
    ],
    "materials": [
        {
            "key": "cocoa",
            "name": "Cocoa",
            "scientific_names": ["Theobroma cacao"],
            "aliases": ["cocoa", "cacao"],
        }
    ],
    "generic_terms": ["Cocoa", "cacao"],
}


@pytest.fixture
def released_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(build_chain, "DRAFTS_DIR", tmp_path / "drafts")
    monkeypatch.setattr(build_chain, "INDUSTRIES_DIR", tmp_path / "industries")
    monkeypatch.setattr(graph_data, "RELEASED_DIR", tmp_path / "industries")
    (tmp_path / "drafts").mkdir()
    return tmp_path


def test_sources_are_the_commodity_lines_and_its_hs_headings():
    sources = build_sources(COCOA)
    assert "1806: Chocolate and other food preparations containing cocoa" in sources["eudr-annex-i"]
    assert (
        "1803.10: Cocoa paste, whether or not defatted: Not defatted" in sources["hs-nomenclature"]
    )
    assert "0901" not in sources["hs-nomenclature"]


def test_quotes_must_be_the_sources_words():
    source = "1806: Chocolate and other food preparations containing cocoa\n1804.00: Cocoa butter, fat and oil"
    assert quote_in_source("Chocolate and other food preparations", source)
    assert quote_in_source("“chocolate  AND other food” … containing cocoa", source)
    assert not quote_in_source("chocolate is made from cocoa butter", source)
    assert not quote_in_source("cocoa … oil", source)  # parts too short to mean anything
    assert not quote_in_source("", source)


def test_code_checks_products_and_links():
    products, problems = check_products(
        [WrittenProduct.model_validate(p) for p in WRITTEN["products"]]
        + [
            WrittenProduct.model_validate(product("cocoa-beans", ["1801"])),
            WrittenProduct.model_validate(product("cocoa-dust", ["9999"])),
        ],
        known_hs_codes(),
    )
    assert [p.key for p in products][:6] == [
        "cocoa-beans",
        "cocoa-shells",
        "cocoa-paste",
        "cocoa-butter",
        "cocoa-powder",
        "chocolate",
    ]
    assert len(problems) == 3  # bad key, a repeat, an unknown HS code

    sources = build_sources(COCOA)
    keys = {p.key for p in products}
    links = [WrittenLink.model_validate(x) for x in WRITTEN["links"]] + [
        WrittenLink.model_validate(
            link("cocoa-paste", "cocoa-beans", "Cocoa beans, whole or broken")
        ),  # loop
        WrittenLink.model_validate(link("chocolate", "chocolate", "Chocolate and other food")),
        WrittenLink.model_validate(link("cocoa-beans", "nougat", "Chocolate and other food")),
        WrittenLink.model_validate(
            link("cocoa-beans", "cocoa-paste", "Cocoa paste, whether or not")
        ),  # repeat
    ]
    kept, failed = check_links(links, keys, sources)
    assert len(kept) == 5
    assert sorted(why for _, why in failed) == [
        (
            'its quote doesn\'t match hs-nomenclature: the part "chocolate is made from cocoa butter"'
            " is not in the source word for word"
        ),
        "links a product to itself",
        "names a product that isn't in the chain",
        "repeats another link",
        "would make a loop",
    ]


def test_the_pipeline_writes_reviews_revises_and_releases(fake_gemini, released_dirs, monkeypatch):
    def review(prompt, file):
        # Every link but "cocoa-shells → chocolate" is agreed.
        lines = [line for line in prompt.splitlines() if " → " in line and line[0].isdigit()]
        return {
            "reviews": [
                {
                    "index": int(line.split(".")[0]),
                    "verdict": "disagree"
                    if line.split(". ", 1)[1].startswith("cocoa-shells → chocolate")
                    else "agree",
                    "note": "Shells are waste, not a chocolate input."
                    if "cocoa-shells → chocolate" in line
                    else "Supported.",
                }
                for line in lines
            ]
        }

    fake_gemini.answers["chain_write"] = lambda prompt, file: WRITTEN
    fake_gemini.answers["chain_review"] = review
    fake_gemini.answers["chain_revise"] = lambda prompt, file: {
        "links": [
            link(
                "cocoa-butter",
                "chocolate",
                "Chocolate and other food preparations containing cocoa",
            )
        ]
    }
    draft = build_chain.build_draft(COCOA)
    tasks = [call["task"] for call in fake_gemini.calls]
    assert tasks == ["chain_write", "chain_review", "chain_revise", "chain_review"]
    assert '<source key="eudr-annex-i"' in fake_gemini.calls[0]["prompt"]

    industry = draft["industry"]
    pairs = [(x["from"], x["to"]) for x in industry["links"]]
    assert pairs == [
        ("cocoa-beans", "cocoa-paste"),
        ("cocoa-beans", "cocoa-shells"),
        ("cocoa-paste", "cocoa-butter"),
        ("cocoa-paste", "cocoa-powder"),
        ("cocoa-butter", "chocolate"),  # fixed by the writer, then agreed
    ]
    check = industry["links"][0]["aiCheck"]
    assert (check["verdict"], check["by"]) == ("agree", "gemini-3.5-flash")
    dropped = draft["forAPerson"]["droppedLinks"]
    assert [(x["from"], x["to"]) for x in dropped] == [("cocoa-shells", "chocolate")]
    assert "reviewer: disagree" in dropped[0]["why"]
    assert len(draft["forAPerson"]["productProblems"]) == 1
    # Only products the kept links use; aliases lower-case.
    assert [p["key"] for p in industry["products"]] == [
        "cocoa-beans",
        "cocoa-shells",
        "cocoa-paste",
        "cocoa-butter",
        "cocoa-powder",
        "chocolate",
    ]
    assert industry["genericTerms"] == {"cocoa": [], "cacao": []}

    (released_dirs / "drafts" / "cocoa.json").write_text(json.dumps(draft), encoding="utf-8")
    target = build_chain.release("cocoa")
    assert json.loads(target.read_text(encoding="utf-8"))["industry"]["key"] == "cocoa"

    # The reference seed loads it next to the hand-written wood chain.
    with open_session() as db:
        seed_reference_data(db)
        node = db.get(GraphNode, "cocoa.chocolate")
        cocoa = db.get(GraphNode, "commodity.cocoa")
        edges = db.scalars(select(GraphEdge).where(GraphEdge.from_key.like("cocoa.%"))).all()
        material = db.get(GraphNode, "material.cocoa")
    assert (node.name, node.hs_prefixes) == ("Chocolate", ["1806"])
    assert cocoa.industry == "cocoa" and "cacao" in cocoa.aliases
    assert len(edges) == 5
    assert edges[0].ai_check["by"] == "gemini-3.5-flash"
    assert material.industry == "cocoa" and "theobroma cacao" in material.aliases


def test_documents_are_sources_and_a_rebuild_keeps_product_keys_and_links(fake_gemini, monkeypatch):
    page = b"<html><body><p>(a) Cocoa butter designates the fat obtained from cocoa beans.</p></body></html>"
    monkeypatch.setattr(build_chain, "fetch_document", lambda document: page)
    industry = COCOA | {
        "key": "wood",  # an industry the seed already has: its product keys are offered
        "documents": [
            {
                "key": "eu-cocoa-chocolate-directive",
                "title": "Directive 2000/36/EC, Annex I",
                "url": "https://eur-lex.europa.eu/eli/dir/2000/36/",
                "contentType": "text/html",
            }
        ],
    }
    sources = build_sources(industry)
    assert (
        "Cocoa butter designates the fat obtained from cocoa beans"
        in sources["eu-cocoa-chocolate-directive"]
    )

    written = {
        **WRITTEN,
        "links": [
            link(
                "cocoa-beans",
                "cocoa-butter",
                "Cocoa butter designates the fat obtained from cocoa beans",
                source="eu-cocoa-chocolate-directive",
            )
            | {"secondary": True}
        ],
    }
    fake_gemini.answers["chain_write"] = lambda prompt, file: written
    fake_gemini.answers["chain_review"] = lambda prompt, file: {
        "reviews": [{"index": 0, "verdict": "agree", "note": "The directive says so."}]
    }
    draft = build_chain.build_draft(industry)
    prompt = fake_gemini.calls[0]["prompt"]
    assert 'title="Directive 2000/36/EC, Annex I"' in prompt
    assert "- roundwood: Logs (wood in the rough) (HS 4403)" in prompt  # existing keys offered
    assert "- plywood → wooden-furniture (used_to_make)" in prompt  # links to keep, if sourced
    [kept] = draft["industry"]["links"]
    assert (kept["source"], kept["secondary"]) == ("eu-cocoa-chocolate-directive", True)
    assert draft["sources"] == {
        "eu-cocoa-chocolate-directive": {
            "title": "Directive 2000/36/EC, Annex I",
            "url": "https://eur-lex.europa.eu/eli/dir/2000/36/",
        }
    }
    assert "roundwood" in draft["forAPerson"]["keysNoLongerUsed"]
    assert "roundwood → sawnwood" in draft["forAPerson"]["linksNoLongerSourced"]


def test_a_released_chain_keeps_the_hand_written_vocabulary(released_dirs):
    (released_dirs / "industries").mkdir()
    (released_dirs / "industries" / "wood.json").write_text(
        json.dumps(
            {
                "industry": {
                    "key": "wood",
                    "name": "Wood (pipeline)",
                    "eudrCommodity": "Wood",
                    "genericTerms": {"lumber": []},
                    "products": [
                        {
                            "key": "roundwood",
                            "name": "Logs",
                            "hsCodes": ["4403"],
                            "stage": "raw",
                            "aliases": [],
                        }
                    ],
                    "links": [],
                },
                "materials": [],
                "sources": {"fao-jfsq": {"title": "FAO", "url": "https://fao.org/x.pdf"}},
            }
        ),
        encoding="utf-8",
    )
    chain = graph_data.load_chain()
    [wood] = [i for i in chain["industries"] if i["key"] == "wood"]
    # Products and links from the pipeline; name and broad words as written by hand.
    assert [p["name"] for p in wood["products"]] == ["Logs"]
    assert wood["name"] == "Wood and wooden furniture"
    assert "hardwood" in wood["genericTerms"] and "lumber" not in wood["genericTerms"]
    assert chain["sources"]["fao-jfsq"]["url"] == "https://fao.org/x.pdf"


def test_eu_eight_digit_codes_keep_their_hs_part():
    [kept], problems = check_products(
        [WrittenProduct.model_validate(product("palm-nuts", ["1207 10 00", "1207.10"]))],
        known_hs_codes(),
    )
    assert (kept.hs_codes, problems) == (["1207.10"], [])


def test_an_api_answer_is_read_from_its_text_field(monkeypatch):
    ruling = {
        "rulingNumber": "E83110",
        "text": "<p>The components will be glued together to make glulam beams.</p>",
    }
    monkeypatch.setattr(build_chain, "fetch_document", lambda document: json.dumps(ruling).encode())
    industry = COCOA | {
        "documents": [
            {
                "key": "cbp-ruling-e83110",
                "title": "CBP ruling E83110",
                "url": "https://rulings.cbp.gov/ruling/E83110",
                "jsonField": "text",
                "contentType": "text/html",
            }
        ]
    }
    source = build_sources(industry)["cbp-ruling-e83110"]
    assert "glued together to make glulam beams" in source
    assert "rulingNumber" not in source
