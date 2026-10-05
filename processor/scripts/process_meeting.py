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
from pipeline.speech_quality import assess_audio, assess_transcript, audio_report_from_ffmpeg
from pipeline.validation import validate

WORK = Path(".meeting_work")
WHISPER = Path("whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = Path(os.environ.get("WHISPER_MODEL_PATH", "whisper.cpp/models/ggml-small-q5_1.bin"))
# Optional stronger multilingual model, used only when the primary transcript fails the quality gate.
# (large-v3-turbo cannot translate, so it is used for transcription only.)
FALLBACK_MODEL = Path(os.environ.get("WHISPER_FALLBACK_MODEL_PATH", "whisper.cpp/models/ggml-large-v3-turbo-q5_0.bin"))
VAD_MODEL = Path(os.environ.get("WHISPER_VAD_MODEL_PATH", "whisper.cpp/models/ggml-silero-v5.1.2.bin"))
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


def whisper_json(wav, base, translate=False, model=None, language="auto"):
    model = Path(model) if model else WHISPER_MODEL
    if not WHISPER.exists():
        raise MomError("MOM-005", f"Whisper executable not found at {WHISPER}.")
    if not model.exists() or model.stat().st_size == 0:
        raise MomError("MOM-006", f"Whisper model not found at {model}.")
    if not VAD_MODEL.exists() or VAD_MODEL.stat().st_size == 0:
        raise MomError("MOM-006", f"Whisper VAD model not found at {VAD_MODEL}.")

    # Reduce cross-window repetition/hallucination on long or noisy recordings.
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


def audio_health(wav, status=None):
    """Measure level/silence/duration of the 16 kHz WAV. Hard-fails only on unusable audio (MOM-020)."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav),
             "-af", "volumedetect,silencedetect=noise=-40dB:d=1", "-f", "null", "-"],
            capture_output=True, text=True, timeout=300)
        report = audio_report_from_ffmpeg(proc.stderr)
    except Exception as exc:  # the check is advisory when it cannot run
        log(f"WARNING: audio health check could not run: {exc}")
        return {}, []
    problems, warnings = assess_audio(report)
    log("Audio health: " + json.dumps(report))
    for w in warnings:
        log("WARNING: " + w)
    if problems:
        raise MomError("MOM-020", "Audio health check failed: " + " ".join(problems))
    return report, warnings


def language_hint(metadata_hint=""):
    """'auto' or a single ISO code. Never a combined value such as 'en/te/hi'."""
    value = (env("WHISPER_LANGUAGE") or metadata_hint or "auto").strip().lower()
    return value if re.fullmatch(r"[a-z]{2,3}", value) else "auto"


def detected_language(data):
    return str(((data.get("result") or {}).get("language")) or "").lower()


def transcribe_with_gate(wav, base_name, audio_seconds, language, status=None):
    """Primary model -> quality gate -> stronger model -> quality gate -> MOM-019.

    Bad Whisper text must never reach translation or the AI stage."""
    models = [("primary", WHISPER_MODEL)]
    if FALLBACK_MODEL.exists() and FALLBACK_MODEL.stat().st_size > 0 and FALLBACK_MODEL != WHISPER_MODEL:
        models.append(("fallback", FALLBACK_MODEL))
    attempts = []
    for index, (label, model) in enumerate(models):
        if index and status:
            status.update("TRANSCRIBING", "Transcript quality check failed; retrying with a stronger Whisper model", 30)
        data = whisper_json(wav, WORK / f"{base_name}_{label}", model=model, language=language)
        segments = ai_mod.segments_from_whisper(data)
        verdict = assess_transcript(segments, audio_seconds)
        attempts.append({"label": label, "model": model.name, "passed": verdict["passed"],
                         "problems": verdict["problems"], "metrics": verdict["metrics"]})
        log(f"Transcript quality [{label} {model.name}]: " + json.dumps(attempts[-1]))
        if verdict["passed"]:
            data["_quality"] = dict(verdict["metrics"], passed=True, model_used=model.name,
                                    attempts=attempts, language=detected_language(data))
            return data, segments
    reasons = "; ".join(f"{a['model']}: " + ", ".join(a["problems"]) for a in attempts)
    hint = "" if len(models) > 1 else " (no stronger fallback model is installed)"
    raise MomError("MOM-019", f"Transcript quality check failed - {reasons}{hint}. "
                              "Whisper output was discarded; please verify the recording has clear speech.")


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
    log(f"Downloading meeting audio: {audio.get('name')}")
    st.update("DOWNLOADING", "Downloading audio from Google Drive", 6)
    ctx.store.download(audio["id"], ctx.p["source"])
    st.update("CONVERTING", "Converting audio to 16 kHz mono WAV")
    run_cmd(["ffmpeg", "-y", "-i", str(ctx.p["source"]), "-ar", "16000", "-ac", "1",
             "-c:a", "pcm_s16le", str(ctx.p["wav"])], "MOM-004")

    report, audio_warnings = audio_health(ctx.p["wav"])
    warnings = warnings + audio_warnings
    ctx.p["warnings"].write_text(dump(warnings), encoding="utf-8")

    try:
        hint = language_hint(load_metadata(ctx).get("language_hint", ""))
    except Exception:
        hint = language_hint()
    st.update("TRANSCRIBING", "Transcribing with Whisper")
    data, segments = transcribe_with_gate(ctx.p["wav"], "transcript", report.get("duration_seconds"), hint, st)
    data["_audio"] = report
    ctx.p["transcript_json"].write_text(dump(data), encoding="utf-8")
    st.update("TRANSCRIBING", "Saving original transcript", 40)
    ctx.store.upsert_text(ctx.folders["TRANSCRIPT"], "Original Transcript.txt", timestamped_text(segments))
    ctx.store.upsert_text(ctx.folders["TRANSCRIPT"], "Transcript.json", dump(data), JSON_MIME)


def stage_translation(ctx):
    st = ctx.status
    if not ctx.p["wav"].exists():
        raise MomError("MOM-007", "WAV audio is missing before the translation stage.")
    transcript = json.loads(ctx.p["transcript_json"].read_text(encoding="utf-8")) if ctx.p["transcript_json"].exists() else {}
    language = (transcript.get("_quality") or {}).get("language") or detected_language(transcript)
    folder = ctx.folders["TRANSLATION"]

    if language == "en":
        # English audio: a second Whisper pass would only repeat the transcript (and the risk of a loop).
        st.update("TRANSLATING", "Recording is English; no translation needed", 55)
        data = {"transcription": transcript.get("transcription", []), "result": {"language": "en"},
                "_quality": {"passed": True, "skipped": "source language is English"}}
        segments = ai_mod.segments_from_whisper(data)
    else:
        st.update("TRANSLATING", "Translating to English with Whisper")
        try:
            data = whisper_json(ctx.p["wav"], WORK / "translation", translate=True)
            segments = ai_mod.segments_from_whisper(data)
            verdict = assess_transcript(segments, (transcript.get("_audio") or {}).get("duration_seconds"))
            if not verdict["passed"]:
                raise MomError("MOM-019", "Translation quality check failed - " + ", ".join(verdict["problems"]))
            data["_quality"] = dict(verdict["metrics"], passed=True)
        except MomError as exc:
            if exc.code not in ("MOM-019", "MOM-007"):
                raise
            # Degrade rather than feed a bad translation to the AI: the original transcript passed its gate.
            log(f"WARNING [{exc.code}] English translation discarded: {exc.message}")
            data = {"transcription": [], "_quality": {"passed": False, "error_code": exc.code, "reason": exc.message}}
            segments = []
            warnings = json.loads(ctx.p["warnings"].read_text(encoding="utf-8")) if ctx.p["warnings"].exists() else []
            warnings.append("English translation was discarded because it failed its quality check; "
                            "the AI used the original transcript only. " + exc.message[:200])
            ctx.p["warnings"].write_text(dump(warnings), encoding="utf-8")
    ctx.p["translation_json"].write_text(dump(data), encoding="utf-8")
    if segments:
        ctx.store.upsert_text(folder, "English Translation.txt", timestamped_text(segments))
    else:
        ctx.store.upsert_text(folder, "English Translation.txt",
                              "No separate English translation was produced for this meeting.\n")
    ctx.store.upsert_text(folder, "Translation.json", dump(data), JSON_MIME)
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
    model = env("AI_MODEL", "qwen3:4b-instruct-2507-q4_K_M")
    json_fn, text_fn = ai_mod.make_ollama_fns(model)
    ai = ai_mod.run_understanding(
        metadata, original, translation, json_fn, text_fn,
        max_chars=int(env("AI_CHUNK_CHARS", "8000")),
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


from pipeline.batch_processor import stage_batch\n\nSTAGES = {"init": stage_init, "whisper": stage_whisper, "translation": stage_translation,\n          "ai": stage_ai, "mom": stage_mom, "batch": stage_batch, "fail": stage_fail}\n\n\ndef main():
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
