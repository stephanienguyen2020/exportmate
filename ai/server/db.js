import { Firestore } from "@google-cloud/firestore";

export const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "exportmate-app";
export const db = new Firestore({ projectId: PROJECT, ignoreUndefinedProperties: true });

export const inventory = db.collection("inventory");
export const sources = db.collection("sources");
export const articles = db.collection("articles");
export const impacts = db.collection("impacts");
export const scans = db.collection("scans");
// Per company: the shared news sources it switched off ({ disabled: [sourceId] }).
export const companySources = db.collection("companySources");
// One document per lock; "scan" stops two scans running at once across instances.
export const locks = db.collection("locks");

export const list = async (query) => (await query.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
