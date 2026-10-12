import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const LOCAL_BACKEND = "http://127.0.0.1:8000";
const LOCAL_AI_SERVICE = "http://127.0.0.1:8080";

export default defineConfig(({ mode, command }) => {
  // BACKEND_URL is the same variable the Vercel /api/v1 proxy (api/backend.ts) reads,
  // so .env.local can point local development at the deployed backend.
  const env = loadEnv(mode, process.cwd(), "");
  // Dev sign-in tokens ("dev:<email>") are only accepted by a local backend with
  // AUTH_MODE=dev, so dev auth always talks to the local backend.
  const backend =
    env.VITE_AUTH_MODE === "dev" ? LOCAL_BACKEND : env.BACKEND_URL || LOCAL_BACKEND;
  const aiService = env.AI_SERVICE_URL || LOCAL_AI_SERVICE;
  if (command === "serve")
    console.info(`[proxy] /api/v1 -> ${backend}   /api -> ${aiService}`);
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api/v1": { target: backend, changeOrigin: true },
        "/api": { target: aiService, changeOrigin: true },
      },
    },
  };
});
