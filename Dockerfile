FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Default state directory — override with STATE_DIR env var + a Railway volume at /data
ENV STATE_DIR=/data

CMD ["npx", "tsx", "src/index.ts"]
