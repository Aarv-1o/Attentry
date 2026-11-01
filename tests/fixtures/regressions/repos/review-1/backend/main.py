from config import API_KEY, WEBHOOK_SECRET
from docx_import import paragraphs
from hosts import allowed_hosts
from runtime import ended
from stamps import parsed, ts


def start():
    return (API_KEY, WEBHOOK_SECRET, paragraphs, ended, allowed_hosts, parsed, ts)


if __name__ == "__main__":
    start()
