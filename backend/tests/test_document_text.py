from fpdf import FPDF

from app.services import document_text

ARTICLE_9 = (
    "Article 9 Information requirements. Operators shall collect the geolocation of all plots of "
    "land where the relevant commodities that the relevant product contains were produced."
)


def pdf_with_text(*paragraphs: str) -> bytes:
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=11)
    for paragraph in paragraphs:
        pdf.multi_cell(0, 6, paragraph)
        pdf.ln(4)
    return bytes(pdf.output())


def scanned_pdf() -> bytes:
    """A page with a drawing and no text, like a scan."""
    pdf = FPDF()
    pdf.add_page()
    pdf.rect(20, 20, 150, 200, style="F")
    return bytes(pdf.output())


def test_pdf_text_is_read_and_a_scan_has_none():
    text = document_text.document_text(pdf_with_text(ARTICLE_9 * 3), "application/pdf")
    assert "geolocation of all plots" in " ".join(text.split())
    assert document_text.document_text(scanned_pdf(), "application/pdf") is None
    assert document_text.document_text(b"not a pdf", "application/pdf") is None


def test_quotes_are_found_across_line_breaks_and_hyphens():
    text = "Operators shall col-\nlect the geo-\nlocation of all\nplots of land."
    assert document_text.contains_quote(
        text, "operators shall collect the geolocation of all plots"
    )
    assert not document_text.contains_quote(text, "operators may skip the geolocation")


def test_html_text_skips_scripts():
    html = b"<html><script>ignore()</script><p>Article 9</p><p>Operators shall</p></html>"
    text = document_text.document_text(html, "text/html")
    assert "ignore" not in text
    assert "Article 9" in text


def test_long_texts_keep_the_closest_sections(fake_gemini):
    filler = [f"Article {n} Fisheries quotas for the Baltic sea herring stock." for n in range(60)]
    wood = "Article 99 Plywood and furniture exporters must provide wood legality documents."
    text = "\n\n".join([*filler[:30], wood, *filler[30:]])
    kept, cut = document_text.relevant_text(
        text, "documents exporters of wood and furniture must provide", limit_chars=100
    )
    assert cut is True
    assert kept == wood

    fake_gemini.embeddings_fail = True  # falls back to shared words
    kept, _ = document_text.relevant_text(text, "plywood furniture wood", limit_chars=100)
    assert kept == wood

    short, cut = document_text.relevant_text(wood, "anything")
    assert (short, cut) == (wood, False)


def test_quotes_ignore_amendment_markers_and_curly_quotes():
    text = "Operators shall not ►M3 export ◄ them without a ‘due diligence statement’ ▼B first."
    assert document_text.contains_quote(
        text, "operators shall not export them without a 'due diligence statement' first."
    )


def test_a_quote_joining_two_passages_counts_only_if_each_is_there():
    text = "Operators shall submit a statement. Other text in between. Traders shall keep records."
    joined = "Operators shall submit a statement. Traders shall keep records."
    assert document_text.contains_quote(text, joined)
    assert not document_text.contains_quote(text, joined + " Nobody shall ever be fined.")
