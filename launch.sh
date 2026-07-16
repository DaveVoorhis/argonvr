#!/bin/bash

# Start the SECURE HTTP server in the background and let it output to the console
python3 server.py &
SERVER_PID=$!

# Give the server a second to print its startup message before the engine logs
sleep 1

# Cleanup function to kill the HTTP server when the Python script exits
cleanup() {
  echo -e "\n[$(date '+%Y-%m-%d %H:%M:%S')] 🟢 Terminating HTTP server..."
  kill -TERM "$SERVER_PID" 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "🚀 Starting ArgoNVR Engine..."
python3 argonvr.py

# Ensure cleanup runs if the python script exits naturally
cleanup