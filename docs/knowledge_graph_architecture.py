"""Knowledge graph and GraphRAG architecture (the finished system), as an Excalidraw file.

One swimlane per flow, from what a user or an admin sees on the website to the data on the
right: one block per Postgres table, with an arrow from each module to the tables it uses, and
Neo4j as the graph read model (its node types and relationships, each from the table it is
copied from). Services are drawn with their logos (docs/architecture-icons/: the Google Cloud
icon set and Simple Icons); a small logo on a step shows where it runs. The news severity model
and its training are a separate diagram. Edit the lists below and run:

    python3 docs/knowledge_graph_architecture.py docs/knowledge-graph-architecture.excalidraw

Open the result at https://excalidraw.com (File > Open) or with the VS Code Excalidraw extension.
What is built today and what each part does: backend/app/knowledge_graph/README.md.
"""

import base64
import json
import random
import sys
from pathlib import Path

ICONS = Path(__file__).resolve().parent / "architecture-icons"
# Simple Icons are one colour: each gets its brand colour.
BRAND_COLORS = {
    "neo4j": "#4581C3",
    "postgresql": "#4169E1",
    "vercel": "#000000",
    "react": "#61DAFB",
    "firebase": "#DD2C00",
    "googlegemini": "#8E75B2",
}

# Blue: the website. Green: AI agents and Gemini steps. Yellow: backend code. Purple: data and
# the graph.
FILL = {
    "code": ("#fff9db", "#7a5c00"),
    "agent": ("#ebfbee", "#2b8a3e"),
    "web": ("#e7f5ff", "#1864ab"),
    "data": ("#f3f0ff", "#5f3dc4"),
    "table": ("#e5dbff", "#5f3dc4"),
    "node": ("#e5dbff", "#5f3dc4"),
    "people": ("transparent", "#1e1e1e"),
}
ARROW_COLOR = "#1e1e1e"
FRAME_COLOR = {"cloud": "#1971c2", "lane": "#495057", "web": "#1864ab", "db": "#5f3dc4"}
NEO4J = "Neo4j AuraDB, graph read model"
CHAIN_TABLES = "Material chain"
POSTGRES = "Cloud SQL, Postgres"

# id: (icon, x, y, label, label side)  the icon is 56px; its label goes below, above or right.
SERVICES = {
    "scheduler": ("gcp-cloud_scheduler", 470, 82, "Scheduler\ndaily", "below"),
    "gemini": ("googlegemini", 900, 82, "Gemini", "right"),
    "alerts": ("gcp-firestore", 1200, 82, "Alerts (Firestore)\naffected goods,\nmentions", "right"),
    "monthly": ("gcp-cloud_scheduler", 470, 482, "Monthly, or\nan admin asks", "below"),
    "storage": ("gcp-cloud_storage", 800, 482, "Official texts", "below"),
    "memory": ("gcp-vertexai", 492, 1230, "Sessions,\nMemory Bank", "right"),
    "rag": ("gcp-vertexai", 1340, 905, "RAG Engine\ntext search", "right"),
    "gateway": ("gcp-cloud_api_gateway", 1300, 1010, "Agent Gateway", "below"),
    "armor": ("gcp-security", 1420, 1010, "Model Armor", "above"),
    "pubsub": ("gcp-pubsub", 1930, 700, "Pub/Sub\nchange events", "below"),
}

