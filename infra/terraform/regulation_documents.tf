# Private, versioned bucket for uploaded regulation texts and articles 
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

  # A deleted file (a removed supplier's certificates, a failed save) stays recoverable as a
  # noncurrent version for 30 days, then goes. Saved files are never overwritten.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# Create, read and delete objects (no bucket settings). The backend deletes a file it just
# saved when the database commit fails; versioning keeps the bytes as a noncurrent version.
resource "google_storage_bucket_iam_member" "backend_uses_regulation_documents" {
  bucket = google_storage_bucket.regulation_documents.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.backend.email}"
}
