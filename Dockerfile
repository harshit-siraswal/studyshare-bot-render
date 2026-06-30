FROM node:22-bookworm-slim

WORKDIR /app

# Install system dependencies: Chromium, Python3, pip, Tesseract OCR
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium python3 python3-pip tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

# Copy package files and install Node dependencies
COPY package.json package-lock.json tsconfig.json ./
RUN npm install

# Copy source code and build to dist/
COPY src ./src
RUN npx tsc -p tsconfig.json

# Copy static assets
COPY chat /app/chat
COPY extractor /app/extractor
COPY prompts /app/prompts
COPY db/init /app/db/init

# Install Python dependencies for OCR
RUN pip3 install --break-system-packages --no-cache-dir -r /app/extractor/requirements.txt

# Render provides PORT env var; default to 8080 for local testing
ENV PORT=8080
EXPOSE 8080

# Run compiled JS in production
CMD ["node", "--enable-source-maps", "dist/index.js"]
