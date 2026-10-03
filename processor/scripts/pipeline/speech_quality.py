"""Audio health check and transcript quality gate.

Whisper can fall into a decoding loop (the same phrase repeated for the whole
recording).  That text must never reach translation, Qwen or the MoM.  These
checks are pure functions so they can be tested without Whisper:

    audio_report_from_ffmpeg(stderr)  -> metrics dict
    assess_audio(metrics)             -> (problems, warnings)    problems => MOM-020
    assess_transcript(segments, ...)  -> {"passed", "problems", "metrics"}   => MOM-019
"""
import difflib
import re
from collections import Counter

# Spec extension: MOM-019 transcript quality, MOM-020 audio health.
MIN_CHARS = 20
MIN_TOKENS_FOR_LOOP_CHECKS = 40
WINDOW_TOKENS = 200            # vocabulary repeats naturally over a long meeting, so measure per window
WINDOW_UNIQUE_FLOOR = 0.15     # real speech sits well above this in any 200-word window; loops sit near 0.02
BAD_WINDOW_SHARE = 0.30
REPEATED_SEGMENT_CEILING = 0.50
DUPLICATE_RUN_LIMIT = 5
NGRAM_LOOP_CEILING = 0.50
NGRAM_REPEAT_MIN = 8
COVERAGE_FLOOR = 0.35
COVERAGE_MIN_AUDIO_SECONDS = 180

SILENT_MAX_VOLUME_DB = -55.0
QUIET_MEAN_VOLUME_DB = -45.0
MOSTLY_SILENT_RATIO = 0.85
MIN_AUDIO_SECONDS = 3.0

_WORD = re.compile(r"[\w\u0900-\u0DFF]+", re.UNICODE)


# --------------------------------------------------------------- audio health
def _hms_to_seconds(h, m, s):
    return int(h) * 3600 + int(m) * 60 + float(s)


def audio_report_from_ffmpeg(stderr):
    """Parse `ffmpeg -af volumedetect,silencedetect -f null -` output."""
    report = {}
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    if m:
        report["duration_seconds"] = _hms_to_seconds(*m.groups())
    for key in ("mean_volume", "max_volume"):
        m = re.search(key + r":\s*(-?\d+(?:\.\d+)?)\s*dB", stderr)
        if m:
            report[key + "_db"] = float(m.group(1))
    silence = [float(x) for x in re.findall(r"silence_duration:\s*(\d+(?:\.\d+)?)", stderr)]
    report["silence_seconds"] = round(sum(silence), 2)
    duration = report.get("duration_seconds")
    if duration:
        report["silence_ratio"] = round(min(report["silence_seconds"] / duration, 1.0), 3)
    return report


def assess_audio(report):
    """Returns (problems, warnings).  Problems mean the audio cannot be transcribed usefully."""
    problems, warnings = [], []
    duration = report.get("duration_seconds")
    if duration is not None and duration < MIN_AUDIO_SECONDS:
        problems.append(f"The recording is only {duration:.1f} seconds long.")
    max_db = report.get("max_volume_db")
    if max_db is not None and max_db < SILENT_MAX_VOLUME_DB:
        problems.append(f"The recording is effectively silent (peak level {max_db:.0f} dB).")
    mean_db = report.get("mean_volume_db")
    if mean_db is not None and mean_db < QUIET_MEAN_VOLUME_DB and not problems:
        warnings.append(f"The recording is very quiet (average level {mean_db:.0f} dB); accuracy may suffer.")
    ratio = report.get("silence_ratio")
    if ratio is not None and ratio > MOSTLY_SILENT_RATIO and not problems:
        warnings.append(f"About {ratio:.0%} of the recording is silence.")
    return problems, warnings


# ---------------------------------------------------------- transcript quality
def _norm(text):
    return " ".join(_WORD.findall(text.lower()))


