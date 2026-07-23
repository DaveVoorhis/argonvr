import time
import urllib.request
from urllib.error import URLError, HTTPError
import sdnotify
import ssl

HEALTH_URL = "https://localhost/health"
CHECK_INTERVAL = 10  # Seconds between checks
TIMEOUT = 5          # Maximum seconds to wait for a response

def start_watchdog():
    # Initialize the systemd notifier
    notifier = sdnotify.SystemdNotifier()

    # 1. Create a custom SSL context that disables verification
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    print(f"Watchdog started. Polling {HEALTH_URL} every {CHECK_INTERVAL}s (Ignoring SSL).")

    while True:
        try:
            # 2. Pass the unverified context to urlopen
            response = urllib.request.urlopen(
                HEALTH_URL,
                timeout=TIMEOUT,
                context=ssl_context
            )

            # If we get an HTTP 200 OK, the server is alive
            if response.getcode() == 200:
                notifier.notify("WATCHDOG=1")
            else:
                print(f"Watchdog failed: Server returned HTTP {response.getcode()}")

        except HTTPError as e:
            print(f"Watchdog failed: HTTP Error {e.code}")
        except URLError as e:
            print(f"Watchdog failed: Server unreachable or timed out. {e.reason}")
        except Exception as e:
            print(f"Watchdog failed: Unexpected error: {e}")

        # Wait before the next check
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    start_watchdog()