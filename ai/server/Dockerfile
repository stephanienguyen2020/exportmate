# Cloud Run image for the AI service. The same image runs the one-off commands
# (seed, index, scan, eval, ops, copy-firestore) as the exportmate-ai-task job.
# Settings come from environment variables; credentials from the service account.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node

# Cloud Run sets PORT (8080 by default).
CMD ["node", "index.js"]
