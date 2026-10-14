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
  description = "Comma-separated CORS origins for the backend and the AI service."
  type        = string
  default     = "https://exportmate.vercel.app,http://127.0.0.1:5173,http://localhost:5173"
}

variable "resend_enabled" {
  description = "Pass the backend-resend-api-key secret to the backend. Add a version to the secret first."
  type        = bool
  default     = false
}

variable "report_email_from" {
  description = "Sender of emailed order reports; its domain must be verified in Resend."
  type        = string
  default     = "ExportMate <reports@exportmate.app>"
}

variable "auth_domains" {
  description = "Domains allowed to use Firebase sign-in (besides the project's own)."
  type        = list(string)
  default     = ["localhost", "127.0.0.1", "exportmate.vercel.app"]
}

variable "google_oauth_client_id" {
  description = "OAuth web client for Google sign-in (README.md). Empty leaves Google sign-in off."
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  description = "Secret of google_oauth_client_id. Keep it in the git-ignored terraform.tfvars."
  type        = string
  default     = ""
  sensitive   = true
}

variable "gemini_model" {
  description = "Gemini model on Vertex AI for the news scan and the eval judge (gemini-2.5-flash retires 2026-10-20)."
  type        = string
  default     = "gemini-3.5-flash"
}

variable "gemini_model_simple" {
  description = "Gemini model for questions the router (ai/server/router.js) sends to the simple tier: single lookups and how-tos."
  type        = string
  default     = "gemini-3.5-flash-lite"
}

variable "gemini_model_complex" {
  description = "Gemini model for questions the router sends to the complex tier: follow-ups, arithmetic, trade rules, judgement, pasted text."
  type        = string
  default     = "gemini-4-argon"
}
