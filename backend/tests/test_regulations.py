from conftest import add_member, onboard

from app.core.config import get_settings
from app.database.models import Role

EUDR_V1 = b"%PDF-1.7\nRegulation (EU) 2023/1115 ... applies from 30 December 2024 ...\n"
EUDR_V2 = b"%PDF-1.7\nRegulation (EU) 2023/1115 consolidated ... applies from 30 December 2025\n"


def upload_document(
    client, headers, content=EUDR_V1, filename="eudr.pdf", content_type="application/pdf", **form
):
    data = {"title": "EU deforestation regulation", **form}
    return client.post(
        "/api/v1/documents",
        headers=headers,
        data=data,
        files={"file": (filename, content, content_type)},
    )


def test_first_upload_creates_regulation_version_1(client):
    headers = onboard(client, "lan@example.com")
    response = upload_document(
        client,
        headers,
        officialId="32023R1115",
        sourceUrl="https://eur-lex.europa.eu/eli/reg/2023/1115/oj",
    )
    assert response.status_code == 201, response.text
    document = response.json()["data"]
    assert document["versionNumber"] == 1
    assert document["contentType"] == "application/pdf"
    assert document["sourceUrl"] == "https://eur-lex.europa.eu/eli/reg/2023/1115/oj"

    regulations = client.get("/api/v1/regulations", headers=headers).json()["data"]
    assert len(regulations) == 1
    assert regulations[0]["id"] == document["regulationId"]
    assert regulations[0]["officialId"] == "32023R1115"
    assert regulations[0]["versionCount"] == 1
    assert regulations[0]["latestVersion"]["id"] == document["id"]


def test_new_version_of_picked_regulation(client):
    headers = onboard(client, "lan@example.com")
    v1 = upload_document(client, headers, officialId="32023R1115").json()["data"]
    v2 = upload_document(
        client,
        headers,
        content=EUDR_V2,
        title="EUDR consolidated 2024-12-26",
        regulationId=v1["regulationId"],
    )
    assert v2.status_code == 201, v2.text
    assert v2.json()["data"]["versionNumber"] == 2
    assert v2.json()["data"]["regulationId"] == v1["regulationId"]

    detail = client.get(f"/api/v1/regulations/{v1['regulationId']}", headers=headers).json()
    assert [v["versionNumber"] for v in detail["data"]["versions"]] == [2, 1]
    assert detail["data"]["latestVersion"]["title"] == "EUDR consolidated 2024-12-26"
    # The regulation keeps its first title.
    assert detail["data"]["title"] == "EU deforestation regulation"


def test_same_file_twice_is_409(client):
    headers = onboard(client, "lan@example.com")
    assert upload_document(client, headers).status_code == 201
    again = upload_document(client, headers, title="Another title")
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "already_uploaded"


def test_official_id_already_used_is_409(client):
    headers = onboard(client, "lan@example.com")
    upload_document(client, headers, officialId="32023R1115")
    again = upload_document(client, headers, content=EUDR_V2, officialId="32023R1115")
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "regulation_exists"

    found = client.get("/api/v1/regulations?officialId=32023R1115", headers=headers).json()
    assert len(found["data"]) == 1


def test_official_id_not_allowed_on_new_version(client):
    headers = onboard(client, "lan@example.com")
    v1 = upload_document(client, headers).json()["data"]
    response = upload_document(
        client, headers, content=EUDR_V2, regulationId=v1["regulationId"], officialId="X"
    )
    assert response.status_code == 422
    assert "officialId" in response.json()["error"]["fieldErrors"]


def test_article_is_a_regulation_with_one_version(client):
    headers = onboard(client, "lan@example.com")
    article = upload_document(
        client,
        headers,
        content=b"<html><body>EU delays deforestation rules</body></html>",
        filename="news.html",
        content_type="text/html",
        title="EU delays deforestation rules",
    )
    assert article.status_code == 201, article.text
    assert article.json()["data"]["versionNumber"] == 1
    assert article.json()["data"]["contentType"] == "text/html"
    titles = [r["title"] for r in client.get("/api/v1/regulations", headers=headers).json()["data"]]
    assert titles == ["EU delays deforestation rules"]


def test_download_returns_the_stored_file(client):
    headers = onboard(client, "lan@example.com")
    document = upload_document(client, headers).json()["data"]
    response = client.get(f"/api/v1/documents/{document['id']}/file", headers=headers)
    assert response.status_code == 200
    assert response.content == EUDR_V1
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_rejects_bad_files(client):
    headers = onboard(client, "lan@example.com")
    wrong_type = upload_document(client, headers, filename="eudr.docx")
    assert wrong_type.json()["error"]["code"] == "invalid_file_type"
    fake_pdf = upload_document(client, headers, content=b"not a pdf")
    assert fake_pdf.json()["error"]["code"] == "invalid_pdf"
    empty = upload_document(client, headers, content=b"", filename="empty.txt")
    assert empty.json()["error"]["code"] == "empty_file"
    too_big = b"%PDF-" + b"x" * get_settings().max_upload_bytes
    assert upload_document(client, headers, content=too_big).json()["error"]["code"] == (
        "file_too_large"
    )
    bad_url = upload_document(client, headers, sourceUrl="javascript:alert(1)")
    assert "sourceUrl" in bad_url.json()["error"]["fieldErrors"]
    blank_title = upload_document(client, headers, title="   ")
    assert "title" in blank_title.json()["error"]["fieldErrors"]
    assert client.get("/api/v1/regulations", headers=headers).json()["data"] == []


def test_viewer_can_read_but_not_upload(client):
    owner = onboard(client, "lan@example.com")
    document = upload_document(client, owner).json()["data"]
    viewer = add_member(client, "lan@example.com", "viewer@example.com", Role.viewer)
    assert upload_document(client, viewer, content=EUDR_V2).status_code == 403
    assert client.get(f"/api/v1/documents/{document['id']}", headers=viewer).status_code == 200


def test_other_company_cannot_see_or_extend(client):
    lan = onboard(client, "lan@example.com")
    document = upload_document(client, lan).json()["data"]
    other = onboard(client, "minh@other.com", company="Other Co")

    assert client.get(f"/api/v1/documents/{document['id']}", headers=other).status_code == 404
    file_url = f"/api/v1/documents/{document['id']}/file"
    assert client.get(file_url, headers=other).status_code == 404
    regulation_url = f"/api/v1/regulations/{document['regulationId']}"
    assert client.get(regulation_url, headers=other).status_code == 404
    version = upload_document(client, other, content=EUDR_V2, regulationId=document["regulationId"])
    assert version.status_code == 404
    # The same file is fine in another company.
    assert upload_document(client, other).status_code == 201
