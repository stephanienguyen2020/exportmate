import { Firestore } from "@google-cloud/firestore";

// PROJECT_ID first: Agent Runtime sets GOOGLE_CLOUD_PROJECT itself (to the project number).
export const PROJECT = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "skilful-scarab-511320-q9";
export const db = new Firestore({ projectId: PROJECT, ignoreUndefinedProperties: true });

export const inventory = db.collection("inventory");
export const sources = db.collection("sources");
export const articles = db.collection("articles");
export const impacts = db.collection("impacts");
export const scans = db.collection("scans");
// Per company: the shared news sources it switched off ({ disabled: [sourceId] }).
export const companySources = db.collection("companySources");
// Per company: its goods for News watch (goods.js), refreshed by goods-store.js.
export const goodsByCompany = db.collection("companyGoods");
// One document per lock; "scan" stops two scans running at once across instances.
export const locks = db.collection("locks");
// Answers already given ({ auditId, expireAt }), keyed by answer-cache.js answerKey.
export const answerCache = db.collection("answer_cache");

export const list = async (query) => (await query.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
