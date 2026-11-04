import os
import time
import urllib.request
from urllib.error import URLError, HTTPError
import ssl
import yaml
try:
    import sdnotify
except ImportError:
    sdnotify = None

CHECK_INTERVAL = 10  # Seconds between checks
TIMEOUT = 5          # Maximum seconds to wait for a response


def get_health_url():
    try:
        with open('argonvr.yaml', 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f) or {}
        settings = config.get('SETTINGS', {})
        port = int(settings.get('PORT', 8000))
        ssl_cert = settings.get('SSL_CERT_PATH', '')
        ssl_key = settings.get('SSL_KEY_PATH', '')
        use_https = bool(ssl_cert and ssl_key and os.path.exists(ssl_cert) and os.path.exists(ssl_key))
        scheme = "https" if use_https else "http"
        return f"{scheme}://127.0.0.1:{port}/health"
    except Exception:
        return "https://localhost/health"


def start_watchdog():
    notifier = sdnotify.SystemdNotifier() if sdnotify is not None else None
    health_url = get_health_url()

    # Create a custom SSL context that disables verification for localhost self-signed certs
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE

    print(f"Watchdog started. Polling {health_url} every {CHECK_INTERVAL}s (Ignoring SSL).")

    while True:
        try:
            ctx = ssl_context if health_url.startswith("https://") else None
            with urllib.request.urlopen(
                    health_url,
                    timeout=TIMEOUT,
                    context=ctx
            ) as response:
                response.read()
                if response.getcode() == 200:
                    if notifier is not None:
                        notifier.notify("WATCHDOG=1")
                else:
                    print(f"Watchdog failed: Server returned HTTP {response.getcode()}")

        except HTTPError as e:
            print(f"Watchdog failed: HTTP Error {e.code}")
        except URLError as e:
            print(f"Watchdog failed: Server unreachable or timed out. {e.reason}")
        except Exception as e:
            print(f"Watchdog failed: Unexpected error: {e}")

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    start_watchdog()