# id: (x, y, w, h, kind, text)  kind: "code" (backend), "agent" (an AI agent or a Gemini step),
# "web" (a website page), "table" (a Postgres table), "node" (a Neo4j node type), "people"
BOXES = {
    "user": (30, 380, 140, 70, "people", "User"),
    "admin": (30, 560, 140, 70, "people", "Admin"),
    "news_ui": (220, 190, 180, 110, "web", "News watch"),
    "chain_ui": (220, 560, 180, 70, "web", "Chain view + review\n(admin only)"),
    "trademap_ui": (220, 760, 180, 60, "web", "Trade map:\nsuppliers"),
    "chat_ui": (220, 1010, 180, 60, "web", "Assistant chat"),
    # 1 · News watch
    "scan": (570, 80, 180, 60, "code", "News scan"),
    "match": (570, 195, 220, 110, "code", "News matches API"),
    "learn": (1200, 370, 230, 50, "code", "Link weights job\n(nightly)"),
    # 2 · Material chain
    "finder": (570, 480, 190, 55, "agent", "Source finder agent\n(new industries)"),
    "writer": (900, 480, 160, 55, "agent", "Writer"),
    "checks": (1170, 480, 170, 55, "code", "Checks\nquote, HS, no loops"),
    "reviewer": (1360, 480, 170, 55, "agent", "Reviewer"),
    "publish": (570, 600, 220, 60, "code", "Publish chain version job"),
    # 3 · Supplier sourcing
    "certificate": (600, 750, 200, 55, "agent", "Read certificate"),
    "tick": (1010, 750, 200, 55, "code", "User agrees with\nsuggestions"),
    "sourcing": (1270, 750, 190, 55, "code", "Supplier sourcing\nrecord"),
    # 4 · Assistant
    "orchestrator": (500, 1010, 160, 60, "agent", "Orchestrator agent"),
    "quick": (820, 905, 170, 50, "agent", "Quick answer agent"),
    "analyst": (820, 1010, 170, 55, "agent", "Analyst agent\nplans, delegates"),
    "specialists": (1060, 905, 200, 55, "agent", "News, stock, company\nspecialist agents"),
    "graph_specialist": (1060, 1010, 200, 55, "agent", "Graph specialist"),
    "graph_query": (1358, 1110, 180, 55, "code", "Graph query API"),
    "auditor": (920, 1115, 170, 45, "code", "Auditor script"),
    "critic": (920, 1180, 200, 50, "agent", "Critic agent"),
    # Graph sync
    "sync": (1898, 560, 120, 50, "code", "Graph sync"),
    # Postgres tables
    "reviews": (1660, 315, 190, 40, "table", "news_order_reviews"),
    "edges": (1665, 400, 180, 35, "table", "graph_edges"),
    "nodes": (1665, 450, 180, 35, "table", "graph_nodes"),
    "sources": (1665, 500, 180, 35, "table", "graph_sources"),
    "versions": (1665, 550, 180, 35, "table", "chain_versions"),
    "supplier_sourcing": (1660, 755, 190, 40, "table", "supplier_sourcing"),
    "orders": (1660, 810, 190, 35, "table", "orders"),
    "suppliers": (1660, 855, 190, 35, "table", "suppliers"),
    # The graph read model: node types, and the table each is copied from
    "material": (2215, 290, 200, 70, "node", "Material\n(graph_nodes table)"),
    "supplier": (2215, 470, 200, 70, "node", "Supplier\n(suppliers table)"),
    "order": (2215, 660, 200, 70, "node", "Order\n(orders table)"),
    "product": (2215, 850, 200, 70, "node", "Product\n(graph_nodes table)"),
}

# The service a block runs on or is built with, as a logo on its top-right corner: Cloud Run for
# backend code, Google ADK for the assistant's agents, Gemini for steps that call it directly.
TAGS = {
    "scan": "gcp-cloud_run",
    "match": "gcp-cloud_run",
    "learn": "gcp-cloud_run",
    "finder": "google-adk",
    "writer": "googlegemini",
    "checks": "gcp-cloud_run",
    "reviewer": "googlegemini",
    "publish": "gcp-cloud_run",
    "certificate": "googlegemini",
    "tick": "gcp-cloud_run",
    "sourcing": "gcp-cloud_run",
    "orchestrator": "google-adk",
    "quick": "google-adk",
    "analyst": "google-adk",
    "specialists": "google-adk",
    "graph_specialist": "google-adk",
    "graph_query": "gcp-cloud_run",
    "auditor": "google-adk",
    "critic": "google-adk",
    "sync": "gcp-cloud_run",
}

