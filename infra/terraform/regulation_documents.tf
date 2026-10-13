# Private, versioned bucket for uploaded regulation texts and articles (REQUIREMENTS §4.5).
# Read and written by the backend (app/core/file_storage.py).
resource "google_storage_bucket" "regulation_documents" {
  name                        = "exportmate-regulation-documents-dev"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "backend_reads_regulation_documents" {
  bucket = google_storage_bucket.regulation_documents.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_storage_bucket_iam_member" "backend_writes_regulation_documents" {
  bucket = google_storage_bucket.regulation_documents.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.backend.email}"
}
