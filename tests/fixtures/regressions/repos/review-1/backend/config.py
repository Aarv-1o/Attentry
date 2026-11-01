import os

# Empty means "not set": billing stays off without them.
API_KEY = os.environ.get("BILLING_API_KEY", "").strip()
WEBHOOK_SECRET = os.environ.get("BILLING_WEBHOOK_SECRET", "").strip()
