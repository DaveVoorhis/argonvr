#!/bin/bash

# Prefer a local virtual environment if one exists
if [ -x "./.venv/bin/python3" ]; then
  PYTHON_BIN="./.venv/bin/python3"
elif [ -x "./venv/bin/python3" ]; then
  PYTHON_BIN="./venv/bin/python3"
else
  PYTHON_BIN="python3"
fi

# Start the SECURE HTTP server in the background and let it output to the console
"$PYTHON_BIN" server.py &
SERVER_PID=$!

# Give the server a second to print its startup message before the engine logs
sleep 1

# Verify the HTTP server did not crash immediately on startup
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "❌ server.py failed to start. Aborting launch."
  wait "$SERVER_PID" 2>/dev/null
  exit 1
fi

# Cleanup function to kill the HTTP server when the Python script exits
cleanup() {
  trap - SIGINT SIGTERM EXIT
  echo -e "\n[$(date '+%Y-%m-%d %H:%M:%S')] 🟢 Terminating HTTP server..."
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi

  # Restore terminal settings on exit if running in an interactive TTY
  [ -t 0 ] && stty sane

  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

echo "🚀 Starting ArgoNVR Engine..."
"$PYTHON_BIN" argonvr.py