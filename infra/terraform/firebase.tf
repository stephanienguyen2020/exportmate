# Firebase Auth (email + password, and Google once an OAuth client is set) and a web app whose
# config the frontend uses.

resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.apis]
}

resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = var.project_id

  # The website's Cloud Run addresses too, for Google sign-in there.
  authorized_domains = concat(
    var.auth_domains,
    ["${var.project_id}.firebaseapp.com", "${var.project_id}.web.app"],
    [for url in google_cloud_run_v2_service.web.urls : trimprefix(url, "https://")],
  )

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }
  }

  depends_on = [google_firebase_project.default]
}

# "Continue with Google". Terraform can't create the OAuth client; see README.md.
resource "google_identity_platform_default_supported_idp_config" "google" {
  count    = var.google_oauth_client_id == "" ? 0 : 1
  provider = google-beta
  project  = var.project_id

  idp_id        = "google.com"
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret
  enabled       = true

  depends_on = [google_identity_platform_config.auth]
}

resource "google_firebase_web_app" "frontend" {
  provider        = google-beta
  project         = var.project_id
  display_name    = "ExportMate web"
  deletion_policy = "DELETE"

  depends_on = [google_firebase_project.default]
}

data "google_firebase_web_app_config" "frontend" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.frontend.app_id
}
