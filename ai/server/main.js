// One image, two servers: Cloud Run runs the API (index.js); Agent Runtime sets SERVE=runtime
// and runs the agents behind the runtime contract (runtime.js).
await import(process.env.SERVE === "runtime" ? "./runtime.js" : "./index.js");
