# Firebase Auth (email + password) and a web app whose config the frontend uses.

resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.apis]
}

resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = concat(
    var.auth_domains,
    ["${var.project_id}.firebaseapp.com", "${var.project_id}.web.app"],
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
