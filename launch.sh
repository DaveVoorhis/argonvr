#!/bin/bash

# Start the SECURE HTTP server directly in the background
# Output is redirected to null to keep your NVR console clean
python3 server.py >/dev/null 2>&1 &
SERVER_PID=$!

# Cleanup function to kill the HTTP server when the Python script exits
cleanup() {
  echo -e "\n[$(date '+%Y-%m-%d %H:%M:%S')] 🟢 Terminating HTTP server..."
  kill -TERM "$SERVER_PID" 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "🚀 Starting ArgoNVR..."
echo "🌐 Secure Web UI available at http://localhost:8000"
python3 argonvr.py

# Ensure cleanup runs if the python script exits naturally
cleanup