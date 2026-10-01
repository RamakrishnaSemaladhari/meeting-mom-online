#!/usr/bin/env python3
import io, json, os, re, subprocess, sys, tempfile, textwrap
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaFileUpload
from docx import Document

SCOPES = ["https://www.googleapis.com/auth/drive"]
MODEL = "ggml-small-q5_1.bin"
WHISPER = Path("whisper.cpp/build/bin/whisper-cli")

def log(msg):
    print(msg, flush=True)

def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required secret/environment variable is missing: {name}")
    return value

def drive_service():
    raw = require_env("GOOGLE_SERVICE_ACCOUNT_JSON")
    info = json.loads(raw)
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def find_audio(service, audio_folder_id):
    q = f"'{audio_folder_id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    data = service.files().list(
        q=q, pageSize=20,
        fields="files(id,name,mimeType,size,modifiedTime)",
        orderBy="createdTime desc"
    ).execute()
    files = data.get("files", [])
    if not files:
        raise RuntimeError("No audio file was found in the meeting AUDIO folder.")
    return files[0]

def download_file(service, file_id, destination):
    request = service.files().get_media(fileId=file_id)
    with open(destination, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = downloader.next_chunk()

def upload_bytes(service, parent_id, name, data, mime):
    media = MediaFileUpload(data, mimetype=mime, resumable=True)
    meta = {"name": name, "parents": [parent_id]}
    return service.files().create(body=meta, media_body=media, fields="id,name,webViewLink").execute()

def upload_text(service, parent_id, name, text, mime="text/plain"):
    path = Path(tempfile.mktemp(prefix="mom_"))
    path.write_text(text, encoding="utf-8")
    try:
        return upload_bytes(service, parent_id, name, path, mime)
    finally:
        path.unlink(missing_ok=True)

def run(cmd, cwd=None):
    log("$ " + " ".join(map(str, cmd)))
    subprocess.run(cmd, cwd=cwd, check=True)

def whisper_json(audio_wav, output_base, translate=False):
    cmd = [
        str(WHISPER), "-m", f"models/{MODEL}", "-f", str(audio_wav),
        "-l", "auto", "-ojf", "-otxt", "-of", str(output_base), "-t", "4"
    ]
    if translate:
        cmd.insert(6, "-tr")
    run(cmd)
    json_path = Path(str(output_base) + ".json")
    txt_path = Path(str(output_base) + ".txt")
    if not json_path.exists() or not txt_path.exists():
        raise RuntimeError(f"Whisper did not produce expected output for {output_base}")
    return json.loads(json_path.read_text(encoding="utf-8")), txt_path.read_text(encoding="utf-8")

def timestamped_segments(data):
    segments = data.get("transcription") or data.get("segments") or []
    out = []
    for s in segments:
        start = s.get("offsets", {}).get("from", s.get("start", 0))
        end = s.get("offsets", {}).get("to", s.get("end", 0))
        if isinstance(start, (int, float)) and start > 1000:
            start = start / 1000
        if isinstance(end, (int, float)) and end > 1000:
            end = end / 1000
        text = (s.get("text") or "").strip()
        if text:
            out.append({"start": round(float(start or 0), 2), "end": round(float(end or 0), 2), "text": text})
    return out

def ollama_json(transcript, metadata):
    model = "qwen2.5:1.5b-instruct-q3_K_L"
    segments = timestamped_segments(transcript)
    evidence_text = "\n".join(
        f"[{x['start']:.2f}-{x['end']:.2f}] {x['text']}" for x in segments
    )
    if len(evidence_text) > 50000:
        evidence_text = evidence_text[:50000] + "\n[TRANSCRIPT TRUNCATED FOR AI CONTEXT]"
    prompt = f"""
You are the evidence-first meeting understanding engine.

Meeting metadata:
{json.dumps(metadata, ensure_ascii=False, indent=2)}

Timestamped transcript:
{evidence_text}

Return ONLY valid JSON with exactly these keys:
summary, discussion_points, decisions, action_items, commitments, open_questions, next_meeting, review_flags

Rules:
- Never invent facts.
- Suggestion/possibility is NOT a decision.
- A discussed date is NOT a deadline unless explicitly committed.
- If owner is not explicit, use "Not explicitly assigned".
- If deadline is not explicit, use "Not explicitly stated".
- Every decision and action_item must contain timestamp and evidence copied/paraphrased from the transcript.
- Participant metadata must NOT be used as proof of speaker identity.
- Conflicts or ambiguity must go into review_flags.
- Use concise strings/arrays.
- action_items objects: action, owner, deadline, timestamp, evidence.
- decisions objects: decision, timestamp, evidence.
"""
    import urllib.request
    body = json.dumps({
        "model": model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
        "messages": [
            {"role":"system","content":"Return strict JSON only."},
            {"role":"user","content":prompt}
        ]
    }).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat", data=body,
        headers={"Content-Type":"application/json"}
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        result = json.loads(resp.read().decode())
    content = result.get("message", {}).get("content", "")
    return json.loads(content)

def build_mom_doc(metadata, evidence):
    doc = Document()
    doc.add_heading("Minutes of Meeting", level=0)
    doc.add_paragraph(metadata.get("title") or "Meeting")
    table = doc.add_table(rows=0, cols=2)
    for k, label in [
        ("date","Meeting Date"), ("start_time","Start Time"), ("end_time","End Time"),
        ("venue","Venue / Mode"), ("agenda","Agenda")
    ]:
        row = table.add_row().cells
        row[0].text = label
        row[1].text = str(metadata.get(k) or "")
    doc.add_heading("AI Understanding Summary", level=1)
    doc.add_paragraph(evidence.get("summary") or "")
    doc.add_heading("Key Discussions", level=1)
    for x in evidence.get("discussion_points", []):
        doc.add_paragraph(str(x), style="List Bullet")
    doc.add_heading("Decisions", level=1)
    for x in evidence.get("decisions", []):
        doc.add_paragraph(
            f"{x.get('decision','')} — {x.get('timestamp','')} — Evidence: {x.get('evidence','')}",
            style="List Bullet"
        )
    doc.add_heading("Action Items", level=1)
    for x in evidence.get("action_items", []):
        doc.add_paragraph(
            f"Action: {x.get('action','')} | Owner: {x.get('owner','Not explicitly assigned')} | "
            f"Deadline: {x.get('deadline','Not explicitly stated')} | "
            f"Timestamp: {x.get('timestamp','')} | Evidence: {x.get('evidence','')}",
            style="List Bullet"
        )
    doc.add_heading("Pending Follow-up", level=1)
    for x in evidence.get("open_questions", []):
        doc.add_paragraph(str(x), style="List Bullet")
    doc.add_heading("Review Flags", level=1)
    for x in evidence.get("review_flags", []):
        doc.add_paragraph(str(x), style="List Bullet")
    return doc

def main():
    meeting_folder = require_env("MEETING_FOLDER_ID")
    audio_folder = require_env("AUDIO_FOLDER_ID")
    meeting_id = require_env("MEETING_ID")
    service = drive_service()

    with tempfile.TemporaryDirectory(prefix="meeting_mom_") as tmp:
        tmp = Path(tmp)
        log("Downloading meeting audio from Google Drive...")
        audio = find_audio(service, audio_folder)
        source = tmp / audio["name"]
        download_file(service, audio["id"], source)

        log("Converting audio to 16 kHz mono WAV...")
        wav = tmp / "meeting.wav"
        run(["ffmpeg","-y","-i",str(source),"-ar","16000","-ac","1","-c:a","pcm_s16le",str(wav)])

        log("Running Whisper transcription...")
        original_json, original_text = whisper_json(wav, tmp / "transcript", translate=False)

        log("Running Whisper English translation...")
        translated_json, translated_text = whisper_json(wav, tmp / "translation", translate=True)

        log("Loading meeting metadata...")
        meta_files = service.files().list(
            q=f"'{meeting_folder}' in parents and name = 'meeting_metadata.json' and trashed = false",
            pageSize=1, fields="files(id)"
        ).execute().get("files", [])
        if not meta_files:
            raise RuntimeError("meeting_metadata.json was not found.")
        meta_bytes = service.files().get_media(fileId=meta_files[0]["id"]).execute()
        metadata = json.loads(meta_bytes.decode("utf-8"))

        log("Starting local AI understanding...")
        evidence = ollama_json(original_json, metadata)

        log("Preparing validated MoM...")
        doc = build_mom_doc(metadata, evidence)
        docx_path = tmp / "AI_MOM.docx"
        doc.save(docx_path)

        # Locate output folders.
        children = service.files().list(
            q=f"'{meeting_folder}' in parents and trashed = false",
            pageSize=50, fields="files(id,name,mimeType)"
        ).execute().get("files", [])
        folders = {x["name"]: x["id"] for x in children if x["mimeType"] == "application/vnd.google-apps.folder"}

        log("Saving transcript, translation, AI evidence and MoM to Google Drive...")
        upload_text(service, folders["TRANSCRIPT"], f"{metadata.get('title','Meeting')} - Original Transcript.txt", original_text)
        upload_text(service, folders["TRANSCRIPT"], f"{metadata.get('title','Meeting')} - Transcript.json", json.dumps(original_json, ensure_ascii=False, indent=2), "application/json")
        upload_text(service, folders["TRANSLATION"], f"{metadata.get('title','Meeting')} - English Translation.txt", translated_text)
        upload_text(service, folders["TRANSLATION"], f"{metadata.get('title','Meeting')} - Translation.json", json.dumps(translated_json, ensure_ascii=False, indent=2), "application/json")
        upload_text(service, folders["AI"], f"{metadata.get('title','Meeting')} - AI Evidence.json", json.dumps(evidence, ensure_ascii=False, indent=2), "application/json")
        upload_bytes(service, folders["MOM"], f"{metadata.get('title','Meeting')} - AI_MOM.docx", docx_path, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        upload_text(service, folders["MOM"], f"{metadata.get('title','Meeting')} - PROCESSING_COMPLETE.json", json.dumps({"meeting_id":meeting_id,"status":"complete"}, indent=2), "application/json")

    log("PROCESSING COMPLETE")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log("PROCESSING FAILED: " + str(exc))
        raise
