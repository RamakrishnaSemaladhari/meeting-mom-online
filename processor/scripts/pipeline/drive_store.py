"""Thin Google Drive wrapper.  All Drive access goes through here so the rest
of the pipeline can be tested with a fake store."""
import io
import json
import os
from pathlib import Path

from .errors import MomError

FOLDER = "application/vnd.google-apps.folder"
SCOPES = ["https://www.googleapis.com/auth/drive"]
FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,parents,trashed"


class DriveStore:
    def __init__(self, service):
        self.svc = service

    @classmethod
    def from_env(cls):
        raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
        if not raw:
            raise MomError("MOM-002", "GOOGLE_SERVICE_ACCOUNT_JSON is not configured.")
        try:
            info = json.loads(raw)
        except ValueError:
            raise MomError("MOM-002", "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.")
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        return cls(build("drive", "v3", credentials=creds, cache_discovery=False))

    @staticmethod
    def _q(value):
        return value.replace("\\", "\\\\").replace("'", "\\'")

    def list_children(self, parent_id, name=None, folders=None):
        q = [f"'{parent_id}' in parents", "trashed = false"]
        if name:
            q.append(f"name = '{self._q(name)}'")
        if folders is True:
            q.append(f"mimeType = '{FOLDER}'")
        elif folders is False:
            q.append(f"mimeType != '{FOLDER}'")
        files, token = [], None
        try:
            while True:
                resp = self.svc.files().list(
                    q=" and ".join(q), pageSize=100, pageToken=token,
                    fields=f"nextPageToken, files({FIELDS})", orderBy="createdTime desc",
                    supportsAllDrives=True, includeItemsFromAllDrives=True,
                ).execute()
                files.extend(resp.get("files", []))
                token = resp.get("nextPageToken")
                if not token:
                    return files
        except MomError:
            raise
        except Exception as exc:
            raise MomError("MOM-002", f"Drive listing failed: {exc}")

    def find_one(self, parent_id, name):
        found = self.list_children(parent_id, name=name)
        return found[0] if found else None

    def ensure_folder(self, parent_id, name):
        found = self.list_children(parent_id, name=name, folders=True)
        if found:
            return found[0]["id"]
        try:
            created = self.svc.files().create(
                body={"name": name, "mimeType": FOLDER, "parents": [parent_id]},
                fields="id", supportsAllDrives=True).execute()
            return created["id"]
        except Exception as exc:
            raise MomError("MOM-002", f"Could not create Drive folder {name}: {exc}")

    def get_meta(self, file_id):
        try:
            return self.svc.files().get(fileId=file_id, fields=FIELDS, supportsAllDrives=True).execute()
        except Exception as exc:
            raise MomError("MOM-001", f"Audio file {file_id} could not be read from Drive: {exc}")

    def download(self, file_id, destination):
        from googleapiclient.http import MediaIoBaseDownload
        try:
            request = self.svc.files().get_media(fileId=file_id, supportsAllDrives=True)
            with open(destination, "wb") as fh:
                dl = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
                done = False
                while not done:
                    _, done = dl.next_chunk()
        except Exception as exc:
            raise MomError("MOM-002", f"Drive download failed: {exc}")

    def read_bytes(self, file_id):
        try:
            return self.svc.files().get_media(fileId=file_id, supportsAllDrives=True).execute()
        except Exception as exc:
            raise MomError("MOM-002", f"Drive read failed: {exc}")

    def read_json(self, parent_id, name):
        meta = self.find_one(parent_id, name)
        if not meta:
            raise MomError("MOM-002", f"{name} was not found in the Drive folder.")
        return json.loads(self.read_bytes(meta["id"]).decode("utf-8"))

    def _upsert(self, parent_id, name, media):
        try:
            existing = self.find_one(parent_id, name)
            if existing:
                return self.svc.files().update(
                    fileId=existing["id"], media_body=media,
                    fields="id,name,webViewLink", supportsAllDrives=True).execute()
            return self.svc.files().create(
                body={"name": name, "parents": [parent_id]}, media_body=media,
                fields="id,name,webViewLink", supportsAllDrives=True).execute()
        except Exception as exc:
            raise MomError("MOM-013", f"Drive upload of {name} failed: {exc}")

    def upsert_text(self, parent_id, name, text, mime="text/plain"):
        from googleapiclient.http import MediaIoBaseUpload
        media = MediaIoBaseUpload(io.BytesIO(text.encode("utf-8")), mimetype=mime, resumable=True)
        return self._upsert(parent_id, name, media)

    def upsert_file(self, parent_id, name, path, mime):
        from googleapiclient.http import MediaFileUpload
        return self._upsert(parent_id, name, MediaFileUpload(str(Path(path)), mimetype=mime, resumable=True))


def choose_audio(files, strict=False):
    if not files:
        raise MomError("MOM-001", "No audio file was found in the meeting AUDIO folder.")
    if len(files) == 1:
        return files[0], []
    if strict:
        raise MomError("MOM-001", (
            f"{len(files)} files exist in the AUDIO folder and no AUDIO_FILE_ID was supplied; "
            "refusing to guess which recording to process."))
    newest = sorted(files, key=lambda f: f.get("createdTime", ""), reverse=True)[0]
    return newest, [
        f"AUDIO_FILE_ID not supplied and {len(files)} files exist in the AUDIO folder; "
        f"processed the newest ({newest.get('name')}). Verify this is the intended recording."]


def select_audio(store, audio_folder_id, audio_file_id="", strict=False):
    if audio_file_id:
        meta = store.get_meta(audio_file_id)
        if meta.get("trashed") or meta.get("mimeType") == FOLDER:
            raise MomError("MOM-001", "AUDIO_FILE_ID does not point to a usable audio file.")
        parents = meta.get("parents") or []
        if parents and audio_folder_id not in parents:
            raise MomError("MOM-001", "AUDIO_FILE_ID is not inside the meeting AUDIO folder.")
        return meta, []
    return choose_audio(store.list_children(audio_folder_id, folders=False), strict)
