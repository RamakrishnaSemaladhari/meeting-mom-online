"""Error codes from the Meeting MoM engineering spec (section 37)."""

ERROR_NAMES = {
    "MOM-001": "Audio not found",
    "MOM-002": "Drive access failure",
    "MOM-003": "Workflow trigger failure",
    "MOM-004": "FFmpeg failure",
    "MOM-005": "Whisper executable failure",
    "MOM-006": "Whisper model failure",
    "MOM-007": "Translation failure",
    "MOM-008": "Ollama unavailable",
    "MOM-009": "AI model unavailable",
    "MOM-010": "AI JSON invalid",
    "MOM-011": "Evidence validation failure",
    "MOM-012": "DOCX generation failure",
    "MOM-013": "Drive upload failure",
    "MOM-014": "Status update failure",
    "MOM-015": "Mobile result retrieval failure",
}

STAGE_DEFAULT_CODE = {
    "whisper": "MOM-005",
    "translation": "MOM-007",
    "ai": "MOM-010",
    "mom": "MOM-012",
    "init": "MOM-002",
}


class MomError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message

    def __str__(self):
        return f"[{self.code}] {self.message}"
