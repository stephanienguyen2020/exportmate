# The assistant's agents (runtime.js) on Agent Runtime. The same image runs the AI commands
# (seed, index, eval, ops) as the exportmate-ai-task Cloud Run job.
# Settings come from environment variables; credentials from the service account.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node

# Agent Runtime sets PORT and, behind Agent Gateway, AGENT_GATEWAY_CA (docker-entrypoint.sh).
CMD ["sh", "docker-entrypoint.sh"]
