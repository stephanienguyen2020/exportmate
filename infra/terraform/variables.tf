variable "project_id" {
  description = "GCP project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and Artifact Registry."
  type        = string
  default     = "asia-southeast1"
}

variable "contact_inbox" {
  description = "Where the public contact form (POST /api/v1/contact) is emailed. Delivered only once the backend has a Resend key."
  type        = string
  default     = "dylan.exportmate@gmail.com"
}

variable "model_armor_region" {
  description = "Region of the Model Armor template. asia-southeast1 lacks the malicious-link filter and multi-language detection; the scan only sends public news articles there."
  type        = string
  default     = "us-central1"
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
  description = "Pass the backend-resend-api-key secret to the backend (it needs a version, added by hand). false: email in sandbox mode."
  type        = bool
  default     = true
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
  description = "Gemini model on Vertex AI for the backend's AI features, the news scan and the eval judge (gemini-2.5-flash retires 2026-10-20)."
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

variable "agent_runtime" {
  description = "The agents' Agent Runtime instance (projects/…/locations/…/reasoningEngines/…), printed by ai/server/platform/runtime.py deploy. Empty: the Cloud Run service runs the agents itself. The default is this project's instance, so an apply from any machine keeps chats on it; set it to \"\" for a new project until its instance exists."
  type        = string
  default     = "projects/360016804920/locations/asia-southeast1/reasoningEngines/8488414484384186368"
}

variable "rag_service_agent_ready" {
  description = "Set to true after the first `node rag.js` run has created RAG Engine's service agent; it then gets read access to the RAG bucket. True for skilful-scarab; false for a new project until then."
  type        = bool
  default     = true
}