# (title, x, y, w, h, kind, icon)  kind: "cloud" | "lane" | "web" | "db"
FRAMES = [
    ("Website", 200, 40, 220, 1270, "web", "vercel"),
    ("Google Cloud", 440, 0, 2045, 1330, "cloud", None),
    ("1. News watch: from news to the orders it may hit", 455, 40, 1145, 390, "lane", "gcp-cloud_run"),
    ("2. Material chain builder (offline path)", 455, 445, 1145, 240, "lane", "gcp-cloud_run"),
    ("3. Supplier sourcing: what each supplier buys, from where", 455, 700, 1145, 160, "lane", None),
    ("4. Assistant (GraphRAG): questions about connections", 455, 875, 1145, 420, "lane", "gcp-vertexai"),
    (POSTGRES, 1645, 280, 225, 630, "db", "gcp-cloud_sql"),
    (CHAIN_TABLES, 1655, 375, 205, 225, "db", None),
    (NEO4J, 2165, 200, 300, 960, "db", "neo4j"),
]

# (from, to, label, route)  from / to: a block or a frame's title. route: absolute points
# start … end, or None for a straight line.
ARROWS = [
    ("user", "news_ui", "", [(100, 380), (100, 235), (220, 235)]),
    ("user", "trademap_ui", "", [(30, 415), (15, 415), (15, 790), (220, 790)]),
    ("user", "chat_ui", "", [(40, 435), (8, 435), (8, 1040), (220, 1040)]),
    ("admin", "chain_ui", "", [(170, 595), (220, 595)]),
    # 1 · News watch
    ("scheduler", "scan", "", [(526, 110), (570, 110)]),
    ("scan", "gemini", "assess article", [(750, 110), (900, 110)]),
    ("scan", "alerts", "save alerts with cleaned mentions", [(700, 140), (700, 160), (1180, 160), (1180, 120), (1200, 120)]),
    ("news_ui", "match", "request\nsuggested orders", [(400, 205), (570, 205)]),
    ("match", "news_ui", "return orders\n+ cited paths", [(570, 250), (400, 250)]),
    ("news_ui", "match", "confirm or reject\nsuggested order", [(400, 295), (570, 295)]),
    ("match", "alerts", "read alerts and mentions", [(760, 195), (760, 180), (1228, 180), (1228, 138)]),
    ("match", NEO4J, "Cypher query for paths from material to order", [(790, 257), (2165, 257)]),
    ("match", "reviews", "save verdict and path", [(790, 290), (1615, 290), (1615, 335), (1660, 335)]),
    ("learn", "reviews", "read verdicts per link", [(1315, 370), (1315, 350), (1660, 350)]),
    ("learn", "edges", "update link weights", [(1430, 395), (1610, 395), (1610, 417), (1665, 417)]),
    # 2 · Material chain
    ("monthly", "finder", "", [(526, 507), (570, 507)]),
    ("finder", "storage", "", [(760, 507), (800, 507)]),
    ("storage", "writer", "texts", [(856, 507), (900, 507)]),
    ("writer", "checks", "links +\nsource quote", [(1060, 522), (1170, 522)]),
    ("checks", "reviewer", "", None),
    ("reviewer", CHAIN_TABLES, "draft version\n+ flagged links", [(1530, 522), (1655, 522)]),
    ("chain_ui", CHAIN_TABLES, "read sources, checks, accuracy, flagged links", [(400, 575), (1655, 575)]),
    ("chain_ui", "publish", "approve", [(400, 615), (570, 615)]),
    ("publish", CHAIN_TABLES, "publish version", [(790, 640), (1615, 640), (1615, 590), (1655, 590)]),
    # 3 · Supplier sourcing
    ("trademap_ui", "certificate", "upload certificate docs", [(400, 777), (600, 777)]),
    ("certificate", "tick", "suggest material and origin", [(800, 790), (1010, 790)]),
    ("tick", "sourcing", "", None),
    ("trademap_ui", "sourcing", "manually fill material, origin, form", [(400, 810), (440, 810), (440, 845), (1365, 845), (1365, 805)]),
    ("sourcing", "supplier_sourcing", "", [(1460, 775), (1660, 775)]),
    # 4 · Assistant
    ("chat_ui", "orchestrator", "ask question", [(400, 1058), (500, 1058)]),
    ("orchestrator", "quick", "route question", [(620, 1010), (620, 930), (820, 930)]),
    ("quick", "orchestrator", "return draft", [(820, 950), (640, 950), (640, 1010)]),
    ("orchestrator", "analyst", "route question", [(660, 1025), (820, 1025)]),
    ("analyst", "orchestrator", "return draft", [(820, 1050), (660, 1050)]),
    ("orchestrator", "analyst", "send back failed draft, once", [(655, 1070), (655, 1088), (905, 1088), (905, 1065)]),
    ("analyst", "graph_specialist", "", None),
    ("analyst", "specialists", "", [(990, 1020), (1025, 1020), (1025, 932), (1060, 932)]),
    ("specialists", "rag", "search", [(1260, 932), (1340, 932)]),
    ("graph_specialist", "gateway", "", [(1260, 1037), (1300, 1037)]),
    ("gateway", "armor", "", [(1356, 1038), (1420, 1038)]),
    ("armor", "graph_query", "", [(1448, 1066), (1448, 1110)]),
    ("graph_query", NEO4J, "Cypher query for paths from material to order", [(1538, 1137), (2165, 1137)]),
    ("orchestrator", "auditor", "check citations and paths\n(after-model plugin)", [(635, 1070), (635, 1137), (920, 1137)]),
    ("orchestrator", "critic", "judge if paths support claims\n(after-model plugin)", [(605, 1070), (605, 1205), (920, 1205)]),
    ("orchestrator", "chat_ui", "return answer\n+ cited paths", [(500, 1022), (400, 1022)]),
    ("orchestrator", "memory", "", [(520, 1070), (520, 1230)]),
    # Data & graph
    (POSTGRES, "pubsub", "", [(1870, 728), (1930, 728)]),
    ("pubsub", "sync", "", [(1958, 700), (1958, 610)]),
    ("sync", NEO4J, "upsert nodes\n+ relationships", [(2018, 592), (2165, 592)]),
    ("supplier", "material", "BUYS {country, form}\n(supplier_sourcing table)", [(2315, 470), (2315, 360)]),
    ("supplier", "order", "SUPPLIES\n(orders table: supplier)", [(2315, 540), (2315, 660)]),
    ("order", "product", "IS_PRODUCT\n(orders table: HS code)", [(2315, 730), (2315, 850)]),
    (
        "product", "product", "USED_TO_MAKE {weight, quote}\n(graph_edges table)",
        [(2415, 885), (2445, 885), (2445, 1000), (2190, 1000), (2190, 960), (2250, 960), (2250, 916)],
    ),
]


