import { Firestore } from "@google-cloud/firestore";

// PROJECT_ID first: Agent Runtime sets GOOGLE_CLOUD_PROJECT itself (to the project number).
export const PROJECT = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "skilful-scarab-511320-q9";
// The project whose Gemini quota the assistant, the news scan and the eval judge use; by default
// this one. Everything else (Firestore, RAG Engine, Sessions, Memory Bank) stays in PROJECT.
export const GEMINI_PROJECT = process.env.GEMINI_PROJECT || PROJECT;
export const db = new Firestore({ projectId: PROJECT, ignoreUndefinedProperties: true });

export const sources = db.collection("sources");
export const articles = db.collection("articles");
export const impacts = db.collection("impacts");
export const scans = db.collection("scans");
// Per company: the shared news sources it switched off ({ disabled: [sourceId] }).
export const companySources = db.collection("companySources");
// Per company: its goods for News watch ({ profile, items }), built and refreshed by the backend
// (GET /news-goods); the demo company's are the sample stock (seed.js).
export const goodsByCompany = db.collection("companyGoods");
// Answers already given ({ auditId, expireAt }), keyed by answer-cache.js answerKey.
export const answerCache = db.collection("answer_cache");

export const list = async (query) => (await query.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
/** A company's goods as last stored (no refresh): its items, or none. */
export const storedGoods = async (companyId) => (await goodsByCompany.doc(companyId).get()).get("items") ?? [];
