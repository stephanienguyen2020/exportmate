# Cloud Build for the AI service image (ai/server/deploy.sh): a builder service account
# that can only push to the image registry and write build logs, and a bucket for the
# uploaded sources. The compute default service account has no roles in this project.

resource "google_service_account" "builder" {
  account_id   = "exportmate-builder"
  display_name = "Cloud Build: ExportMate images"

  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "builder_pushes_images" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.builder.email}"
}

resource "google_project_iam_member" "builder_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.builder.email}"
}

# Source archives uploaded by `gcloud builds submit`, deleted after 30 days.
resource "google_storage_bucket" "builds" {
  name                        = "${var.project_id}-builds"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "builder_reads_sources" {
  bucket = google_storage_bucket.builds.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.builder.email}"
}
