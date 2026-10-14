# The FastAPI backend on Cloud Run, and a job (same image) for migrations and seeding.
# Terraform creates them with a placeholder image; backend/deploy.sh sets the real one.

locals {
  backend_env = {
    ENV                        = "production"
    AUTH_MODE                  = "firebase"
    FIREBASE_PROJECT_ID        = var.project_id
    ALLOWED_ORIGINS            = var.allowed_origins
    REGULATION_DOCUMENT_BUCKET = google_storage_bucket.regulation_documents.name
    REPORT_EMAIL_FROM          = var.report_email_from
    # Company reports read News watch alerts. The deterministic URL (ai_service.tf) avoids a
    # cycle: the AI service already points at this backend.
    AI_SERVICE_URL       = local.ai_url
    GOOGLE_CLOUD_PROJECT = var.project_id # Vertex AI project for Gemini
  }
}

# Resend key for emailed order reports. Terraform makes the empty secret; add the key by hand
# so it never lands in Terraform state:
#   printf %s "$KEY" | gcloud secrets versions add backend-resend-api-key --data-file=-
# then set resend_enabled = true. Until then reports are sent in sandbox mode (not delivered).
resource "google_secret_manager_secret" "resend_api_key" {
  secret_id = "backend-resend-api-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "backend_reads_resend_api_key" {
  secret_id = google_secret_manager_secret.resend_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_cloud_run_v2_service" "backend" {
  name                = "exportmate-backend"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.backend.email

    scaling {
      max_instance_count = 3
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = local.placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = local.backend_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = var.resend_enabled ? [google_secret_manager_secret.resend_api_key.secret_id] : []
        content {
          name = "RESEND_API_KEY"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
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

  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_iam_member.backend_reads_database_url,
    google_secret_manager_secret_iam_member.backend_reads_resend_api_key,
    google_project_iam_member.backend_cloudsql_client,
  ]
}

# Public API: auth is checked inside the app (Firebase ID token).
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  name     = google_cloud_run_v2_service.backend.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Runs one shell command with the backend image, e.g.
#   gcloud run jobs execute exportmate-backend-task --args="alembic upgrade head"
resource "google_cloud_run_v2_job" "backend_task" {
  name                = "exportmate-backend-task"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.backend.email
      max_retries     = 0
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = local.placeholder_image
        command = ["sh", "-c"]
        # Same as backend/deploy.sh: migrate, then load the reference data and official texts.
        args = ["alembic upgrade head && python -m app.seed_reference_data"]

        dynamic "env" {
          for_each = local.backend_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_iam_member.backend_reads_database_url,
    google_project_iam_member.backend_cloudsql_client,
  ]
}
