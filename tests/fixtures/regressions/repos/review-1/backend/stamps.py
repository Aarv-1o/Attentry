from datetime import datetime, timezone


def parsed(stamp):
    if not stamp:
        return None
    try:
        d = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def ts(value):
    """A stored timestamp as an aware datetime, or None if it won't parse.

    `fromisoformat` handles `+00:00` but not a trailing `Z`.
    """
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
