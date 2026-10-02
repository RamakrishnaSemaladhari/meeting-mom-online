"""PROCESSING_STATUS.json writer (spec issues 5 and 6).

Stored in the meeting folder root, where the web app already reads and creates it
(`stage` mirrors `status` for that app). The mobile app never needs GitHub logs. A failed status upload must never break processing.
"""
import datetime
import json
import re
from pathlib import Path

STATUS_FILE = "PROCESSING_STATUS.json"
STATES = [
    "QUEUED", "DOWNLOADING", "CONVERTING", "TRANSCRIBING", "TRANSLATING",
    "ANALYZING", "SUMMARIZING", "GENERATING_MOM", "UPLOADING", "COMPLETED", "FAILED",
]
PROGRESS = {
    "QUEUED": 0, "DOWNLOADING": 5, "CONVERTING": 10, "TRANSCRIBING": 15,
    "TRANSLATING": 45, "ANALYZING": 60, "SUMMARIZING": 78,
    "GENERATING_MOM": 88, "UPLOADING": 95, "COMPLETED": 100,
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def sanitize(message):
    text = str(message)
    text = re.sub(r"-----BEGIN[\s\S]*?(-----END[^-]*-----|$)", "[redacted key]", text)
    text = re.sub(r'("private_key"\s*:\s*")[^"]*', r"\1[redacted]", text)
    return text[:500]


class StatusReporter:
    def __init__(self, store, status_folder_id, meeting_id, local_path, stage=""):
        self.store = store
        self.folder_id = status_folder_id
        self.local_path = Path(local_path)
        self.stage = stage
        if self.local_path.exists():
            self.data = json.loads(self.local_path.read_text(encoding="utf-8"))
        else:
            self.data = {
                "meeting_id": meeting_id, "status": "QUEUED", "stage": "QUEUED",
                "progress_percent": 0, "current_stage": "", "message": "", "started_at": now(),
                "updated_at": now(), "completed_at": None,
                "error_code": None, "error_message": None,
            }

    def reset(self):
        self.local_path.unlink(missing_ok=True)
        self.data.update({
            "status": "QUEUED", "stage": "QUEUED", "progress_percent": 0,
            "current_stage": "", "message": "", "started_at": now(), "completed_at": None,
            "error_code": None, "error_message": None,
        })

    def update(self, state, message="", progress=None, **extra):
        if state not in STATES:
            raise ValueError(f"Unknown status state: {state}")
        if progress is None:
            progress = PROGRESS.get(state, self.data.get("progress_percent", 0))
        self.data.update({
            "status": state, "stage": state, "progress_percent": progress,
            "current_stage": self.stage or state, "message": sanitize(message),
            "updated_at": now(),
        })
        if state == "COMPLETED":
            self.data["completed_at"] = now()
        self.data.update(extra)
        self._save()

    def fail(self, code, message):
        self.data.update({
            "status": "FAILED", "stage": "FAILED", "current_stage": self.stage or "FAILED",
            "message": "Processing failed", "updated_at": now(),
            "completed_at": now(), "error_code": code,
            "error_message": sanitize(message),
        })
        self._save()

    def _save(self):
        text = json.dumps(self.data, ensure_ascii=False, indent=2)
        self.local_path.parent.mkdir(parents=True, exist_ok=True)
        self.local_path.write_text(text, encoding="utf-8")
        if not self.folder_id:
            return
        try:
            self.store.upsert_text(self.folder_id, STATUS_FILE, text, "application/json")
        except Exception as exc:
            print(f"WARNING [MOM-014] status upload failed: {sanitize(exc)}", flush=True)
