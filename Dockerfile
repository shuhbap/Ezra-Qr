FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Baileys pulls a dependency (libsignal) from GitHub, so git is required at install time
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

COPY . .
RUN mkdir -p /app/sessions && chown -R node:node /app
USER node

ENV PORT=8000 HOST=0.0.0.0
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
