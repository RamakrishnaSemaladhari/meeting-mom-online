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
    media = MediaFileUpload(str(data), mimetype=mime, resumable=True)
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
        str(WHISPER), "-m", f"whisper.cpp/models/{MODEL}", "-f", str(audio_wav),
        "-l", "auto", "-ojf", "-otxt", "-of", str(output_base), "-t", "4"
    ]
    if translate:
        cmd.append("-tr")
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

def ollama_request(model, prompt):
    import urllib.request
    body = json.dumps({
        "model": model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
        "messages": [
            {"role":"system","content":"Return strict JSON only. No markdown and no commentary."},
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
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        repair_prompt = (
            "Convert the following model output into valid JSON using exactly these keys: "
            "summary, discussion_points, decisions, action_items, commitments, open_questions, "
            "next_meeting, review_flags. Preserve the factual content and do not invent anything. "
            "Return JSON only.\n\nMODEL OUTPUT:\n" + content
        )
        with urllib.request.urlopen(
            urllib.request.Request(
                "http://127.0.0.1:11434/api/chat",
                data=json.dumps({
                    "model": model,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0},
                    "messages": [
                        {"role":"system","content":"Return strict JSON only."},
                        {"role":"user","content":repair_prompt}
                    ]
                }).encode(),
                headers={"Content-Type":"application/json"}
            ),
            timeout=900
        ) as resp:
            repaired = json.loads(resp.read().decode())
        return json.loads(repaired.get("message", {}).get("content", "{}"))

def evidence_prompt(metadata, evidence_text):
    return f"""
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
- Preserve explicit commitments and follow-up items.
- Use concise strings/arrays.
- action_items objects: action, owner, deadline, timestamp, evidence.
- decisions objects: decision, timestamp, evidence.
- commitments objects: commitment, owner, deadline, timestamp, evidence.
- next_meeting should contain only explicitly stated next-meeting information.
"""

def ollama_json(transcript, metadata):
    model = os.environ.get("AI_MODEL", "qwen2.5:1.5b-instruct-q3_K_L")
    segments = timestamped_segments(transcript)
    if not segments:
        raise RuntimeError("Whisper produced no timestamped transcript segments.")

    lines = [
        f"[{x['start']:.2f}-{x['end']:.2f}] {x['text']}"
        for x in segments
    ]
    full_text = "\n".join(lines)

    # Keep individual AI requests comfortably below the model context limit.
    chunk_size = 12000
    chunks = []
    current = []
    current_len = 0
    for line in lines:
        if current and current_len + len(line) + 1 > chunk_size:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
        current.append(line)
        current_len += len(line) + 1
    if current:
        chunks.append("\n".join(current))

    partials = []
    for index, chunk in enumerate(chunks, start=1):
        log(f"AI evidence pass {index}/{len(chunks)}...")
        partials.append(ollama_request(model, evidence_prompt(metadata, chunk)))

    if len(partials) == 1:
        return partials[0]

    # Consolidate chunk-level evidence. The consolidation input is much smaller
    # than the original transcript because it contains extracted evidence only.
    consolidation = f"""
You are consolidating evidence extracted from {len(partials)} transcript sections of one meeting.

Meeting metadata:
{json.dumps(metadata, ensure_ascii=False, indent=2)}

Section evidence:
{json.dumps(partials, ensure_ascii=False, indent=2)}

Return ONLY valid JSON with exactly these keys:
summary, discussion_points, decisions, action_items, commitments, open_questions, next_meeting, review_flags

Rules:
- Combine overlapping items without losing explicit evidence.
- Never invent or strengthen a fact.
- Preserve timestamps and evidence for every decision/action/commitment.
- Suggestion/possibility is NOT a decision.
- A discussed date is NOT a deadline unless explicitly committed.
- Missing owner -> "Not explicitly assigned".
- Missing deadline -> "Not explicitly stated".
- Participant metadata is never proof of speaker identity.
- Preserve conflicts and uncertainty in review_flags.
"""
    log("AI evidence consolidation pass...")
    return ollama_request(model, consolidation)


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
    doc.add_heading("Commitments", level=1)
    for x in evidence.get("commitments", []):
        doc.add_paragraph(
            f"{x.get('commitment','')} | Owner: {x.get('owner','Not explicitly assigned')} | "
            f"Deadline: {x.get('deadline','Not explicitly stated')} | Timestamp: {x.get('timestamp','')} | "
            f"Evidence: {x.get('evidence','')}",
            style="List Bullet"
        )
    doc.add_heading("Pending Follow-up", level=1)
    for x in evidence.get("open_questions", []):
        doc.add_paragraph(str(x), style="List Bullet")
    doc.add_heading("Next Meeting", level=1)
    next_meeting = evidence.get("next_meeting")
    if isinstance(next_meeting, list):
        for x in next_meeting:
            doc.add_paragraph(str(x), style="List Bullet")
    elif next_meeting:
        doc.add_paragraph(str(next_meeting))
    doc.add_heading("Review Flags", level=1)
    for x in evidence.get("review_flags", []):
        doc.add_paragraph(str(x), style="List Bullet")
    return doc

def metadata_from_drive(service, meeting_folder):
    meta_files = service.files().list(
        q=f"'{meeting_folder}' in parents and name = 'meeting_metadata.json' and trashed = false",
        pageSize=1, fields="files(id)"
    ).execute().get("files", [])
    if not meta_files:
        raise RuntimeError("meeting_metadata.json was not found.")
    raw = service.files().get_media(fileId=meta_files[0]["id"]).execute()
    return json.loads(raw.decode("utf-8"))

def output_folders(service, meeting_folder):
    children = service.files().list(
        q=f"'{meeting_folder}' in parents and trashed = false",
        pageSize=50, fields="files(id,name,mimeType)"
    ).execute().get("files", [])
    return {x["name"]: x["id"] for x in children if x["mimeType"] == "application/vnd.google-apps.folder"}

def stage_paths():
    root = Path(".meeting_work")
    root.mkdir(exist_ok=True)
    return {
        "root": root,
        "source": root / "source_audio",
        "wav": root / "meeting.wav",
        "transcript_json": root / "transcript.json",
        "transcript_txt": root / "transcript.txt",
        "translation_json": root / "translation.json",
        "translation_txt": root / "translation.txt",
        "evidence": root / "evidence.json",
        "mom": root / "AI_MOM.docx",
    }

def stage_download(service, audio_folder_id, paths):
    audio = find_audio(service, audio_folder_id)
    log("Downloading meeting audio from Google Drive: " + audio["name"])
    download_file(service, audio["id"], paths["source"])
    log("Converting audio to 16 kHz mono WAV...")
    run(["ffmpeg","-y","-i",str(paths["source"]),"-ar","16000","-ac","1","-c:a","pcm_s16le",str(paths["wav"])])

def stage_whisper(service, audio_folder_id, transcript_folder_id, paths):
    if not paths["wav"].exists():
        stage_download(service, audio_folder_id, paths)
    log("Running Whisper transcription...")
    data, text = whisper_json(paths["wav"], paths["root"] / "transcript", translate=False)
    paths["transcript_json"].write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["transcript_txt"].write_text(text, encoding="utf-8")
    upload_text(service, transcript_folder_id, "Original Transcript.txt", text)
    upload_text(service, transcript_folder_id, "Transcript.json", json.dumps(data, ensure_ascii=False, indent=2), "application/json")

def stage_translation(service, translation_folder_id, paths):
    if not paths["wav"].exists():
        raise RuntimeError("WAV audio is missing before translation stage.")
    log("Running Whisper English translation...")
    data, text = whisper_json(paths["wav"], paths["root"] / "translation", translate=True)
    paths["translation_json"].write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["translation_txt"].write_text(text, encoding="utf-8")
    upload_text(service, translation_folder_id, "English Translation.txt", text)
    upload_text(service, translation_folder_id, "Translation.json", json.dumps(data, ensure_ascii=False, indent=2), "application/json")

def stage_ai(service, meeting_folder, ai_folder_id, paths):
    metadata = metadata_from_drive(service, meeting_folder)
    data = json.loads(paths["transcript_json"].read_text(encoding="utf-8"))
    log("Running AI understanding and evidence extraction on the GitHub Actions runner...")
    evidence = ollama_json(data, metadata)
    paths["evidence"].write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    upload_text(service, ai_folder_id, "AI Evidence.json", json.dumps(evidence, ensure_ascii=False, indent=2), "application/json")

def stage_mom(service, meeting_folder, mom_folder_id, paths):
    metadata = metadata_from_drive(service, meeting_folder)
    evidence = json.loads(paths["evidence"].read_text(encoding="utf-8"))
    log("Preparing and validating MoM...")
    doc = build_mom_doc(metadata, evidence)
    doc.save(paths["mom"])
    upload_bytes(service, mom_folder_id, f"{metadata.get('title','Meeting')} - AI_MOM.docx", paths["mom"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    upload_text(service, mom_folder_id, "PROCESSING_COMPLETE.json", json.dumps({
        "meeting_id": os.environ.get("MEETING_ID",""),
        "status": "complete"
    }, indent=2), "application/json")

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["whisper","translation","ai","mom","all"], default="all")
    args = parser.parse_args()

    meeting_folder = require_env("MEETING_FOLDER_ID")
    audio_folder = require_env("AUDIO_FOLDER_ID")
    service = drive_service()
    folders = output_folders(service, meeting_folder)
    paths = stage_paths()

    if args.stage in ("whisper","all"):
        stage_whisper(service, audio_folder, folders["TRANSCRIPT"], paths)
    if args.stage in ("translation","all"):
        stage_translation(service, folders["TRANSLATION"], paths)
    if args.stage in ("ai","all"):
        stage_ai(service, meeting_folder, folders["AI"], paths)
    if args.stage in ("mom","all"):
        stage_mom(service, meeting_folder, folders["MOM"], paths)

    log("STAGE COMPLETE: " + args.stage)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log("PROCESSING FAILED: " + str(exc))
        raise
