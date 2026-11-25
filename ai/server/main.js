// One image, two servers: Cloud Run runs the API (index.js); Agent Runtime sets SERVE=runtime
// and runs the agents behind the runtime contract (runtime.js).
if (!process.env.PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) {
  console.error("Set PROJECT_ID (or GOOGLE_CLOUD_PROJECT) to the Google Cloud project this service runs in.");
  process.exit(1);
}
await import(process.env.SERVE === "runtime" ? "./runtime.js" : "./index.js");
