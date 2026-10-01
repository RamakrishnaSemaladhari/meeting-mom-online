import json
import os
from google.oauth2 import service_account
from googleapiclient.discovery import build

ROOT_FOLDER_ID = "1kfwyuKxXdywPy9jhZjghFI4yGJEwh-Yl"
SCOPES = ["https://www.googleapis.com/auth/drive"]

raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
if not raw:
    raise SystemExit("GOOGLE_SERVICE_ACCOUNT_JSON is missing.")

info = json.loads(raw)
creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
service = build("drive", "v3", credentials=creds, cache_discovery=False)

folder = service.files().get(
    fileId=ROOT_FOLDER_ID,
    fields="id,name,mimeType"
).execute()

print("DRIVE CONNECTION: PASS")
print("Service account:", info.get("client_email"))
print("Accessible folder:", folder.get("name"))
print("Folder ID:", folder.get("id"))
print("Mime type:", folder.get("mimeType"))
