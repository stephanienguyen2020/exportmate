"""List overlaps in a generated Excalidraw diagram: blocks on blocks, arrow labels or logo captions
on blocks or on each other, and arrow lines running through another arrow's label.

    python -I .claude/skills/architecture-diagram/check_overlaps.py docs/<name>.excalidraw
"""

import json
import sys

CAPTION_SIZE = 13  # logo captions; block text is 14, arrow labels 12, frame titles 14 to 20
CORNER_LOGO = 32  # the logo on a block's top-right corner, which overlaps its own block on purpose
FRAME_LOGO = 24  # the logo beside a frame's title
LABEL_CHAR_WIDTH = 8.5  # Excalidraw's hand-drawn font at 12px runs wider than the script's estimate


def label_bounds(label):
    """A label's box as Excalidraw draws it: centred on its spot, sized by its longest line."""
    width = max(len(line) for line in label["text"].split("\n")) * LABEL_CHAR_WIDTH
    centre = label["x"] + label["width"] / 2
    return centre - width / 2, label["y"], centre + width / 2, label["y"] + label["height"]


def lines_through_labels(elements, by_id, arrow_labels):
    problems = []
    arrows = [element for element in elements if element["type"] == "arrow"]
    for label in arrow_labels:
        left, top, right, bottom = label_bounds(label)
        for arrow in arrows:
            if arrow["id"] == label["containerId"]:
                continue
            points = [(arrow["x"] + dx, arrow["y"] + dy) for dx, dy in arrow["points"]]
            for (ax, ay), (bx, by) in zip(points, points[1:], strict=False):
                vertical = ax == bx and left < ax < right and min(ay, by) < bottom and max(ay, by) > top
                horizontal = ay == by and top < ay < bottom and min(ax, bx) < right and max(ax, bx) > left
                if vertical or horizontal:
                    problems.append(f"line through label: {label['text'].replace(chr(10), ' ')}")
                    break
    return problems


def bounds(element):
    return element["x"], element["y"], element["x"] + element["width"], element["y"] + element["height"]


def overlaps(first, second, pad):
    ax1, ay1, ax2, ay2 = bounds(first)
    bx1, by1, bx2, by2 = bounds(second)
    return ax1 < bx2 - pad and bx1 < ax2 - pad and ay1 < by2 - pad and by1 < ay2 - pad


def check_diagram(path):
    with open(path, encoding="utf-8") as handle:
        elements = json.load(handle)["elements"]
    by_id = {element["id"]: element for element in elements}
    texts_in = {}
    for element in elements:
        if element["type"] == "text" and element.get("containerId"):
            texts_in[element["containerId"]] = element["text"]

    def describe(element):
        text = element["text"] if element["type"] == "text" else texts_in.get(element["id"], element.get("fileId", element["id"]))
        return text.replace("\n", " ")[:40]

    # Frames are drawn without roughness; everything else that takes space is a block or a logo.
    blocks = [
        element
        for element in elements
        if element["type"] in ("rectangle", "ellipse", "image")
        and element.get("roughness") != 0
        and element["width"] > FRAME_LOGO
    ]

    def own_corner(first, second):
        """True when one is a corner logo sitting on the other's top-right corner."""
        for logo, block in ((first, second), (second, first)):
            if logo["type"] == "image" and logo["width"] == CORNER_LOGO and block["width"] != CORNER_LOGO:
                if abs(logo["x"] - (block["x"] + block["width"] - 18)) < 1 and abs(logo["y"] - (block["y"] - 8)) < 1:
                    return True
        return False

    arrow_labels = [
        element
        for element in elements
        if element["type"] == "text"
        and element.get("containerId")
        and by_id[element["containerId"]]["type"] == "arrow"
    ]
    captions = [
        element
        for element in elements
        if element["type"] == "text" and not element.get("containerId") and element["fontSize"] == CAPTION_SIZE
    ]
    texts = arrow_labels + captions
    problems = []
    for index, first in enumerate(blocks):
        for second in blocks[index + 1 :]:
            if overlaps(first, second, 2) and not own_corner(first, second):
                problems.append(f"blocks overlap: {describe(first)} | {describe(second)}")
    for text in texts:
        for block in blocks:
            if overlaps(text, block, 4):
                problems.append(f"text on block: {describe(text)} | {describe(block)}")
    for index, first in enumerate(texts):
        for second in texts[index + 1 :]:
            if overlaps(first, second, 2):
                problems.append(f"texts overlap: {describe(first)} | {describe(second)}")
    problems += lines_through_labels(elements, by_id, arrow_labels)
    return problems, len(blocks), len(texts)


if __name__ == "__main__":
    problems, block_count, text_count = check_diagram(sys.argv[1])
    print("\n".join(problems) or "no overlaps")
    print(f"checked {block_count} blocks and {text_count} labels")
    sys.exit(1 if problems else 0)
