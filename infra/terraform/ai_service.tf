# The AI service (ai/server) in the same project as the backend: Firestore with its
# vector indexes, a Cloud Run service and job, the daily news-scan schedule and
# log-based metrics. Terraform creates the service and job with a placeholder image;
# ai/server/deploy.sh builds the real one on Cloud Build and rolls it out.

data "google_project" "this" {}

locals {
  # Cloud Run's deterministic URL, known before the service exists. The daily scan's
  # OIDC token is minted for this audience and the service checks it (SCAN_AUDIENCE).
  ai_url = "https://exportmate-ai-${data.google_project.this.number}.${var.region}.run.app"

  ai_env = {
    GOOGLE_CLOUD_PROJECT  = var.project_id
    GOOGLE_CLOUD_LOCATION = "global" # Vertex AI endpoint for Gemini and the embedding model
    GEMINI_MODEL          = var.gemini_model
    ALLOWED_ORIGINS       = var.allowed_origins
    BACKEND_URL           = google_cloud_run_v2_service.backend.uri
    SCHEDULER_SA          = google_service_account.scheduler.email
    SCAN_AUDIENCE         = local.ai_url
  }

  ai_logs = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"exportmate-ai\""
}

# Stock, news sources, articles, alerts, scans, the vector index (kb), audits and eval runs.
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # `terraform destroy` leaves the data in place.
  deletion_policy = "ABANDON"

  depends_on = [google_project_service.apis]
}

# Vector indexes for search_knowledge (ai/server/rag.js): all of kb, and kb filtered by type.
# 768 dimensions must match DIMENSIONS in rag.js.
resource "google_firestore_index" "kb_embedding" {
  database   = google_firestore_database.default.name
  collection = "kb"

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }

  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}

resource "google_firestore_index" "kb_type_embedding" {
  database   = google_firestore_database.default.name
  collection = "kb"

  fields {
    field_path = "type"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }

  fields {
    field_path = "embedding"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}

# Least privilege: read/write Firestore documents and call Gemini on Vertex AI, nothing else.
resource "google_service_account" "ai" {
  account_id   = "exportmate-ai"
  display_name = "ExportMate AI service (Cloud Run)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "ai_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.ai.email}"
}

resource "google_project_iam_member" "ai_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.ai.email}"
}

# Signs the daily scan's OIDC token. It needs no roles: the AI service checks the token's email.
resource "google_service_account" "scheduler" {
  account_id   = "exportmate-scheduler"
  display_name = "Cloud Scheduler: daily news scan"

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "ai" {
  name                = "exportmate-ai"
  location            = var.region
  deletion_protection = false
  ingress             = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.ai.email
    # A chat streams for up to a minute or two; a scan can take several.
    timeout                          = "600s"
    max_instance_request_concurrency = 80

    # Chat limits are counted per instance (CHAT_LIMIT_PER_INSTANCE), so this caps spend.
    scaling {
      max_instance_count = 3
    }

    containers {
      image = local.placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.ai_env
        content {
          name  = env.key
          value = env.value
        }
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
    google_firestore_database.default,
    google_project_iam_member.ai_firestore,
    google_project_iam_member.ai_vertex,
  ]
}

# Public API (Vercel rewrites /api/* here): chat is anonymous or carries the user's Firebase
# token, source changes are checked against the backend, and POST /api/scan needs the
# scheduler's OIDC token or an owner/editor token.
resource "google_cloud_run_v2_service_iam_member" "ai_public" {
  name     = google_cloud_run_v2_service.ai.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Runs one shell command with the AI image, e.g.
#   gcloud run jobs execute exportmate-ai-task --wait --args="node eval/run.js --judge"
# Commands: node seed.js | node rag.js | node scan.js | node eval/run.js | node ops.js
resource "google_cloud_run_v2_job" "ai_task" {
  name                = "exportmate-ai-task"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.ai.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        image   = local.placeholder_image
        command = ["sh", "-c"]
        args    = ["node ops.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        dynamic "env" {
          for_each = local.ai_env
          content {
            name  = env.key
            value = env.value
          }
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
    google_firestore_database.default,
    google_project_iam_member.ai_firestore,
    google_project_iam_member.ai_vertex,
  ]
}

# The daily news scan, OIDC-signed so it skips the 10-minute "Scan now" limit.
resource "google_cloud_scheduler_job" "daily_scan" {
  name             = "exportmate-daily-news-scan"
  region           = var.region
  schedule         = "0 7 * * *"
  time_zone        = "Asia/Ho_Chi_Minh"
  attempt_deadline = "600s"

  http_target {
    http_method = "POST"
    uri         = "${local.ai_url}/api/scan"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.ai_url
    }
  }

  depends_on = [google_cloud_run_v2_service.ai]
}

# AgentOps: metrics from the service's structured logs (ai/server/log.js), for Cloud
# Monitoring charts and alerts. `npm run ops` gives the same picture from the audits.
resource "google_logging_metric" "chat_answers" {
  name        = "exportmate_ai/chat_answers"
  description = "Assistant answers by outcome (ok, needs_review, max_steps, error) and policy version."
  filter      = "${local.ai_logs} AND jsonPayload.message=\"chat.completed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "status"
      value_type = "STRING"
    }

    labels {
      key        = "policy_version"
      value_type = "STRING"
    }
  }

  label_extractors = {
    status         = "EXTRACT(jsonPayload.status)"
    policy_version = "EXTRACT(jsonPayload.policyVersion)"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "chat_latency" {
  name            = "exportmate_ai/chat_latency"
  description     = "Time to a complete assistant answer."
  filter          = "${local.ai_logs} AND jsonPayload.message=\"chat.completed\""
  value_extractor = "EXTRACT(jsonPayload.latencyMs)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 16
      growth_factor      = 1.6
      scale              = 250
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "guard_withheld" {
  name        = "exportmate_ai/guard_withheld"
  description = "Answers where the guard withheld third-party text addressed to the assistant (possible prompt injection)."
  filter      = "${local.ai_logs} AND jsonPayload.message=\"chat.completed\" AND jsonPayload.withheld>0"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "scan_failures" {
  name        = "exportmate_ai/scan_failures"
  description = "News-scan Gemini batches that failed after retries."
  filter      = "${local.ai_logs} AND jsonPayload.message=\"scan.batch_failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}
