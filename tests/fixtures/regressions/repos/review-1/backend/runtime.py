def ended(db, task_id):
    try:
        db.update("tasks", {"status": "error"}, task_id)
    except Exception:  # noqa: BLE001 the DB is already failing: keep the first error
        pass
