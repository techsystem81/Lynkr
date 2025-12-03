# Use a small Node.js base image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install build prerequisites for native modules (better-sqlite3)
RUN apk add --no-cache python3 py3-pip make g++ git

# Install searxng (local search provider)
RUN pip install --no-cache-dir searxng

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source files
COPY index.js ./
COPY src ./src
RUN mkdir -p data
COPY docker/start.sh ./start.sh
RUN chmod +x ./start.sh
VOLUME ["/app/data"]

# Expose the proxy port and searxng port
EXPOSE 8080
EXPOSE 8888

# Provide helpful defaults for required environment variables (override at runtime)
ENV DATABRICKS_API_BASE="https://example.cloud.databricks.com" \
    DATABRICKS_API_KEY="replace-with-databricks-pat" \
    WEB_SEARCH_ENDPOINT="http://localhost:8888/search" \
    WORKSPACE_ROOT="/workspace"

# Run the proxy
CMD ["./start.sh"]
