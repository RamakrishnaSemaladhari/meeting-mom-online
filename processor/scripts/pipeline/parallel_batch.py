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
from pipeline.status import now
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


def whisper_json(wav, base, language):
    if not WHISPER.exists():
        raise MomError("MOM-005", f"Whisper executable not found at {WHISPER}.")
    model = WHISPER_MODEL
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
    source.unlink(missing_ok=True)
    return total


def batch_folder_name(index, start, end):
    return f"BATCH_{index:03d}_{ai_mod.fmt_ts(start).replace(':','-')}_{ai_mod.fmt_ts(end).replace(':','-')}"


def write_batch_status(store, batches_folder, index, total, state, message, start, end):
    payload = {
        "batch_index": index, "batch_total": total, "status": state,
        "message": message, "start_seconds": start, "end_seconds": end,
        "updated_at": now()
    }
    store.upsert_text(batches_folder, f"BATCH_STATUS_{index:03d}.json", dump(payload), JSON_MIME)


def stage_worker():
    store = DriveStore.from_env()
    meeting = env("MEETING_FOLDER_ID")
    audio_folder = env("AUDIO_FOLDER_ID")
    audio_id = env("AUDIO_FILE_ID")
    index = int(env("BATCH_INDEX", "0"))
    total = int(env("BATCH_TOTAL", "0"))
    duration = float(env("MEETING_DURATION_SECONDS", "0"))
    if index < 1 or total < 1 or not meeting or not audio_folder or not audio_id:
        raise MomError("MOM-002", "Parallel batch worker is missing meeting/audio/batch parameters.")

    metadata = json.loads(store.read_bytes(store.find_one(meeting, "meeting_metadata.json")["id"]).decode("utf-8"))
    folders = {f["name"]: f["id"] for f in store.list_children(meeting, folders=True)}
    batches_folder = store.ensure_folder(meeting, "BATCHES")
    start = (index - 1) * BATCH_SECONDS
    end = min(start + BATCH_SECONDS, duration)
    batch_folder = store.ensure_folder(batches_folder, batch_folder_name(index, start, end))

    try:
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
        data = whisper_json(wav, WORK / f"transcript_{index:03d}", hint)
        local = ai_mod.segments_from_whisper(data)
        if not local:
            raise MomError("MOM-019", f"Batch {index} produced no transcript segments.")
        original = _shift_segments(local, start)
        data = _shift_whisper_data(data, start)
        data["_batch"] = {"index": index, "start_seconds": start, "end_seconds": end}
        store.upsert_text(batch_folder, "Original Transcript.txt",
                          "\n".join(ai_mod.seg_line(s) for s in original) + "\n")
        store.upsert_text(batch_folder, "Transcript.json", dump(data), JSON_MIME)

        write_batch_status(store, batches_folder, index, total, "ANALYZING",
                           f"Batch {index}/{total} — AI evidence + translation", start, end)
        batch_model = env("AI_BATCH_MODEL", "qwen3:1.7b-q4_K_M")
        json_fn, text_fn = ai_mod.make_ollama_fns(batch_model)
        ai = ai_mod.run_understanding(
            metadata, original, [], json_fn, text_fn,
            max_chars=int(env("AI_CHUNK_CHARS", "12000")), model=batch_model)
        lang = detected_language(data)
        if lang == "en":
            translation = [dict(s) for s in original]
        else:
            translation = _translation_from_ai(ai.get("translation_segments", []), original, start)
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
    except Exception:
        try:
            write_batch_status(store, batches_folder, index, total, "FAILED",
                               f"Batch {index}/{total} failed", start, end)
        except Exception:
            pass
        raise


def stage_finalize():
    store = DriveStore.from_env()
    meeting = env("MEETING_FOLDER_ID")
    total = int(env("BATCH_TOTAL", "0"))
    duration = float(env("MEETING_DURATION_SECONDS", "0"))
    if not meeting or total < 1:
        raise MomError("MOM-002", "Parallel finalizer is missing meeting/batch parameters.")
    metadata_file = store.find_one(meeting, "meeting_metadata.json")
    if not metadata_file:
        raise MomError("MOM-002", "meeting_metadata.json was not found.")
    metadata = json.loads(store.read_bytes(metadata_file["id"]).decode("utf-8"))
    folders = {f["name"]: f["id"] for f in store.list_children(meeting, folders=True)}
    batches_folder = folders.get("BATCHES") or store.ensure_folder(meeting, "BATCHES")
    transcript_folder = folders.get("TRANSCRIPT") or store.ensure_folder(meeting, "TRANSCRIPT")
    translation_folder = folders.get("TRANSLATION") or store.ensure_folder(meeting, "TRANSLATION")
    ai_folder = folders.get("AI") or store.ensure_folder(meeting, "AI")
    mom_folder = folders.get("MOM") or store.ensure_folder(meeting, "MOM")

    batch_folders = {f["name"]: f["id"] for f in store.list_children(batches_folder, folders=True)}
    batch_results, all_original, all_translation = [], [], []
    missing = []
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
        edata = json.loads(store.read_bytes(en_meta["id"]).decode("utf-8"))
        all_original.extend(ai_mod.segments_from_whisper(tdata))
        all_translation.extend(ai_mod.segments_from_whisper(edata))

    if missing:
        raise MomError("MOM-019", "Parallel batches incomplete: " + ", ".join(map(str, missing)))

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
    previous = None
    # Reuse the established final aggregation logic; all evidence came from the batch workers.
    final_ai = _aggregate_batches(metadata, batch_results, final_text_fn, previous=previous, model=final_model)
    final_ai["batch_manifest"] = {
        "total": total, "batch_seconds": BATCH_SECONDS, "duration_seconds": duration,
        "parallel": True, "batch_ai_model": env("AI_BATCH_MODEL", "qwen3:1.7b-q4_K_M"),
        "final_ai_model": final_model
    }
    validated, report = validate(final_ai, all_original, all_translation)
    evidence = dict(validated, summary=validated.get("executive_summary", ""),
                    validated=True, validation_report=report)
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
        "validation": report, "parallel_batches": total
    }), JSON_MIME)
    # Root status is written only once, after all parallel workers have succeeded.
    status = {
        "meeting_id": env("MEETING_ID"), "status": "COMPLETED", "stage": "COMPLETED",
        "progress_percent": 100, "current_stage": "batch_finalize",
        "message": f"Completed {total} parallel batches and final synthesis.",
        "updated_at": now(), "completed_at": now(), "batch_index": total, "batch_total": total
    }
    store.upsert_text(meeting, "PROCESSING_STATUS.json", dump(status), JSON_MIME)


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["prepare", "worker", "finalize"], required=True)
    args = parser.parse_args()
    if args.mode == "prepare":
        stage_prepare()
    elif args.mode == "worker":
        stage_worker()
    else:
        stage_finalize()


if __name__ == "__main__":
    main()
