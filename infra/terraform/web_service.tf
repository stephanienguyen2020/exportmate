# The website on Cloud Run (frontend/Dockerfile): the Vite build served by nginx, which forwards
# /api/v1 to the backend and /api to the AI service, so the browser talks to one address. Terraform
# creates it with a placeholder image; frontend/deploy.sh sets the real one. It holds no secrets
# and calls nothing on Google Cloud, so its service account has no roles.

resource "google_service_account" "web" {
  account_id   = "exportmate-web"
  display_name = "ExportMate website (Cloud Run)"

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "web" {
  name                = "exportmate-web"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.web.email
    # Chat answers stream through it for up to a few minutes.
    timeout = "600s"

    scaling {
      max_instance_count = 3
    }

    containers {
      image = local.placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        # CPU only while answering a request (cheaper; under 512 Mi needs it).
        cpu_idle = true
      }

      env {
        name  = "BACKEND_HOST"
        value = trimprefix(google_cloud_run_v2_service.backend.uri, "https://")
      }
      env {
        name  = "AI_HOST"
        value = trimprefix(local.ai_url, "https://")
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
