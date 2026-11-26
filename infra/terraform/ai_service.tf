# The AI service (ai/server) in the same project as the backend: Firestore, the Cloud
# Storage bucket RAG Engine imports from, a Cloud Run service (the API in front of the
# agents) and job, the Model Armor template that screens news articles (used by the backend's
# news scan, backend_service.tf) and log-based metrics. Terraform creates the service and job with a placeholder
# image; ai/server/deploy.sh builds the real one and rolls it out. The agents themselves run on
# Agent Platform: ai/server/platform/runtime.py creates the Agent Runtime instance (Sessions,
# Memory Bank) and infra/agent-platform/govern.sh sets up Agent Identity, Agent Registry, the
# egress policies and Agent Gateway; set var.agent_runtime to the instance afterwards.

data "google_project" "this" {}

locals {
  # Cloud Run's deterministic URL, known before the service exists.
  ai_url               = "https://exportmate-ai-${data.google_project.this.number}.${var.region}.run.app"
  model_armor_template = "projects/${var.project_id}/locations/${google_model_armor_template.untrusted_text.location}/templates/${google_model_armor_template.untrusted_text.template_id}"

  ai_env = {
    GOOGLE_CLOUD_PROJECT  = var.project_id
    PROJECT_ID            = var.project_id
    GOOGLE_CLOUD_LOCATION = "global" # Vertex AI endpoint for Gemini and the embedding model
    GEMINI_MODEL          = var.gemini_model
    GEMINI_PROJECT        = var.gemini_project
    ALLOWED_ORIGINS       = var.allowed_origins
    BACKEND_URL           = google_cloud_run_v2_service.backend.uri
    RAG_BUCKET            = google_storage_bucket.kb.name
    # Chats go to the agents on Agent Runtime once the instance exists (empty: in-process).
    AGENT_RUNTIME = var.agent_runtime
    AGENTS_AT     = var.agent_runtime == "" ? "" : "runtime"
  }

  # One chat.completed line per answer: the backend's assistant routes write it, as the AI
  # service's /api/chat did until it was switched off.
  chat_logs = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=(\"exportmate-ai\" OR \"exportmate-backend\")"
}

# Stock, news sources, articles, alerts, scans, RAG file records, audits, the answer cache,
# chat session map and eval runs.
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # `terraform destroy` leaves the data in place.
  deletion_policy = "ABANDON"

  depends_on = [google_project_service.apis]
}

# Search runs on RAG Engine (ai/server/rag.js): every searchable record is a text file in this
# bucket, imported into one RAG corpus per type. RAG Engine reads it as its own service agent.
resource "google_storage_bucket" "kb" {
  name                        = "${var.project_id}-kb"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "kb_rag_reader" {
  # RAG Engine's service agent only exists once RAG Engine has been used (the first index run).
  count  = var.rag_service_agent_ready ? 1 : 0
  bucket = google_storage_bucket.kb.name
  role   = "roles/storage.objectViewer"
  # Created when RAG Engine is first used in the project (the first `npm run index`).
  member = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-vertex-rag.iam.gserviceaccount.com"
}

# `npm run index` and seeding (Cloud Run job) write the files RAG Engine imports.
resource "google_storage_bucket_iam_member" "kb_ai_writer" {
  bucket = google_storage_bucket.kb.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ai.email}"
}

# So does the backend's news scan, for its new articles and alerts and the sources.
resource "google_storage_bucket_iam_member" "kb_backend_writer" {
  bucket = google_storage_bucket.kb.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.backend.email}"
}

# Agent Runtime pulls the agents' container image (the same image as the Cloud Run service).
resource "google_artifact_registry_repository_iam_member" "agent_runtime_pull" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
}

# Browser session → Agent Platform session map (ai/server/agents/platform.js), cleaned up a
# month after the session's last use.
resource "google_firestore_field" "chat_sessions_ttl" {
  database   = google_firestore_database.default.name
  collection = "chat_sessions"
  field      = "expireAt"

  ttl_config {}
  index_config {}
}

# Answers already given (ai/server/answer-cache.js) are deleted once expireAt passes. Keys
# carry the date, so an entry stops matching after a day anyway; this only cleans up.
resource "google_firestore_field" "answer_cache_ttl" {
  database   = google_firestore_database.default.name
  collection = "answer_cache"
  field      = "expireAt"

  ttl_config {}
  # Single-field indexes on this field aren't needed.
  index_config {}
}

# Screens each new news article before Gemini or the search index sees it (the backend's
# core/model_armor.py, called by services/news_scan.py): prompt injection and jailbreaks, and links to known-malicious sites.
# Medium confidence and above; a withheld article is recorded with what matched. It lives in
# var.model_armor_region because asia-southeast1 doesn't offer the malicious-link filter.
resource "google_model_armor_template" "untrusted_text" {
  location    = var.model_armor_region
  template_id = "exportmate-untrusted-text"

  filter_config {
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }

    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
  }

  template_metadata {
    # Not every feed is in English.
    multi_language_detection {
      enable_multi_language_detection = true
    }
  }

  depends_on = [google_project_service.apis]
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

# Starts the daily news scan and the nightly link weights jobs (backend_service.tf).
resource "google_service_account" "scheduler" {
  account_id   = "exportmate-scheduler"
  display_name = "Cloud Scheduler: daily news scan, nightly link weights"

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

# Public API (the website forwards /api/* here): chat is anonymous or carries the user's Firebase
# token, which the backend checks.
resource "google_cloud_run_v2_service_iam_member" "ai_public" {
  name     = google_cloud_run_v2_service.ai.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Runs one shell command with the AI image, e.g.
#   gcloud run jobs execute exportmate-ai-task --wait --args="node eval/run.js --judge"
# Commands: node seed.js | node rag.js | node eval/run.js | node ops.js
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

# AgentOps: metrics from the service's structured logs (ai/server/log.js), for Cloud
# Monitoring charts and alerts. `npm run ops` gives the same picture from the audits.
resource "google_logging_metric" "chat_answers" {
  name        = "exportmate_ai/chat_answers"
  description = "Assistant answers by outcome (ok, needs_review, max_steps, error) and policy version."
  filter      = "${local.chat_logs} AND jsonPayload.message=\"chat.completed\""

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
  filter          = "${local.chat_logs} AND jsonPayload.message=\"chat.completed\""
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
  filter      = "${local.chat_logs} AND jsonPayload.message=\"chat.completed\" AND jsonPayload.withheld>0"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "armor_failures" {
  name        = "exportmate_ai/armor_failures"
  description = "News scans where Model Armor could not screen some articles (they wait for the next scan)."
  filter      = "${local.news_scan_logs} AND jsonPayload.message=\"scan.armor_failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "scan_failures" {
  name        = "exportmate_ai/scan_failures"
  description = "News-scan Gemini batches that failed after retries."
  filter      = "${local.news_scan_logs} AND jsonPayload.message=\"scan.batch_failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.apis]
}
