from pathlib import Path

BLOCKED_SUFFIXES = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
BLOCKED_NAMES = {"meeting_metadata.json", "credentials.json", "token.json"}

root = Path(".")
violations = []

for p in root.rglob("*"):
    if not p.is_file():
        continue
    if p.suffix.lower() in BLOCKED_SUFFIXES or p.name in BLOCKED_NAMES:
        violations.append(str(p))

if violations:
    print("Privacy boundary check: FAIL")
    for item in violations:
        print(item)
    raise SystemExit(1)

print("Privacy boundary check: PASS")
