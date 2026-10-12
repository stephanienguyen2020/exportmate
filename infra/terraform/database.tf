# Postgres on Cloud SQL, plus DATABASE_URL in Secret Manager.

resource "google_sql_database_instance" "main" {
  name             = "exportmate-db"
  database_version = "POSTGRES_16"
  region           = var.region

  # Easy cleanup with `terraform destroy`. Turn on for real customer data.
  deletion_protection = false

  settings {
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_type         = "PD_HDD"
    disk_size         = 10

    backup_configuration {
      enabled = true
      backup_retention_settings {
        retained_backups = 7
      }
    }

    # Public IP with no authorized networks: only the IAM-checked Cloud SQL connector can reach it.
    ip_configuration {
      ipv4_enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "exportmate"
  instance = google_sql_database_instance.main.name
}

# Letters and digits only, so it is safe inside a URL.
resource "random_password" "db_app_user" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "exportmate"
  instance = google_sql_database_instance.main.name
  password = random_password.db_app_user.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "backend-database-url"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  secret_data = format(
    "postgresql+psycopg://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.app.name,
    random_password.db_app_user.result,
    google_sql_database.app.name,
    google_sql_database_instance.main.connection_name,
  )
}

resource "google_secret_manager_secret_iam_member" "backend_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}
