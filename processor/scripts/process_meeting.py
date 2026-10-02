#!/usr/bin/env python3
"""Meeting MoM online processor.

Stages (each is a separate workflow step; all share ./.meeting_work):
  init         write QUEUED status
  whisper      select exact audio -> WAV -> original transcript
  translation  English translation (then local audio is deleted)
  ai           staged evidence extraction + Complete Conversation Summary + Executive Summary
  mom          evidence validation -> DOCX -> upload -> COMPLETED
  fail         mark FAILED if a workflow step died before the processor could report
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import ai_understanding as ai_mod
from pipeline.docx_builder import build_mom_doc
from pipeline.drive_store import DriveStore, select_audio
from pipeline.errors import STAGE_DEFAULT_CODE, MomError
from pipeline.status import StatusReporter, now
from pipeline.validation import validate

WORK = Path(".meeting_work")
WHISPER = Path("whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = Path("whisper.cpp/models/ggml-small-q5_1.bin")
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
JSON_MIME = "application/json"
FOLDER_ALIASES = {
    "TRANSCRIPT": ("TRANSCRIPT", "TRANSCRIPTS"),
    "TRANSLATION": ("TRANSLATION", "TRANSLATIONS"),
    "AI": ("AI",),
    "MOM": ("MOM",),
}


def resolve_folders(store, meeting_folder):
    existing = {f["name"]: f["id"] for f in store.list_children(meeting_folder, folders=True)}
    out = {}
    for key, names in FOLDER_ALIASES.items():
        found = next((existing[n] for n in names if n in existing), None)
        if not found:
            log(f"Creating missing meeting output folder: {key}")
            found = store.ensure_folder(meeting_folder, key)
        out[key] = found
    return out


def log(msg):
    print(msg, flush=True)


def env(name, default=""):
    return os.environ.get(name, default).strip()


def require_env(name):
    value = env(name)
    if not value:
        raise MomError("MOM-002", f"Required environment variable is missing: {name}")
    return value


def run_cmd(cmd, code):
    log("$ " + " ".join(map(str, cmd)))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise MomError(code, f"{cmd[0]} is not installed or not executable.")
    except subprocess.CalledProcessError as exc:
        raise MomError(code, f"{Path(str(cmd[0])).name} exited with code {exc.returncode}.")


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def paths():
    WORK.mkdir(exist_ok=True)
    return {
        "source": WORK / "source_audio", "wav": WORK / "meeting.wav",
        "transcript_json": WORK / "transcript.json", "translation_json": WORK / "translation.json",
        "ai": WORK / "ai_understanding.json", "mom": WORK / "AI_MOM.docx",
        "warnings": WORK / "audio_warnings.json",
    }


class Ctx:
    def __init__(self, store, meeting_folder, audio_folder, folders, status):
        self.store, self.meeting_folder, self.audio_folder = store, meeting_folder, audio_folder
        self.folders, self.status, self.p = folders, status, paths()


def whisper_json(wav, base, translate=False):
    if not WHISPER.exists():
        raise MomError("MOM-005", f"Whisper executable not found at {WHISPER}.")
    if not WHISPER_MODEL.exists() or WHISPER_MODEL.stat().st_size == 0:
        raise MomError("MOM-006", f"Whisper model not found at {WHISPER_MODEL}.")

    # Reduce cross-window repetition/hallucination on long or noisy recordings.
    cmd = [
        str(WHISPER), "-m", str(WHISPER_MODEL), "-f", str(wav), "-l", "auto",
        "-ojf", "-of", str(base), "-t", env("WHISPER_THREADS", "4"),
        "-mc", "0", "-sns", "-nth", env("WHISPER_NO_SPEECH_THRESHOLD", "0.60"),
    ]
    if translate:
        cmd.append("-tr")
    run_cmd(cmd, "MOM-007" if translate else "MOM-005")
    out = Path(str(base) + ".json")
    if not out.exists():
        raise MomError("MOM-007" if translate else "MOM-005", f"Whisper produced no output for {base}.")

    raw = out.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
        log("WARNING: Whisper JSON contained invalid UTF-8; replacement characters were inserted.")

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise MomError("MOM-005", f"Whisper JSON is malformed: {exc}") from exc

    data["_decoder_diagnostics"] = {
        "invalid_utf8_replacements": text.count("\ufffd"),
        "json_bytes": len(raw),
    }
    return data


def validate_transcript_quality(segments, diagnostics=None):
    diagnostics = diagnostics or {}
    texts = [str(s.get("text", "")).strip() for s in segments if str(s.get("text", "")).strip()]
    joined = " ".join(texts)
    compact = re.sub(r"\s+", " ", joined).strip()
    tokens = compact.lower().split()

    if len(compact) < 20:
        raise MomError("MOM-008", "Transcript quality check failed: less than 20 characters of usable speech were detected.")

    unique_ratio = len(set(tokens)) / max(1, len(tokens))
    repeated_segment_ratio = 0.0
    if len(texts) >= 4:
        normalized = [re.sub(r"\W+", "", t.lower()) for t in texts]
        counts = {}
        for item in normalized:
            if item:
                counts[item] = counts.get(item, 0) + 1
        repeated_segment_ratio = max(counts.values(), default=0) / max(1, len(normalized))

    replacement_count = int(diagnostics.get("invalid_utf8_replacements", 0))
    if len(tokens) >= 40 and (unique_ratio < 0.08 or repeated_segment_ratio >= 0.75):
        raise MomError(
            "MOM-008",
            "Transcript quality check failed: Whisper produced highly repetitive text, "
            "which is consistent with silence/noise or transcription hallucination. "
            "Please verify the recording contains clear speech and try again."
        )
    if replacement_count > max(10, len(compact) // 200):
        raise MomError("MOM-008", "Transcript quality check failed: the Whisper output contained too many invalid characters.")

    return {
        "usable_characters": len(compact),
        "token_count": len(tokens),
        "unique_token_ratio": round(unique_ratio, 4),
        "repeated_segment_ratio": round(repeated_segment_ratio, 4),
        "invalid_utf8_replacements": replacement_count,
    }


def timestamped_text(segments):
    return "\n".join(ai_mod.seg_line(s) for s in segments) + "\n"


def load_json_local_or_drive(ctx, local, folder, name, required=True):
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    meta = ctx.store.find_one(ctx.folders[folder], name)
    if not meta:
        if required:
            raise MomError("MOM-002", f"{name} is not available locally or in Drive.")
        return None
    data = json.loads(ctx.store.read_bytes(meta["id"]).decode("utf-8"))
    local.write_text(dump(data), encoding="utf-8")
    return data


def load_metadata(ctx):
    meta = ctx.store.find_one(ctx.meeting_folder, "meeting_metadata.json")
    if not meta:
        raise MomError("MOM-002", "meeting_metadata.json was not found in the meeting folder.")
    return json.loads(ctx.store.read_bytes(meta["id"]).decode("utf-8"))


def publish_ai_outputs(ctx, ai, validated):
    s, f = ctx.store, ctx.folders["AI"]
    evidence = dict(ai, summary=ai.get("executive_summary", ""), validated=validated)
    s.upsert_text(f, "AI Evidence.json", dump(evidence), JSON_MIME)
    s.upsert_text(f, "AI Understanding.json", dump(dict(ai, validated=validated)), JSON_MIME)
    s.upsert_text(f, "Complete Conversation Summary.txt", ai.get("complete_conversation_summary", ""))
    s.upsert_text(f, "Executive Summary.txt", ai.get("executive_summary", ""))


def stage_init(ctx):
    ctx.status.reset()
    ctx.status.update("QUEUED", "Processing started on the GitHub runner", 0)


def stage_whisper(ctx):
    st = ctx.status
    st.update("DOWNLOADING", "Locating meeting audio")
    audio, warnings = select_audio(ctx.store, ctx.audio_folder, env("AUDIO_FILE_ID"),
                                   env("STRICT_AUDIO_SELECTION", "false").lower() == "true")
    for w in warnings:
        log("WARNING: " + w)
    ctx.p["warnings"].write_text(dump(warnings), encoding="utf-8")
    log(f"Downloading meeting audio: {audio.get('name')}")
    st.update("DOWNLOADING", "Downloading audio from Google Drive", 6)
    ctx.store.download(audio["id"], ctx.p["source"])
    st.update("CONVERTING", "Converting audio to 16 kHz mono WAV")
    run_cmd(["ffmpeg", "-y", "-i", str(ctx.p["source"]), "-ar", "16000", "-ac", "1",
             "-c:a", "pcm_s16le", str(ctx.p["wav"])], "MOM-004")
    st.update("TRANSCRIBING", "Transcribing with Whisper")
    data = whisper_json(ctx.p["wav"], WORK / "transcript")
    segments = ai_mod.segments_from_whisper(data)
    if not segments:
        raise MomError("MOM-005", "Whisper produced no transcript segments (silent or unreadable audio?).")
    data["_quality"] = validate_transcript_quality(segments, data.get("_decoder_diagnostics"))
    ctx.p["transcript_json"].write_text(dump(data), encoding="utf-8")
    st.update("TRANSCRIBING", "Saving original transcript", 40)
    ctx.store.upsert_text(ctx.folders["TRANSCRIPT"], "Original Transcript.txt", timestamped_text(segments))
    ctx.store.upsert_text(ctx.folders["TRANSCRIPT"], "Transcript.json", dump(data), JSON_MIME)


def stage_translation(ctx):
    st = ctx.status
    if not ctx.p["wav"].exists():
        raise MomError("MOM-007", "WAV audio is missing before the translation stage.")
    st.update("TRANSLATING", "Translating to English with Whisper")
    data = whisper_json(ctx.p["wav"], WORK / "translation", translate=True)
    segments = ai_mod.segments_from_whisper(data)
    if segments:
        data["_quality"] = validate_transcript_quality(segments, data.get("_decoder_diagnostics"))
    ctx.p["translation_json"].write_text(dump(data), encoding="utf-8")
    ctx.store.upsert_text(ctx.folders["TRANSLATION"], "English Translation.txt", timestamped_text(segments))
    ctx.store.upsert_text(ctx.folders["TRANSLATION"], "Translation.json", dump(data), JSON_MIME)
    for key in ("source", "wav"):
        ctx.p[key].unlink(missing_ok=True)


def stage_ai(ctx):
    st = ctx.status
    st.update("ANALYZING", "Preparing transcript for AI analysis", 58)
    metadata = load_metadata(ctx)
    original = ai_mod.segments_from_whisper(
        load_json_local_or_drive(ctx, ctx.p["transcript_json"], "TRANSCRIPT", "Transcript.json"))
    translation_data = load_json_local_or_drive(
        ctx, ctx.p["translation_json"], "TRANSLATION", "Translation.json", required=False)
    translation = ai_mod.segments_from_whisper(translation_data) if translation_data else []
    model = env("AI_MODEL", "qwen2.5:1.5b-instruct-q3_K_L")
    json_fn, text_fn = ai_mod.make_ollama_fns(model)
    ai = ai_mod.run_understanding(
        metadata, original, translation, json_fn, text_fn,
        max_chars=int(env("AI_CHUNK_CHARS", "6000")),
        progress=lambda state, msg, pct: st.update(state, msg, pct), model=model)
    ctx.p["ai"].write_text(dump(ai), encoding="utf-8")
    st.update("SUMMARIZING", "Saving AI outputs", 85)
    publish_ai_outputs(ctx, ai, validated=False)


def stage_mom(ctx):
    st = ctx.status
    st.update("GENERATING_MOM", "Validating evidence")
    metadata = load_metadata(ctx)
    ai = load_json_local_or_drive(ctx, ctx.p["ai"], "AI", "AI Understanding.json")
    original = ai_mod.segments_from_whisper(
        load_json_local_or_drive(ctx, ctx.p["transcript_json"], "TRANSCRIPT", "Transcript.json"))
    td = load_json_local_or_drive(ctx, ctx.p["translation_json"], "TRANSLATION", "Translation.json", required=False)
    translation = ai_mod.segments_from_whisper(td) if td else []
    try:
        validated, report = validate(ai, original, translation)
    except Exception as exc:
        raise MomError("MOM-011", f"Evidence validation failed: {exc}")
    st.update("GENERATING_MOM", "Building the MoM document", 90)
    try:
        build_mom_doc(metadata, validated).save(ctx.p["mom"])
    except Exception as exc:
        raise MomError("MOM-012", f"DOCX generation failed: {exc}")
    st.update("UPLOADING", "Uploading results to Google Drive")
    publish_ai_outputs(ctx, validated, validated=True)
    title = metadata.get("title") or "Meeting"
    docx_name = f"{title} - AI_MOM.docx"
    ctx.store.upsert_file(ctx.folders["MOM"], docx_name, ctx.p["mom"], DOCX_MIME)
    warnings = json.loads(ctx.p["warnings"].read_text(encoding="utf-8")) if ctx.p["warnings"].exists() else []
    ctx.store.upsert_text(ctx.folders["MOM"], "PROCESSING_COMPLETE.json", dump({
        "meeting_id": env("MEETING_ID"), "status": "complete", "completed_at": now(),
        "ai_model": validated.get("generated_with", {}).get("ai_model", ""),
        "outputs": {"mom_docx": docx_name, "executive_summary": True,
                    "complete_conversation_summary": bool(validated.get("complete_conversation_summary"))},
        "validation": report, "warnings": warnings}), JSON_MIME)
    st.update("COMPLETED", "Results are ready in Google Drive", 100)


def stage_fail(ctx):
    if ctx.status.data.get("status") in ("FAILED", "COMPLETED"):
        return
    ctx.status.fail(env("FAILED_ERROR_CODE", "MOM-003"),
                    f"Workflow step failed before the processor could report: {env('FAILED_STEP', 'unknown')}")


STAGES = {"init": stage_init, "whisper": stage_whisper, "translation": stage_translation,
          "ai": stage_ai, "mom": stage_mom, "fail": stage_fail}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=list(STAGES) + ["all"], default="all")
    args = parser.parse_args()
    current = args.stage
    status = None
    try:
        meeting_folder = require_env("MEETING_FOLDER_ID")
        audio_folder = require_env("AUDIO_FOLDER_ID")
        store = DriveStore.from_env()
        folders = resolve_folders(store, meeting_folder)
        paths()
        status = StatusReporter(store, meeting_folder, env("MEETING_ID"), WORK / "status.json", current)
        ctx = Ctx(store, meeting_folder, audio_folder, folders, status)
        order = ["whisper", "translation", "ai", "mom"] if args.stage == "all" else [args.stage]
        for name in order:
            current = status.stage = name
            STAGES[name](ctx)
            log("STAGE COMPLETE: " + name)
    except MomError as exc:
        log(f"PROCESSING FAILED {exc}")
        if status:
            status.fail(exc.code, exc.message)
        sys.exit(1)
    except Exception as exc:
        code = STAGE_DEFAULT_CODE.get(current, "MOM-003")
        log(f"PROCESSING FAILED [{code}] {type(exc).__name__}: {exc}")
        if status:
            status.fail(code, f"{type(exc).__name__}: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
