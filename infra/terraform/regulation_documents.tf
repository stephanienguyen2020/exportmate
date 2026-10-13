# Private, versioned bucket for regulation documents the backend stores (REQUIREMENTS §4.5).
# This mirrors what is already deployed in the shared Terraform state, where it was applied
# from a config that isn't in the repo yet; keeping it here stops `terraform apply` from
# deleting it. Reconcile with the original when that config is committed.
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
