# Shared pieces: APIs, image registry (backend and AI images), the backend's service account.

locals {
  apis = [
    "agentregistry.googleapis.com", # Agent Registry (infra/agent-platform/govern.sh)
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com", # Agent Gateway
    "iap.googleapis.com",     # Agent Gateway egress policies
    "firebase.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "identitytoolkit.googleapis.com",
    "logging.googleapis.com",
    "modelarmor.googleapis.com",
    "networksecurity.googleapis.com", # Agent Gateway authorization policies
    "networkservices.googleapis.com", # Agent Gateway
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ]

  # Cloud Run needs an image to create the service and job. deploy.sh replaces it.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "exportmate"
  format        = "DOCKER"
  description   = "ExportMate container images"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "backend" {
  account_id   = "exportmate-backend"
  display_name = "ExportMate backend (Cloud Run)"

  depends_on = [google_project_service.apis]
}

# Connect to Cloud SQL through the built-in Cloud Run connector.
resource "google_project_iam_member" "backend_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.backend.email}"
}

# Verify ID tokens with check_revoked, and revoke them on logout.
resource "google_project_iam_member" "backend_firebase_auth_admin" {
  project = var.project_id
  role    = "roles/firebaseauth.admin"
  member  = "serviceAccount:${google_service_account.backend.email}"
}
