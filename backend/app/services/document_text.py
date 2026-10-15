"""Text out of a regulation document, and the parts of it worth sending to AI.

- PDF, HTML and plain text give their text. A PDF with almost no text is a scan: it returns
  None and AI reads the file itself (its quotes can't be checked against the text then).
- A long text is split into sections; when it is too long for one prompt, the sections closest
  in meaning to what we're looking for (embeddings) are kept, in document order. Nothing is
  stored: each document is read once.
"""

import io
import logging
import math
import re
from html.parser import HTMLParser

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.core import gemini
from app.core.errors import AppError

log = logging.getLogger(__name__)

# Below this many letters per page a PDF is taken to be scanned images.
MIN_LETTERS_PER_PAGE = 200
SECTION_CHARS = 1500
# Texts up to this size go to AI whole; longer ones are cut down to the closest sections.
PROMPT_TEXT_CHARS = 120_000
# Amendment markers in EU consolidated texts ("►M1 … ◄", "▼B"), which quotes leave out.
_AMENDMENT_MARKER = re.compile(r"[►▼◄]\s*(?:[A-Z]\d*\b)?")
# Section headings in legal texts: "Article 9", "§ 3372", "ANNEX I", "Chapter 3", "Section 2".
_HEADING = re.compile(r"^\s*(Article|ARTICLE|§|Section|SECTION|Chapter|CHAPTER|ANNEX|Annex)\b")


class _TextOnly(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skipping += 1
        elif tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "table"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skipping:
            self._skipping -= 1

    def handle_data(self, data):
        if not self._skipping:
            self.parts.append(data)


def _pdf_text(content: bytes) -> str | None:
    try:
        reader = PdfReader(io.BytesIO(content))
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PdfReadError, ValueError, KeyError) as error:
        log.info("document_text.pdf_unreadable", extra={"error": type(error).__name__})
        return None
    letters = sum(len(re.findall(r"[^\W\d_]", page)) for page in pages)
    if not pages or letters < MIN_LETTERS_PER_PAGE * len(pages):
        return None  # scanned
    return "\n".join(pages)


def document_text(content: bytes, content_type: str) -> str | None:
    """The document's text, or None when only AI can read it (a scanned PDF)."""
    if content_type == "text/plain":
        return content.decode("utf-8", errors="replace")
    if content_type == "text/html":
        parser = _TextOnly()
        parser.feed(content.decode("utf-8", errors="replace"))
        return "".join(parser.parts)
    if content_type == "application/pdf":
        return _pdf_text(content)
    return None


def normalize(text: str) -> str:
    """For finding a quote in a text: no line-break hyphens or amendment markers, one space,
    lower case, plain quotes and dashes."""
    text = _AMENDMENT_MARKER.sub(" ", text.replace("­", ""))
    for curly, plain in (("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"')):
        text = text.replace(curly, plain)
    text = text.replace("–", "-").replace("—", "-")
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)
    return " ".join(text.split()).lower()


def contains_quote(text: str, quote: str) -> bool:
    """The quote is in the text word for word. A quote that joins passages from different places
    counts when every sentence or clause in it is (each at least a few words long)."""
    haystack, needle = normalize(text), normalize(quote)
    if needle in haystack:
        return True
    parts = [p.strip() for p in re.split(r"(?<=[.;])\s+", needle) if p.strip()]
    return len(parts) > 1 and all(len(p) >= 20 and p in haystack for p in parts)


def split_sections(text: str) -> list[str]:
    """Sections at legal headings and blank lines, each at most about SECTION_CHARS."""
    blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if _HEADING.match(line) and current:
            blocks.append("\n".join(current))
            current = []
        current.append(line)
        if not line.strip() and sum(len(c) for c in current) > SECTION_CHARS:
            blocks.append("\n".join(current))
            current = []
    if current:
        blocks.append("\n".join(current))
    sections: list[str] = []
    for block in (b.strip() for b in blocks):
        while len(block) > SECTION_CHARS * 2:
            cut = block.rfind(" ", 0, SECTION_CHARS)
            cut = cut if cut > 0 else SECTION_CHARS
            sections.append(block[:cut])
            block = block[cut:].strip()
        if block:
            sections.append(block)
    return sections


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _keyword_score(section: str, query: str) -> int:
    words = {w for w in re.findall(r"\w{4,}", query.lower())}
    lowered = section.lower()
    return sum(lowered.count(w) for w in words)


def relevant_text(text: str, query: str, limit_chars: int = PROMPT_TEXT_CHARS) -> tuple[str, bool]:
    """(the text to send, whether it was cut down). Short texts go whole. Long ones keep the
    sections closest to `query` (by embedding; by shared words if embedding fails), in order."""
    if len(text) <= limit_chars:
        return text, False
    sections = split_sections(text)
    try:
        vectors = gemini.embed_texts(sections, "RETRIEVAL_DOCUMENT")
        (query_vector,) = gemini.embed_texts([query], "RETRIEVAL_QUERY")
        scores = [_cosine(v, query_vector) for v in vectors]
        method = "embedding"
    except AppError:
        scores = [float(_keyword_score(s, query)) for s in sections]
        method = "keyword"
    ranked = sorted(range(len(sections)), key=lambda i: scores[i], reverse=True)
    kept: set[int] = set()
    used = 0
    for i in ranked:
        if used + len(sections[i]) > limit_chars:
            continue
        kept.add(i)
        used += len(sections[i])
    log.info(
        "document_text.sections_selected",
        extra={"sections": len(sections), "kept": len(kept), "method": method},
    )
    return "\n\n[…]\n\n".join(sections[i] for i in sorted(kept)), True
