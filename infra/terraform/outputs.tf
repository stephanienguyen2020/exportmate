output "backend_url" {
  description = "Base URL of the backend. API docs at <url>/api/v1/docs."
  value       = google_cloud_run_v2_service.backend.uri
}

output "image_repository" {
  description = "Where deploy.sh pushes backend images."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "sql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

# Public by design: Firebase web config is shipped in the frontend bundle.
output "firebase_web_config" {
  description = "Paste into the frontend's Firebase initializeApp()."
  value = {
    apiKey     = data.google_firebase_web_app_config.frontend.api_key
    authDomain = data.google_firebase_web_app_config.frontend.auth_domain
    projectId  = var.project_id
    appId      = google_firebase_web_app.frontend.app_id
  }
}