class Scene:
    def __init__(self):
        self.elements = []
        self.files = {}
        self.frames = {}
        self.random = random.Random(11)

    def _base(self, kind, x, y, w, h, stroke="#1e1e1e", fill="transparent", dashed=False):
        element = {
            "id": f"{kind}-{len(self.elements)}",
            "type": kind,
            "x": x,
            "y": y,
            "width": w,
            "height": h,
            "angle": 0,
            "strokeColor": stroke,
            "backgroundColor": fill,
            "fillStyle": "hachure",
            "strokeWidth": 1,
            "strokeStyle": "dashed" if dashed else "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": None,
            "roundness": {"type": 3} if kind == "rectangle" else None,
            "seed": self.random.randint(1, 2**31),
            "version": 1,
            "versionNonce": self.random.randint(1, 2**31),
            "isDeleted": False,
            "boundElements": [],
            "updated": 1,
            "link": None,
            "locked": False,
        }
        self.elements.append(element)
        return element

    def text(self, x, y, w, h, text, color, size=14, container=None, align="center", valign="middle"):
        element = self._base("text", x, y, w, h, color)
        element.update(
            {
                "text": text,
                "originalText": text,
                "fontSize": size,
                "fontFamily": 1,
                "textAlign": align,
                "verticalAlign": valign,
                "containerId": container["id"] if container else None,
                "autoResize": True,
                "lineHeight": 1.25,
                "roundness": None,
            }
        )
        if container:
            container["boundElements"].append({"type": "text", "id": element["id"]})
        return element

    def icon(self, name, x, y, size=56):
        svg_path = ICONS / f"{name}.svg"
        if svg_path.exists():
            svg = svg_path.read_text(encoding="utf-8")
            if name in BRAND_COLORS:
                svg = svg.replace("<svg ", f'<svg fill="{BRAND_COLORS[name]}" ', 1)
            mime_type, data = "image/svg+xml", svg.encode()
        else:
            mime_type, data = "image/png", (ICONS / f"{name}.png").read_bytes()
        file_id = f"icon-{name}"
        self.files[file_id] = {
            "mimeType": mime_type,
            "id": file_id,
            "dataURL": f"data:{mime_type};base64," + base64.b64encode(data).decode(),
            "created": 1,
            "lastRetrieved": 1,
        }
        element = self._base("image", x, y, size, size, "transparent")
        element.update({"fileId": file_id, "status": "saved", "scale": [1, 1], "roundness": None})
        return element

    def service(self, icon, x, y, label, side):
        element = self.icon(icon, x, y)
        lines = label.count("\n") + 1
        if side == "right":
            self.text(x + 62, y + 28 - lines * 8, 170, lines * 17, label, "#1e1e1e", 13, align="left")
        elif side == "above":
            self.text(x - 47, y - 4 - lines * 17, 150, lines * 17, label, "#1e1e1e", 13, valign="top")
        else:
            self.text(x - 47, y + 60, 150, lines * 17, label, "#1e1e1e", 13, valign="top")
        return element

    def box(self, x, y, w, h, kind, text, tag=None):
        fill, stroke = FILL[kind]
        shape = "ellipse" if kind in ("people", "node") else "rectangle"
        element = self._base(shape, x, y, w, h, stroke, fill)
        lines = text.count("\n") + 1
        self.text(x + 6, y + h / 2 - lines * 9, w - 12, lines * 18, text, stroke, 14, element)
        if tag:
            self.icon(tag, x + w - 18, y - 8, 32)
        return element

    def frame(self, title, x, y, w, h, kind, icon):
        color = FRAME_COLOR[kind]
        frame = self._base("rectangle", x, y, w, h, color, dashed=kind != "cloud")
        frame["roughness"] = 0
        offset = 0
        if icon:
            self.icon(icon, x + 8, y + 6, 24)
            offset = 28
        size = 20 if kind == "cloud" else 14 if kind == "db" else 16
        self.text(x + 10 + offset, y + 8, w - 20 - offset, 24, title, color, size, align="left", valign="top")
        self.frames[title] = frame
        return frame

    def arrow(self, start, end, label, route):
        sx, sy, sw, sh = start["x"], start["y"], start["width"], start["height"]
        ex, ey, ew, eh = end["x"], end["y"], end["width"], end["height"]
        if route:
            (x1, y1), *mid, (x2, y2) = route
        else:
            dx = (ex + ew / 2) - (sx + sw / 2)
            dy = (ey + eh / 2) - (sy + sh / 2)
            if abs(dx) > abs(dy):
                x1, x2 = (sx + sw, ex) if dx > 0 else (sx, ex + ew)
                y1 = y2 = (max(sy, ey) + min(sy + sh, ey + eh)) / 2
            else:
                y1, y2 = (sy + sh, ey) if dy > 0 else (sy, ey + eh)
                x1 = x2 = (max(sx, ex) + min(sx + sw, ex + ew)) / 2
            mid = []
        points = [(0, 0), *[(px - x1, py - y1) for px, py in mid], (x2 - x1, y2 - y1)]
        if label:
            points = centre_longest_segment(points)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        element = self._base("arrow", x1, y1, max(xs) - min(xs), max(ys) - min(ys), ARROW_COLOR)
        element.update(
            {
                "points": [list(p) for p in points],
                "lastCommittedPoint": None,
                "startBinding": {"elementId": start["id"], "focus": 0, "gap": 4},
                "endBinding": {"elementId": end["id"], "focus": 0, "gap": 4},
                "startArrowhead": None,
                "endArrowhead": "arrow",
                "elbowed": False,
                "roundness": None,
            }
        )
        start["boundElements"].append({"type": "arrow", "id": element["id"]})
        end["boundElements"].append({"type": "arrow", "id": element["id"]})
        if label:
            middle = len(points) // 2 - 1
            (ax, ay), (bx, by) = points[middle], points[middle + 1]
            lines = label.split("\n")
            width = max(len(line) for line in lines) * 7 + 8
            lx, ly = x1 + (ax + bx) / 2, y1 + (ay + by) / 2
            self.text(lx - width / 2, ly - 9 * len(lines), width, 18 * len(lines), label, ARROW_COLOR, 12, element)
        return element


