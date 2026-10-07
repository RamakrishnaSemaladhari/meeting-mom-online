"""Parallel 10-minute batch engine for long online meetings.

Design:
- prepare: download the exact Drive audio once, measure duration, emit a dynamic matrix.
- worker: each matrix job independently downloads the private Drive audio, extracts one 10-minute
  window, runs Whisper + fast local Ollama evidence/translation, and writes only its own Drive
  batch folder. Workers never overwrite the root processing status.
- finalize: collect all batch folders, reconstruct complete transcript/translation, run final
  synthesis/validation and publish the MoM.
"""
import json
import math
import os
import subprocess
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.errors import MomError
from pipeline.drive_store import DriveStore, select_audio
from pipeline.status import now, sanitize, StatusReporter
from pipeline.speech_quality import MIN_CHARS, assess_audio, assess_transcript, audio_report_from_ffmpeg
from pipeline import ai_understanding as ai_mod
from pipeline.batch_processor import (
    _aggregate_batches,
    _build_bilingual_docx,
    _combined_bilingual,
    _shift_segments,
    _shift_whisper_data,
    _translation_from_ai,
    _parse_ai_timestamp,
    BATCH_SECONDS,
)
from pipeline.validation import validate
from pipeline.docx_builder import build_mom_doc

WORK = Path(".meeting_work_parallel")
WHISPER = Path("whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = Path(os.environ.get("WHISPER_MODEL_PATH", "whisper.cpp/models/ggml-small-q5_1.bin"))
FALLBACK_MODEL = Path(os.environ.get("WHISPER_FALLBACK_MODEL_PATH", "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"))
VAD_MODEL = Path(os.environ.get("WHISPER_VAD_MODEL_PATH", "whisper.cpp/models/ggml-silero-v5.1.2.bin"))
JSON_MIME = "application/json"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def env(name, default=""):
    return os.environ.get(name, default).strip()


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def log(msg):
    print(msg, flush=True)


def github_run_fields():
    run_id = env("GITHUB_RUN_ID")
    repo = env("GITHUB_REPOSITORY")
    server = env("GITHUB_SERVER_URL", "https://github.com")
    return {
        "github_run_id": run_id,
        "github_run_url": (f"{server}/{repo}/actions/runs/{run_id}" if run_id and repo else "")
    }


def run_cmd(cmd, code):
    log("$ " + " ".join(map(str, cmd)))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise MomError(code, f"{cmd[0]} is not installed or not executable.")
    except subprocess.CalledProcessError as exc:
        raise MomError(code, f"{Path(str(cmd[0])).name} exited with code {exc.returncode}.")


def ffprobe_duration(path):
    try:
        p = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, check=True, timeout=120)
        return float(p.stdout.strip() or 0)
    except Exception as exc:
        raise MomError("MOM-004", f"Could not determine audio duration: {exc}")


def language_hint(value=""):
    value = (env("WHISPER_LANGUAGE") or value or "auto").lower()
    return value if __import__("re").fullmatch(r"[a-z]{2,3}", value) else "auto"


def detected_language(data):
    return str(((data.get("result") or {}).get("language")) or "").lower()


def whisper_json(wav, base, language, model=None):
    if not WHISPER.exists():
        raise MomError("MOM-005", f"Whisper executable not found at {WHISPER}.")
    model = Path(model) if model else WHISPER_MODEL
    if not model.exists() or model.stat().st_size == 0:
        raise MomError("MOM-006", f"Whisper model not found at {model}.")
    if not VAD_MODEL.exists() or VAD_MODEL.stat().st_size == 0:
        raise MomError("MOM-006", f"Whisper VAD model not found at {VAD_MODEL}.")
    cmd = [
        str(WHISPER), "-m", str(model), "-f", str(wav), "-l", language,
        "-oj", "-of", str(base), "-t", env("WHISPER_THREADS", "4"),
        "-mc", "0", "-nf", "-et", env("WHISPER_ENTROPY_THRESHOLD", "2.60"),
        "-lpt", env("WHISPER_LOGPROB_THRESHOLD", "-1.25"),
        "-sns", "-nth", env("WHISPER_NO_SPEECH_THRESHOLD", "0.60"),
        "--vad", "--vad-model", str(VAD_MODEL),
        "--vad-threshold", env("WHISPER_VAD_THRESHOLD", "0.50"),
        "--vad-min-speech-duration-ms", env("WHISPER_VAD_MIN_SPEECH_MS", "250"),
        "--vad-min-silence-duration-ms", env("WHISPER_VAD_MIN_SILENCE_MS", "300"),
        "--vad-max-speech-duration-s", env("WHISPER_VAD_MAX_SPEECH_SEC", "30"),
        "--vad-speech-pad-ms", env("WHISPER_VAD_PAD_MS", "300"),
    ]
    run_cmd(cmd, "MOM-005")
    out = Path(str(base) + ".json")
    if not out.exists():
        raise MomError("MOM-005", f"Whisper produced no output for {base}.")
    try:
        return json.loads(out.read_text(encoding="utf-8"))
    except Exception as exc:
        raise MomError("MOM-005", f"Whisper JSON is malformed: {exc}")


