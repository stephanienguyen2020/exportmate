# Neo4j AuraDB as the knowledge graph's read model (backend/app/services/graph_sync.py): the
# backend publishes a change event after each commit that changes the graph; Pub/Sub pushes it
# to POST /api/v1/internal/graph-sync, which copies the change from Postgres into Neo4j. The
# nightly link weights job then syncs everything, catching up any lost event.
#
# The AuraDB instance is made by hand (console.neo4j.io); its password goes in Secret Manager
# by hand, never in Terraform state:
#   printf %s "$PASSWORD" | gcloud secrets create neo4j-password --data-file=-
# neo4j_uri empty: no Neo4j, the walk uses Postgres only.

locals {
  neo4j_enabled = var.neo4j_uri != ""
  # The OIDC audience Pub/Sub signs for and the backend checks (any string works).
  graph_sync_audience = "exportmate-graph-sync"
  graph_env = local.neo4j_enabled ? {
    NEO4J_URI           = var.neo4j_uri
    NEO4J_USERNAME      = var.neo4j_username
    GRAPH_EVENTS_TOPIC  = google_pubsub_topic.graph_changes.id
    GRAPH_SYNC_AUDIENCE = local.graph_sync_audience
    GRAPH_SYNC_INVOKER  = google_service_account.graph_push.email
  } : {}
}

data "google_secret_manager_secret" "neo4j_password" {
  count     = local.neo4j_enabled ? 1 : 0
  secret_id = "neo4j-password"
}

resource "google_secret_manager_secret_iam_member" "backend_reads_neo4j_password" {
  count     = local.neo4j_enabled ? 1 : 0
  secret_id = data.google_secret_manager_secret.neo4j_password[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_pubsub_topic" "graph_changes" {
  name                       = "exportmate-graph-changes"
  message_retention_duration = "86400s"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic_iam_member" "backend_publishes_graph_changes" {
  topic  = google_pubsub_topic.graph_changes.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.backend.email}"
}

# Pub/Sub signs each push with this account's OIDC token; the backend accepts only it.
resource "google_service_account" "graph_push" {
  account_id   = "exportmate-graph-push"
  display_name = "ExportMate graph change events (Pub/Sub push)"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "graph_sync" {
  count = local.neo4j_enabled ? 1 : 0
  name  = "exportmate-graph-sync"
  topic = google_pubsub_topic.graph_changes.id

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.backend.uri}/api/v1/internal/graph-sync"
    oidc_token {
      service_account_email = google_service_account.graph_push.email
      audience              = local.graph_sync_audience
    }
  }

  # Neo4j down (AuraDB Free pauses when idle): try again, backing off up to 10 minutes.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }
}
