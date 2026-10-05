import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

ROOT_FOLDER_ID = "1kfwyuKxXdywPy9jhZjghFI4yGJEwh-Yl"
MEETING_FOLDER_ID = os.environ.get("MEETING_FOLDER_ID", "")
AUDIO_FOLDER_ID = os.environ.get("AUDIO_FOLDER_ID", "")
SCOPES = ["https://www.googleapis.com/auth/drive"]

refresh_token = os.environ.get("GOOGLE_OAUTH_REFRESH_TOKEN", "").strip()
client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()

if not refresh_token or not client_id or not client_secret:
    raise SystemExit(
        "Google Drive OAuth is not fully configured. "
        "Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN."
    )

creds = Credentials(
    token=None,
    refresh_token=refresh_token,
    token_uri="https://oauth2.googleapis.com/token",
    client_id=client_id,
    client_secret=client_secret,
    scopes=SCOPES,
)
service = build("drive", "v3", credentials=creds, cache_discovery=False)

folder = service.files().get(
    fileId=ROOT_FOLDER_ID,
    fields="id,name,mimeType"
).execute()

print("DRIVE CONNECTION: PASS")
print("Authentication: Google OAuth 2.0")
print("Accessible folder:", folder.get("name"))
print("Folder ID:", folder.get("id"))
print("Mime type:", folder.get("mimeType"))

def check_file(label, file_id):
    if not file_id:
        print(label + ": NOT PROVIDED")
        return
    try:
        item = service.files().get(
            fileId=file_id,
            fields="id,name,mimeType,parents,trashed"
        ).execute()
        print(label + ": PASS")
        print("  name:", item.get("name"))
        print("  id:", item.get("id"))
        print("  mimeType:", item.get("mimeType"))
        print("  parents:", item.get("parents"))
        print("  trashed:", item.get("trashed"))
    except Exception as exc:
        print(label + ": FAIL")
        print("  id:", file_id)
        print("  error:", exc)
        raise

check_file("MEETING FOLDER", MEETING_FOLDER_ID)
check_file("AUDIO FOLDER", AUDIO_FOLDER_ID)
