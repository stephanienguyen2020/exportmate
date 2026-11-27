# Trade defence risk: the Order features job (ml/trade_risk/order_features.py) scores each
# order's market, exporting country and HS code into the app database. The backend starts it for
# new pairs (--new, --pair ...), and Cloud Scheduler runs it monthly over every pair. Its code is
# the image (ml/deploy.sh); the prepared data and the trained model are in the ML bucket
# (ml/upload.sh), mounted read-only.

locals {
  order_features_job = "exportmate-order-features"
}

# Prepared data, raw sources and trained models (data/..., models/trade_risk/<date>/), as in ml/.
resource "google_storage_bucket" "ml" {
  name                        = "exportmate-ml-dev"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "trade_risk" {
  account_id   = "exportmate-order-features"
  display_name = "Cloud Run job: trade defence risk scores"

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "trade_risk_reads_ml" {
  bucket = google_storage_bucket.ml.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.trade_risk.email}"
}

resource "google_project_iam_member" "trade_risk_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.trade_risk.email}"
}

# The same database and user as the backend (it writes the trade risk tables).
resource "google_secret_manager_secret_iam_member" "trade_risk_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.trade_risk.email}"
}

# UN Comtrade API key. Terraform makes the empty secret; add the key by hand so it never lands in
# Terraform state (before the job's first run):
#   printf %s "$KEY" | gcloud secrets versions add trade-risk-comtrade-api-key --data-file=-
resource "google_secret_manager_secret" "comtrade_api_key" {
  secret_id = "trade-risk-comtrade-api-key"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "trade_risk_reads_comtrade_api_key" {
  secret_id = google_secret_manager_secret.comtrade_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.trade_risk.email}"
}

resource "google_cloud_run_v2_job" "trade_risk" {
  name                = local.order_features_job
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account       = google_service_account.trade_risk.email
      max_retries           = 0
      timeout               = "21600s"                     # the monthly run fetches every pair from Comtrade
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2" # needed for the bucket volume

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      volumes {
        name = "ml"
        gcs {
          bucket    = google_storage_bucket.ml.name
          read_only = true
        }
      }

      containers {
        # ml/deploy.sh sets the real image; its entrypoint is `python -m trade_risk.order_features`,
        # and each start passes only the arguments.
        image = local.placeholder_image

        resources {
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }

        env {
          name  = "ML_DATA_DIR"
          value = "/mnt/ml/data"
        }

        env {
          name  = "ML_MODELS_DIR"
          value = "/mnt/ml/models"
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

        env {
          name = "COMTRADE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.comtrade_api_key.secret_id
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        volume_mounts {
          name       = "ml"
          mount_path = "/mnt/ml"
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
    google_storage_bucket_iam_member.trade_risk_reads_ml,
    google_project_iam_member.trade_risk_cloudsql_client,
    google_secret_manager_secret_iam_member.trade_risk_reads_database_url,
    google_secret_manager_secret_iam_member.trade_risk_reads_comtrade_api_key,
  ]
}

# Saving orders with new pairs and what-ifs start the job with their own arguments
# (backend/app/core/trade_risk_job.py), which needs the "with overrides" role.
resource "google_cloud_run_v2_job_iam_member" "backend_runs_trade_risk" {
  name     = google_cloud_run_v2_job.trade_risk.name
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_trade_risk" {
  name     = google_cloud_run_v2_job.trade_risk.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# The monthly run (no arguments): every order's pair and every pair scored before, with the
# months Comtrade added since, and the case list.
resource "google_cloud_scheduler_job" "monthly_trade_risk" {
  name             = "exportmate-monthly-order-features"
  region           = var.region
  schedule         = "0 6 1 * *"
  time_zone        = "Asia/Ho_Chi_Minh"
  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.trade_risk.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_runs_trade_risk]
}
