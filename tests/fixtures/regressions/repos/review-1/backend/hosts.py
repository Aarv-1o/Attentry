import os

# The allowed hosts are explicit and configurable:
#
#   ALLOWED_HOSTS=rooms.example.com,api.example.com
#
# Leaving it empty allows localhost only.
def allowed_hosts():
    return [h for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h]