def _longest_duplicate_run(normalized):
    longest = run = 1 if normalized else 0
    for prev, cur in zip(normalized, normalized[1:]):
        same = bool(prev) and bool(cur) and (
            prev == cur or difflib.SequenceMatcher(None, prev, cur, autojunk=False).ratio() >= 0.9)
        run = run + 1 if same else 1
        longest = max(longest, run)
    return longest


def _bad_window_share(tokens):
    """Share of 200-word windows whose vocabulary is implausibly small (a repetition loop)."""
    if len(tokens) < WINDOW_TOKENS // 2:
        return 0.0
    windows = [tokens[i:i + WINDOW_TOKENS] for i in range(0, len(tokens), WINDOW_TOKENS)]
    if len(windows) > 1 and len(windows[-1]) < WINDOW_TOKENS // 2:
        windows.pop()  # ignore a short tail
    bad = sum(len(set(w)) / len(w) < WINDOW_UNIQUE_FLOOR for w in windows)
    return bad / len(windows)


def _ngram_loop_ratio(tokens, n=3):
    if len(tokens) < n + 1:
        return 0.0
    grams = [tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)]
    counts = Counter(grams)
    looped = sum(c for c in counts.values() if c >= NGRAM_REPEAT_MIN)
    return looped / len(grams)


def assess_transcript(segments, audio_seconds=None):
    texts = [str(s.get("text", "")).strip() for s in segments if str(s.get("text", "")).strip()]
    compact = re.sub(r"\s+", " ", " ".join(texts)).strip()
    tokens = _norm(compact).split()
    normalized = [_norm(t) for t in texts]

    unique_ratio = len(set(tokens)) / max(1, len(tokens))
    repeated_ratio = 0.0
    if len(texts) >= 6:
        counts = Counter(n for n in normalized if n)
        repeated_ratio = max(counts.values(), default=0) / len(normalized)
    run = _longest_duplicate_run(normalized)
    ngram_ratio = _ngram_loop_ratio(tokens)
    bad_windows = _bad_window_share(tokens)
    replacements = compact.count("\ufffd")
    last_end = max((float(s.get("end", 0) or 0) for s in segments), default=0.0)
    coverage = (last_end / audio_seconds) if audio_seconds else None

    problems = []
    if len(compact) < MIN_CHARS:
        problems.append("almost no speech text was produced")
    if replacements > max(10, len(compact) // 200):
        problems.append(f"{replacements} invalid characters in the text")
    if len(tokens) >= MIN_TOKENS_FOR_LOOP_CHECKS:
        if bad_windows >= BAD_WINDOW_SHARE:
            problems.append(f"{bad_windows:.0%} of the transcript has almost no distinct words (repetition loop)")
        if ngram_ratio >= NGRAM_LOOP_CEILING:
            problems.append(f"{ngram_ratio:.0%} of the text is the same phrase repeated")
    if repeated_ratio >= REPEATED_SEGMENT_CEILING:
        problems.append(f"{repeated_ratio:.0%} of the segments are identical")
    if run >= DUPLICATE_RUN_LIMIT:
        problems.append(f"{run} consecutive near-identical segments")
    if audio_seconds and audio_seconds >= COVERAGE_MIN_AUDIO_SECONDS and coverage is not None and coverage < COVERAGE_FLOOR:
        problems.append(f"the transcript ends at {coverage:.0%} of the recording")

    return {
        "passed": not problems,
        "problems": problems,
        "metrics": {
            "usable_characters": len(compact),
            "token_count": len(tokens),
            "unique_token_ratio": round(unique_ratio, 4),
            "low_variety_window_share": round(bad_windows, 3),
            "repeated_segment_ratio": round(repeated_ratio, 4),
            "longest_duplicate_run": run,
            "repeated_phrase_ratio": round(ngram_ratio, 4),
            "invalid_characters": replacements,
            "coverage_ratio": None if coverage is None else round(coverage, 3),
        },
    }
