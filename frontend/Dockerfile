# The website on Cloud Run (infra/terraform/web_service.tf): the Vite build, served by nginx, which
# forwards /api/v1 to the backend and /api to the AI service as Vercel does (vercel.json,
# api/backend.ts). Built on Cloud Build by deploy.sh, which passes the Firebase web config.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
RUN npm run build

FROM nginx:1.27-alpine
# Rendered at start (envsubst) with PORT, set by Cloud Run, and BACKEND_HOST and AI_HOST.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV PORT=8080
