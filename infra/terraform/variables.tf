variable "project_id" {
  description = "GCP project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and Artifact Registry."
  type        = string
  default     = "asia-southeast1"
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is the cheapest (~USD 10/month)."
  type        = string
  default     = "db-f1-micro"
}

variable "allowed_origins" {
  description = "Comma-separated CORS origins for the backend."
  type        = string
  default     = "https://exportmate.vercel.app,http://127.0.0.1:5173,http://localhost:5173"
}

variable "auth_domains" {
  description = "Domains allowed to use Firebase sign-in (besides the project's own)."
  type        = list(string)
  default     = ["localhost", "127.0.0.1", "exportmate.vercel.app"]
}