def centre_longest_segment(points):
    """Excalidraw puts an arrow's label at its middle: the middle point when there is an odd number of
    points, else the middle of the middle segment. Add 1px steps along the longest segment until it is
    the middle segment, so the label sits on it (the steps are invisible)."""
    segments = list(zip(points, points[1:], strict=False))
    longest = max(range(len(segments)), key=lambda i: abs(segments[i][1][0] - segments[i][0][0]) + abs(segments[i][1][1] - segments[i][0][1]))
    before, after = longest, len(segments) - 1 - longest
    (ax, ay), (bx, by) = segments[longest]
    length = abs(bx - ax) + abs(by - ay)
    step_x, step_y = (bx - ax) / length, (by - ay) / length
    head = [(ax + step_x * n, ay + step_y * n) for n in range(1, max(0, after - before) + 1)]
    tail = [(bx - step_x * n, by - step_y * n) for n in range(max(0, before - after), 0, -1)]
    return [*points[: longest + 1], *head, *tail, *points[longest + 1 :]]


def build() -> dict:
    scene = Scene()
    for title, x, y, w, h, kind, icon in FRAMES:
        scene.frame(title, x, y, w, h, kind, icon)
    nodes = {}
    for key, (icon, x, y, label, side) in SERVICES.items():
        nodes[key] = scene.service(icon, x, y, label, side)
    for key, (x, y, w, h, kind, text) in BOXES.items():
        nodes[key] = scene.box(x, y, w, h, kind, text, TAGS.get(key))
    for start, end, label, route in ARROWS:
        scene.arrow(nodes.get(start) or scene.frames[start], nodes.get(end) or scene.frames[end], label, route)
    scene.text(2180, 1050, 270, 60, "Cypher walks, graph\nalgorithms, vector index", "#5f3dc4", 14)
    title = "Knowledge graph and GraphRAG architecture by flow"
    scene.text(20, -30, 1600, 30, title, "#1e1e1e", 24, align="left", valign="top")
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": scene.elements,
        "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
        "files": scene.files,
    }


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "docs/knowledge-graph-architecture.excalidraw"
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(build(), handle, ensure_ascii=False, indent=1)
    print(f"wrote {target}")
