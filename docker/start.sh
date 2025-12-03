#!/bin/sh
set -e

if [ "${WEB_SEARCH_ENDPOINT}" = "http://localhost:8888/search" ]; then
  echo "Starting embedded SearxNG on port 8888"
  searxng-run --host 0.0.0.0 --port 8888 &
else
  echo "Skipping embedded SearxNG (WEB_SEARCH_ENDPOINT=${WEB_SEARCH_ENDPOINT})"
fi

echo "Starting Claude proxy on port ${PORT:-8080}"
exec node index.js
