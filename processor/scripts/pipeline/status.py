"""PROCESSING_STATUS.json writer (spec issues 5 and 6).

Stored in the meeting folder root, where the web app already reads and creates it
(`stage` mirrors `status` for that app). The mobile app never needs GitHub logs. A failed status upload must never break processing.
"""
import datetime
import json
import re
import time
import os
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
                "github_run_id": os.environ.get("GITHUB_RUN_ID", ""),
                "github_run_url": (os.environ.get("GITHUB_SERVER_URL", "https://github.com") + "/" + os.environ.get("GITHUB_REPOSITORY", "") + "/actions/runs/" + os.environ.get("GITHUB_RUN_ID", "")) if os.environ.get("GITHUB_RUN_ID") else "",
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

    def _control_status(self):
        run_id = self.data.get("github_run_id") or os.environ.get("GITHUB_RUN_ID", "")
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
        return {
            "meeting_id": self.data.get("meeting_id", ""),
            "control_status": "FAILED" if self.data.get("status") == "FAILED" else (
                "COMPLETED" if self.data.get("status") == "COMPLETED" else "RUNNING"
            ),
            "github": {
                "run_id": str(run_id),
                "run_url": f"{server}/{repo}/actions/runs/{run_id}" if run_id and repo else "",
                "status": "completed" if self.data.get("status") in ("COMPLETED", "FAILED") else "in_progress",
                "conclusion": "success" if self.data.get("status") == "COMPLETED" else (
                    "failure" if self.data.get("status") == "FAILED" else ""
                )
            },
            "processor": {
                "status": self.data.get("status", ""),
                "stage": self.data.get("stage", ""),
                "progress_percent": self.data.get("progress_percent", 0),
                "message": self.data.get("message", ""),
                "error_code": self.data.get("error_code"),
                "error_message": self.data.get("error_message")
            },
            "updated_at": self.data.get("updated_at", now())
        }

    def _save(self):
        text = json.dumps(self.data, ensure_ascii=False, indent=2)
        self.local_path.parent.mkdir(parents=True, exist_ok=True)
        self.local_path.write_text(text, encoding="utf-8")
        if not self.folder_id:
            return
        last_error = None
        for attempt in range(1, 4):
            try:
                self.store.upsert_text(self.folder_id, STATUS_FILE, text, "application/json")
                self.store.upsert_text(self.folder_id, "CONTROL_STATUS.json",
                                       json.dumps(self._control_status(), ensure_ascii=False, indent=2),
                                       "application/json")
                return
            except Exception as exc:
                last_error = exc
                if attempt < 3:
                    time.sleep(attempt * 2)
        print(f"WARNING [MOM-014] status upload failed after 3 attempts: {sanitize(last_error)}", flush=True)