def batch_audio_health(wav):
    """Level/silence/duration of one window. Returns (report, problems, warnings)."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav),
             "-af", "volumedetect,silencedetect=noise=-40dB:d=1", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300)
        report = audio_report_from_ffmpeg(proc.stderr)
    except Exception as exc:
        log(f"WARNING: audio health check could not run: {exc}")
        return {}, [], []
    problems, warnings = assess_audio(report)
    log("Audio health: " + json.dumps(report))
    return report, problems, warnings


def transcribe_batch(wav, index, hint):
    """Primary Whisper -> quality gate -> fallback Whisper."""
    report, problems, warnings = batch_audio_health(wav)
    if problems:
        return None, [], {"status": "silent", "passed": False, "reason": " ".join(problems), "audio": report}
    models = [("primary", WHISPER_MODEL)]
    if FALLBACK_MODEL.exists() and FALLBACK_MODEL.stat().st_size > 0 and FALLBACK_MODEL != WHISPER_MODEL:
        models.append(("fallback", FALLBACK_MODEL))
    attempts = []
    for label, model in models:
        data = whisper_json(wav, WORK / f"transcript_{index:03d}_{label}", hint, model=model)
        segments = ai_mod.segments_from_whisper(data)
        verdict = assess_transcript(segments, None)
        attempts.append({"label": label, "model": model.name, "passed": verdict["passed"],
                         "problems": verdict["problems"], "metrics": verdict["metrics"]})
        if verdict["passed"]:
            return data, segments, {"status": "ok", "passed": True, "model_used": model.name,
                                    "attempts": attempts, "audio": report, "warnings": warnings}
    no_text = all(a["metrics"]["usable_characters"] < MIN_CHARS for a in attempts)
    reasons = "; ".join(f'{a["model"]}: ' + ", ".join(a["problems"]) for a in attempts)
    return None, [], {"status": "silent" if no_text else "rejected", "passed": False,
                      "reason": reasons, "attempts": attempts, "audio": report}


def empty_batch_ai(flag, index, start, end, batch_model):
    evidence = {k: [] for k in ai_mod.OUTPUT_KEYS}
    evidence.update({"executive_summary": "", "complete_conversation_summary": "", "review_flags": [flag],
                     "translation_segments": [], "schema_version": ai_mod.SCHEMA_VERSION,
                     "generated_with": {"ai_model": batch_model, "batch_ai_model": batch_model, "sections": 0},
                     "batch": {"index": index, "start": ai_mod.fmt_ts(start), "end": ai_mod.fmt_ts(end)}})
    return evidence


def write_empty_batch(store, batch_folder, index, start, end, quality, batch_model):
    note = ("No usable speech was detected in this 10-minute window (silence or very low audio)."
            if quality["status"] == "silent" else
            "The transcript for this window was discarded because it failed the quality check (repetition or garbled output). This window is NOT covered by the MoM; review the audio.")
    flag = f"Window {index} ({ai_mod.fmt_ts(start)}-{ai_mod.fmt_ts(end)}): {note}"
    meta = {"index": index, "start_seconds": start, "end_seconds": end}
    store.upsert_text(batch_folder, "Original Transcript.txt", note + "\n")
    store.upsert_text(batch_folder, "Transcript.json", dump({"transcription": [], "result": {"language": ""}, "_batch": meta, "_quality": quality}), JSON_MIME)
    store.upsert_text(batch_folder, "English Translation.txt", note + "\n")
    store.upsert_text(batch_folder, "Translation.json", dump({"transcription": [], "result": {"language": "en"}, "_quality": {"engine": "none"}}), JSON_MIME)
    store.upsert_text(batch_folder, "Original + English Translation.txt", note + "\n")
    store.upsert_text(batch_folder, "AI Evidence.json", dump(empty_batch_ai(flag, index, start, end, batch_model)), JSON_MIME)
    store.upsert_text(batch_folder, "Complete Conversation Summary.txt", "")
    store.upsert_text(batch_folder, "Executive Summary.txt", "")
    return note


def load_previous_context(store, meeting_folder, metadata):
    try:
        source_type = str((metadata or {}).get("continuity_source_type", "") or "").lower()
        continuity_id = str((metadata or {}).get("continuity_meeting_id", "") or "").strip()

        if source_type == "summary":
            summary = str((metadata or {}).get("continuity_summary", "") or "").strip()
            if not summary:
                return None
            return {
                "meeting_name": metadata.get("continuity_meeting_title") or "Previous meeting summary",
                "executive_summary": summary,
                "complete_conversation_summary": summary,
                "decisions": [],
                "action_items": [],
                "open_questions": [],
                "source_type": "summary"
            }

        if source_type == "mom_file":
            continuity_file = store.find_one(meeting_folder, "CONTINUITY_PREVIOUS_MOM.txt")
            if not continuity_file:
                return None
            text = store.read_bytes(continuity_file["id"]).decode("utf-8", errors="replace").strip()
            if not text:
                return None
            return {
                "meeting_name": metadata.get("continuity_file_name") or "Previous MoM",
                "previous_meeting_mom": text[:20000],
                "executive_summary": text[:12000],
                "complete_conversation_summary": text[:12000],
                "decisions": [],
                "action_items": [],
                "open_questions": [],
                "source_type": "mom_file"
            }

        target_id = continuity_id
        if not target_id:
            return None

        children = store.list_children(target_id, folders=True)
        ai_folder = next((x for x in children if x["name"] == "AI"), None)
        evidence = store.find_one(ai_folder["id"], "AI Evidence.json") if ai_folder else None
        if not evidence:
            return None
        data = json.loads(store.read_bytes(evidence["id"]).decode("utf-8"))
        meta_file = store.find_one(target_id, "meeting_metadata.json")
        previous_meta = {}
        if meta_file:
            try:
                previous_meta = json.loads(store.read_bytes(meta_file["id"]).decode("utf-8"))
            except Exception:
                previous_meta = {}
        return {
            "meeting_name": previous_meta.get("title") or (store.get_meta(target_id).get("name") if store.get_meta(target_id) else "Previous meeting"),
            "executive_summary": data.get("executive_summary", data.get("summary", "")),
            "complete_conversation_summary": data.get("complete_conversation_summary", ""),
            "decisions": data.get("decisions", []),
            "action_items": data.get("action_items", []),
            "open_questions": data.get("open_questions", []),
            "source_type": "meeting_id",
            "source_meeting_id": target_id
        }
    except Exception as exc:
        log(f"Previous-meeting context ignored: {exc}")
        return None


def load_attendance_manifest(store, meeting_folder):
    try:
        manifest = store.find_one(meeting_folder, "BLE_ATTENDANCE.json")
        if not manifest:
            return None
        data = json.loads(store.read_bytes(manifest["id"]).decode("utf-8"))
        participants = data.get("participants") if isinstance(data, dict) else []
        if not isinstance(participants, list):
            participants = []
        return {
            "protocol": data.get("protocol", "meeting-mesh-attendance-v1"),
            "updated_at": data.get("updated_at", ""),
            "participants": participants,
            "present_count": sum(
                1 for p in participants
                if str(p.get("status", "PRESENT")).upper() == "PRESENT"
            )
        }
    except Exception as exc:
        log(f"BLE attendance manifest ignored: {exc}")
        return None


def stage_prepare():
    store = DriveStore.from_env()
    meeting = env("MEETING_FOLDER_ID")
    audio_folder = env("AUDIO_FOLDER_ID")
    audio_id = env("AUDIO_FILE_ID")
    if not meeting or not audio_folder:
        raise MomError("MOM-002", "MEETING_FOLDER_ID and AUDIO_FOLDER_ID are required.")
    audio, warnings = select_audio(store, audio_folder, audio_id, True)
    WORK.mkdir(parents=True, exist_ok=True)
    source = WORK / "prepare_source"
    log(f"Preparing exact audio: {audio.get('name')}")
    store.download(audio["id"], source)
    duration = ffprobe_duration(source)
    if duration <= 0:
        raise MomError("MOM-004", "The uploaded audio has no measurable duration.")
    total = max(1, int(math.ceil(duration / BATCH_SECONDS)))
    if total > 60:
        raise MomError("MOM-004", "Meeting exceeds the 60-batch safety limit.")
    matrix = list(range(1, total + 1))
    print(f"duration_seconds={duration}")
    print(f"batch_total={total}")
    print("matrix_json=" + json.dumps(matrix))
    # These are GitHub Actions outputs; no meeting content is emitted.
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write(f"batch_total={total}\n")
            fh.write("matrix_json=" + json.dumps(matrix) + "\n")
            fh.write(f"duration_seconds={duration}\n")
    # Publish a lightweight root status immediately so the UI can show that
    # automatic batching has started before the first worker finishes.
    status = {
        "meeting_id": env("MEETING_ID"),
        "status": "PROCESSING",
        "stage": "SPLITTING",
        "progress_percent": 18,
        "current_stage": "batch_prepare",
        "message": f"Prepared {total} automatic 10-minute batch(es). Parallel workers are starting.",
        "batch_index": 0,
        "batch_total": total,
        "duration_seconds": duration,
        **github_run_fields(),
        "updated_at": now()
    }
    store.upsert_text(env("MEETING_FOLDER_ID"), "PROCESSING_STATUS.json", dump(status), JSON_MIME)
    store.upsert_text(env("MEETING_FOLDER_ID"), "BATCH_MANIFEST.json", dump({
        "meeting_id": env("MEETING_ID"),
        "duration_seconds": duration,
        "batch_seconds": BATCH_SECONDS,
        "batch_total": total,
        "status": "PROCESSING"
    }), JSON_MIME)
    source.unlink(missing_ok=True)
    return total


def batch_folder_name(index, start, end):
    return f"BATCH_{index:03d}_{ai_mod.fmt_ts(start).replace(':','-')}_{ai_mod.fmt_ts(end).replace(':','-')}"


def batch_outputs_complete(store, batch_folder, batches_folder=None, index=None):
    """A batch is reusable only when artifacts parse and its worker reported COMPLETED."""
    required = ("Transcript.json", "Translation.json", "AI Evidence.json")
    try:
        files = {name: store.find_one(batch_folder, name) for name in required}
        if not all(files.values()):
            return False
        parsed = {name: json.loads(store.read_bytes(files[name]["id"]).decode("utf-8")) for name in required}
        if (parsed["Transcript.json"].get("_quality") or {}).get("status") == "rejected":
            return False
        if batches_folder is not None and index is not None:
            status_meta = store.find_one(batches_folder, f"BATCH_STATUS_{index:03d}.json")
            if not status_meta:
                return False
            status = json.loads(store.read_bytes(status_meta["id"]).decode("utf-8"))
            return str(status.get("status", "")).upper() == "COMPLETED"
        return bool(store.find_one(batch_folder, "BATCH_STATUS.json"))
    except Exception:
        return False


def save_batch_checkpoint(store, meeting_folder, index, total):
    existing = store.find_one(meeting_folder, "PROCESSING_CHECKPOINT.json")
    completed = []
    if existing:
        try:
            data = json.loads(store.read_bytes(existing["id"]).decode("utf-8"))
            completed = [int(x) for x in data.get("completed_batches", [])]
        except Exception:
            completed = []
    if index not in completed:
        completed.append(index)
    completed = sorted(set(completed))
    store.upsert_text(meeting_folder, "PROCESSING_CHECKPOINT.json", dump({
        "meeting_id": env("MEETING_ID"),
        "status": "PROCESSING" if len(completed) < total else "BATCHES_COMPLETE",
        "stage": "parallel_batches",
        "completed_batches": completed,
        "batch_total": total,
        "last_successful_batch": completed[-1] if completed else 0,
        "updated_at": now()
    }), JSON_MIME)


def write_batch_status(store, batches_folder, index, total, state, message, start, end, **extra):
    payload = {
        "batch_index": index, "batch_total": total, "status": state,
        "message": message, "start_seconds": start, "end_seconds": end,
        "updated_at": now(), **extra
    }
    store.upsert_text(batches_folder, f"BATCH_STATUS_{index:03d}.json", dump(payload), JSON_MIME)


def stage_worker():
    store = DriveStore.from_env()
    meeting = env("MEETING_FOLDER_ID")
    audio_folder = env("AUDIO_FOLDER_ID")
    audio_id = env("AUDIO_FILE_ID")
    index = int(env("BATCH_INDEX", "0"))
    total_raw = env("BATCH_TOTAL", "")
    duration_raw = env("MEETING_DURATION_SECONDS", "")
    if not total_raw or not duration_raw:
        raise MomError("MOM-002", "Parallel batch worker requires BATCH_TOTAL and MEETING_DURATION_SECONDS from a successful prepare job.")
    try:
        total = int(total_raw)
        duration = float(duration_raw)
    except ValueError as exc:
        raise MomError("MOM-002", f"Invalid parallel finalizer parameters: {exc}")
    if index < 1 or total < 1 or not meeting or not audio_folder or not audio_id:
        raise MomError("MOM-002", "Parallel batch worker is missing meeting/audio/batch parameters.")

    batches_folder = store.ensure_folder(meeting, "BATCHES")
    start = (index - 1) * BATCH_SECONDS
    end = min(start + BATCH_SECONDS, duration)
    batch_folder = store.ensure_folder(batches_folder, batch_folder_name(index, start, end))

    # Resume is checkpoint-based: completed Drive batches are never recomputed.
    # A fresh re-run explicitly ignores the checkpoint and rebuilds every batch.
    if env("PROCESSING_MODE", "fresh").lower() == "resume" and batch_outputs_complete(store, batch_folder, batches_folder, index):
        write_batch_status(store, batches_folder, index, total, "COMPLETED",
                           f"Batch {index}/{total} already complete — checkpoint reused", start, end)
        save_batch_checkpoint(store, meeting, index, total)
        log(f"RESUME: batch {index}/{total} reused from Drive checkpoint")
        return

    try:
        metadata_file = store.find_one(meeting, "meeting_metadata.json")
        if not metadata_file:
            raise MomError("MOM-002", "meeting_metadata.json was not found in the meeting folder.")
        metadata = json.loads(store.read_bytes(metadata_file["id"]).decode("utf-8"))

        write_batch_status(store, batches_folder, index, total, "DOWNLOADING",
                           "Downloading exact meeting audio", start, end)
        WORK.mkdir(parents=True, exist_ok=True)
        source = WORK / "source_audio"
        wav = WORK / "batch.wav"
        audio, _ = select_audio(store, audio_folder, audio_id, True)
        store.download(audio["id"], source)

        write_batch_status(store, batches_folder, index, total, "CONVERTING",
                           f"Extracting {ai_mod.fmt_ts(start)}–{ai_mod.fmt_ts(end)}", start, end)
        run_cmd(["ffmpeg", "-y", "-ss", str(start), "-t", str(max(1, end-start)),
                 "-i", str(source), "-map", "0:a:0", "-ar", "16000", "-ac", "1",
                 "-c:a", "pcm_s16le", str(wav)], "MOM-004")

        write_batch_status(store, batches_folder, index, total, "TRANSCRIBING",
                           f"Batch {index}/{total} — Whisper transcription", start, end)
        hint = language_hint(metadata.get("language_hint", ""))
        data, local, quality = transcribe_batch(wav, index, hint)
        batch_model = env("AI_BATCH_MODEL", "qwen3:1.7b-q4_K_M")
        if quality["status"] != "ok":
            write_empty_batch(store, batch_folder, index, start, end, quality, batch_model)
            write_batch_status(store, batches_folder, index, total, "COMPLETED",
                               f"Batch {index}/{total} complete - no usable speech ({quality['status']})", start, end,
                               quality_status=quality["status"], quality_reason=sanitize(quality.get("reason", ""))[:300])
            source.unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
            return
        original = _shift_segments(local, start)
        data = _shift_whisper_data(data, start)
        data["_batch"] = {"index": index, "start_seconds": start, "end_seconds": end}
        data["_quality"] = quality
        store.upsert_text(batch_folder, "Original Transcript.txt",
                          "\n".join(ai_mod.seg_line(s) for s in original) + "\n")
        store.upsert_text(batch_folder, "Transcript.json", dump(data), JSON_MIME)

        write_batch_status(store, batches_folder, index, total, "ANALYZING",
                           f"Batch {index}/{total} — AI evidence + translation", start, end)
        json_fn, text_fn = ai_mod.make_ollama_fns(batch_model)
        ai = ai_mod.run_understanding(
            metadata, original, [], json_fn, text_fn,
            max_chars=int(env("AI_CHUNK_CHARS", "12000")), model=batch_model)
        lang = detected_language(data)
        if lang == "en":
            translation = [dict(s) for s in original]
        else:
            translation = _translation_from_ai(ai.get("translation_segments", []), original, 0)
            if not translation:
                ai["review_flags"].append("AI translation was not aligned; review the original transcript.")

        tdata = {"transcription": [
            {"offsets": {"from": int(s["start"]*1000), "to": int(s["end"]*1000)}, "text": s["text"]}
            for s in translation
        ], "result": {"language": "en"},
                  "_quality": {"engine": "AI", "source_language": lang or "auto"}}
        store.upsert_text(batch_folder, "English Translation.txt",
                          "\n".join(ai_mod.seg_line(s) for s in translation) + "\n"
                          if translation else "No English translation produced.\n")
        store.upsert_text(batch_folder, "Translation.json", dump(tdata), JSON_MIME)
        store.upsert_text(batch_folder, "Original + English Translation.txt",
                          _combined_bilingual(original, translation))
        ai["generated_with"]["batch_ai_model"] = batch_model
        ai["batch"] = {"index": index, "start": ai_mod.fmt_ts(start), "end": ai_mod.fmt_ts(end)}
        store.upsert_text(batch_folder, "AI Evidence.json", dump(ai), JSON_MIME)
        store.upsert_text(batch_folder, "Complete Conversation Summary.txt",
                          ai.get("complete_conversation_summary", ""))
        store.upsert_text(batch_folder, "Executive Summary.txt",
                          ai.get("executive_summary", ""))
        write_batch_status(store, batches_folder, index, total, "COMPLETED",
                           f"Batch {index}/{total} complete", start, end)
        source.unlink(missing_ok=True)
        wav.unlink(missing_ok=True)
    except Exception as exc:
        code = exc.code if isinstance(exc, MomError) else "MOM-021"
        message = exc.message if isinstance(exc, MomError) else f"{type(exc).__name__}: {exc}"
        try:
            write_batch_status(store, batches_folder, index, total, "FAILED",
                               f"Batch {index}/{total} failed", start, end,
                               error_code=code, error_message=sanitize(message))
        except Exception:
            pass
        raise


def stage_finalize():
    store = DriveStore.from_env()
    meeting = env("MEETING_FOLDER_ID")
    WORK.mkdir(parents=True, exist_ok=True)
    total_raw = env("BATCH_TOTAL", "")
    duration_raw = env("MEETING_DURATION_SECONDS", "")
    if not meeting or not total_raw or not duration_raw:
        raise MomError("MOM-002", "Parallel finalizer requires MEETING_FOLDER_ID, BATCH_TOTAL and MEETING_DURATION_SECONDS from a successful prepare job.")
    try:
        total = int(total_raw)
        duration = float(duration_raw)
    except ValueError as exc:
        raise MomError("MOM-002", f"Invalid parallel finalizer parameters: {exc}")
    if total < 1 or duration <= 0:
        raise MomError("MOM-002", "Parallel finalizer received invalid batch count or meeting duration.")
    metadata_file = store.find_one(meeting, "meeting_metadata.json")
    if not metadata_file:
        raise MomError("MOM-002", "meeting_metadata.json was not found.")
    metadata = json.loads(store.read_bytes(metadata_file["id"]).decode("utf-8"))
    previous = load_previous_context(store, meeting, metadata)
    attendance = load_attendance_manifest(store, meeting)
    if attendance:
        metadata["attendance_evidence"] = attendance
    folders = {f["name"]: f["id"] for f in store.list_children(meeting, folders=True)}
    batches_folder = folders.get("BATCHES") or store.ensure_folder(meeting, "BATCHES")
    transcript_folder = folders.get("TRANSCRIPT") or store.ensure_folder(meeting, "TRANSCRIPT")
    translation_folder = folders.get("TRANSLATION") or store.ensure_folder(meeting, "TRANSLATION")
    ai_folder = folders.get("AI") or store.ensure_folder(meeting, "AI")
    mom_folder = folders.get("MOM") or store.ensure_folder(meeting, "MOM")

    batch_folders = {f["name"]: f["id"] for f in store.list_children(batches_folder, folders=True)}
    batch_results, all_original, all_translation = [], [], []
    missing = []
    window_quality = {}
    for index in range(1, total + 1):
        start = (index - 1) * BATCH_SECONDS
        end = min(start + BATCH_SECONDS, duration)
        name = batch_folder_name(index, start, end)
        bid = batch_folders.get(name)
        if not bid:
            missing.append(index)
            continue
        ai_meta = store.find_one(bid, "AI Evidence.json")
        tr_meta = store.find_one(bid, "Transcript.json")
        en_meta = store.find_one(bid, "Translation.json")
        if not ai_meta or not tr_meta or not en_meta:
            missing.append(index)
            continue
        batch_results.append(json.loads(store.read_bytes(ai_meta["id"]).decode("utf-8")))
        tdata = json.loads(store.read_bytes(tr_meta["id"]).decode("utf-8"))
        window_quality[index] = (tdata.get("_quality") or {}).get("status") or "ok"
        edata = json.loads(store.read_bytes(en_meta["id"]).decode("utf-8"))
        all_original.extend(ai_mod.segments_from_whisper(tdata))
        all_translation.extend(ai_mod.segments_from_whisper(edata))

    if missing:
        raise MomError("MOM-019", "Parallel batches incomplete: " + ", ".join(map(str, missing)))

    silent = sorted(i for i, q in window_quality.items() if q == "silent")
    rejected = sorted(i for i, q in window_quality.items() if q == "rejected")
    if len(silent) + len(rejected) == total:
        raise MomError("MOM-019", f"No usable speech was found in any of the {total} ten-minute window(s). Check that the recording contains clear speech.")
    if rejected and len(rejected) * 2 >= total:
        raise MomError("MOM-019", f"{len(rejected)} of {total} ten-minute windows failed the transcript quality check (windows {', '.join(map(str, rejected))}); too much of the meeting would be missing.")

    all_original.sort(key=lambda x: x["start"])
    all_translation.sort(key=lambda x: x["start"])
    store.upsert_text(transcript_folder, "Original Transcript - Complete Meeting.txt",
                      "\n".join(ai_mod.seg_line(s) for s in all_original) + "\n")
    store.upsert_text(transcript_folder, "Transcript.json", dump({
        "transcription": [
            {"offsets": {"from": int(s["start"]*1000), "to": int(s["end"]*1000)}, "text": s["text"]}
            for s in all_original
        ], "_quality": {"engine": "parallel-batch-whisper", "batches": total}}), JSON_MIME)

    store.upsert_text(translation_folder, "English Translation - Complete Meeting.txt",
                      "\n".join(ai_mod.seg_line(s) for s in all_translation) + "\n")
    store.upsert_text(translation_folder, "Translation.json", dump({
        "transcription": [
            {"offsets": {"from": int(s["start"]*1000), "to": int(s["end"]*1000)}, "text": s["text"]}
            for s in all_translation
        ], "result": {"language": "en"},
        "_quality": {"engine": "AI", "batches": total}}), JSON_MIME)
    store.upsert_text(translation_folder, "Original + English Translation - Complete Meeting.txt",
                      _combined_bilingual(all_original, all_translation))
    bilingual_doc = WORK / "Original + English Translation - Complete Meeting.docx"
    _build_bilingual_docx(bilingual_doc, metadata.get("title"), all_original, all_translation)
    store.upsert_file(translation_folder, "Original + English Translation - Complete Meeting.docx",
                      bilingual_doc, DOCX_MIME)

    final_model = env("AI_FINAL_MODEL", "qwen3:4b-instruct-2507-q4_K_M")
    _, final_text_fn = ai_mod.make_ollama_fns(final_model)

    store.upsert_text(meeting, "PROCESSING_STATUS.json", dump({
        "meeting_id": env("MEETING_ID"),
        "status": "PROCESSING",
        "stage": "SUMMARIZING",
        "progress_percent": 84,
        "current_stage": "final_ai",
        "message": f"All {total} parallel batches completed. Final AI consolidation is running.",
        "batch_index": total,
        "batch_total": total,
        **github_run_fields(),
        "updated_at": now()
    }), JSON_MIME)

    # Reuse the established final aggregation logic; all evidence came from the batch workers.
    final_ai = _aggregate_batches(metadata, batch_results, final_text_fn, previous=previous, model=final_model)
    if attendance:
        final_ai["attendance_evidence"] = attendance
    final_ai["continuity"] = {
        "used": bool(previous),
        "meeting_name": previous.get("meeting_name", "") if previous else ""
    }
    final_ai["batch_manifest"] = {
        "total": total, "batch_seconds": BATCH_SECONDS, "duration_seconds": duration,
        "silent_windows": silent, "rejected_windows": rejected,
        "parallel": True, "batch_ai_model": env("AI_BATCH_MODEL", "qwen3:1.7b-q4_K_M"),
        "final_ai_model": final_model, **github_run_fields()
    }
    store.upsert_text(meeting, "PROCESSING_STATUS.json", dump({
        "meeting_id": env("MEETING_ID"),
        "status": "PROCESSING",
        "stage": "GENERATING_MOM",
        "progress_percent": 92,
        "current_stage": "validation",
        "message": "Final AI consolidation complete. Validating evidence and preparing the final MoM.",
        "batch_index": total,
        "batch_total": total,
        **github_run_fields(),
        "updated_at": now()
    }), JSON_MIME)

    validated, report = validate(final_ai, all_original, all_translation)
    evidence = dict(validated, summary=validated.get("executive_summary", ""),
                    validated=True, validation_report=report)
    if attendance:
        evidence["attendance_evidence"] = attendance
    evidence["continuity"] = {
        "used": bool(previous),
        "meeting_name": previous.get("meeting_name", "") if previous else ""
    }
    store.upsert_text(ai_folder, "AI Evidence.json", dump(evidence), JSON_MIME)
    store.upsert_text(ai_folder, "AI Understanding.json", dump(dict(validated, validated=True)), JSON_MIME)
    store.upsert_text(ai_folder, "Complete Conversation Summary.txt",
                      validated.get("complete_conversation_summary", ""))
    store.upsert_text(ai_folder, "Executive Summary.txt",
                      validated.get("executive_summary", ""))

    mom_path = WORK / "AI_MOM.docx"
    build_mom_doc(metadata, validated).save(mom_path)
    title = metadata.get("title") or "Meeting"
    docx_name = f"{title} - AI_MOM.docx"
    store.upsert_file(mom_folder, docx_name, mom_path, DOCX_MIME)
    store.upsert_text(mom_folder, "PROCESSING_COMPLETE.json", dump({
        "meeting_id": env("MEETING_ID"), "status": "complete", "completed_at": now(),
        "ai_model": final_model, "outputs": {"mom_docx": docx_name,
        "executive_summary": True, "complete_conversation_summary": True},
        "validation": report, "parallel_batches": total,
        "silent_windows": silent, "rejected_windows": rejected,
        "attendance_present_count": attendance.get("present_count", 0) if attendance else 0,
        "continuity_used": bool(previous)
    }), JSON_MIME)
    # Root status is written only once, after all parallel workers have succeeded.
    status = {
        "meeting_id": env("MEETING_ID"), "status": "COMPLETED", "stage": "COMPLETED",
        "progress_percent": 100, "current_stage": "batch_finalize",
        "message": f"Completed {total} parallel batches and final synthesis.",
        **github_run_fields(),
        "updated_at": now(), "completed_at": now(), "batch_index": total, "batch_total": total
    }
    store.upsert_text(meeting, "PROCESSING_STATUS.json", dump(status), JSON_MIME)


def report_root_failure(code, message):
    """Record prepare/finalize failures in the meeting's authoritative status."""
    try:
        store = DriveStore.from_env()
        meeting = env("MEETING_FOLDER_ID")
        if not meeting:
            return
        reporter = StatusReporter(store, meeting, env("MEETING_ID"), WORK / "status.json", "batch_" + env("MODE_NAME", "run"))
        try:
            existing = store.read_json(meeting, "PROCESSING_STATUS.json")
            for key in ("progress_percent", "batch_total", "duration_seconds"):
                if key in existing:
                    reporter.data[key] = existing[key]
        except Exception:
            pass
        reporter.data.update(github_run_fields())
        reporter.fail(code, message)
    except Exception as exc:
        log(f"WARNING: could not record failure status: {sanitize(exc)}")


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["prepare", "worker", "finalize"], required=True)
    args = parser.parse_args()
    os.environ["MODE_NAME"] = args.mode
    try:
        if args.mode == "prepare":
            stage_prepare()
        elif args.mode == "worker":
            stage_worker()
        else:
            stage_finalize()
    except Exception as exc:
        code = exc.code if isinstance(exc, MomError) else "MOM-021"
        message = exc.message if isinstance(exc, MomError) else f"{type(exc).__name__}: {exc}"
        log(f"PROCESSING FAILED [{code}] {sanitize(message)}")
        if not isinstance(exc, MomError):
            import traceback
            traceback.print_exc()
        if args.mode != "worker":
            report_root_failure(code, message)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
