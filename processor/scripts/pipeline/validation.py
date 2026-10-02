"""Evidence validation (spec issue 8) - runs before the MoM is created.

Conservative by design: items with NO evidence are removed from the official
lists (and reported in review_flags); items whose evidence can't be matched to
the transcript are kept but flagged; owners/deadlines/next-meeting entries the
transcript doesn't support are reset or dropped.  Nothing is silently invented.
"""
import re

from .ai_understanding import DEFAULT_DEADLINE, DEFAULT_OWNER

TOKEN = re.compile(r"[\w\u0900-\u0DFF]+", re.UNICODE)
NEXT_MEETING_HINT = re.compile(
    r"next\s+(meeting|call|session|review|sync)|meet\s+again|follow[\s-]?up\s+(meeting|call)|"
    r"reconvene|see\s+you\s+(on|next|at|tomorrow)|catch\s+up\s+(on|next)|"
    r"(next|coming)\s+(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
    re.IGNORECASE)
WINDOW_SECONDS = 90
SUPPORT_WINDOW = 0.70
SUPPORT_WHOLE = 0.85


def _tokens(text, min_len=3):
    return [t for t in TOKEN.findall(text.lower()) if len(t) >= min_len]


def parse_ts_seconds(ts):
    m = re.search(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", ts or "")
    if m:
        a, b, c = int(m.group(1)), int(m.group(2)), m.group(3)
        return a * 3600 + b * 60 + int(c) if c is not None else a * 60 + b
    m = re.fullmatch(r"\s*\[?\s*(\d+(?:\.\d+)?)\s*s?\]?\s*", ts or "")
    return float(m.group(1)) if m else None


class Corpus:
    def __init__(self, original_segments, translation_segments):
        self.segments = list(original_segments) + list(translation_segments or [])
        self.whole = set(_tokens(" ".join(s["text"] for s in self.segments), 2))

    def window(self, seconds):
        if seconds is None:
            return self.whole
        lo, hi = seconds - WINDOW_SECONDS, seconds + WINDOW_SECONDS
        text = " ".join(s["text"] for s in self.segments if s["end"] >= lo and s["start"] <= hi)
        return set(_tokens(text, 2))


def _support(evidence, token_set):
    toks = _tokens(evidence)
    if len(toks) < 2:
        return 0.0
    return sum(t in token_set for t in toks) / len(toks)


def _flag(item, text):
    item["review_flag"] = (item["review_flag"] + "; " if item.get("review_flag") else "") + text


def _check_item(item, kind, main_key, corpus, report):
    label = f"{kind}: {item[main_key][:80]}"
    if not item.get("evidence"):
        report["removed_no_evidence"].append(label)
        return None
    seconds = parse_ts_seconds(item.get("timestamp"))
    window = corpus.window(seconds)
    if _support(item["evidence"], window) >= SUPPORT_WINDOW:
        pass
    elif seconds is not None and _support(item["evidence"], corpus.whole) >= SUPPORT_WHOLE:
        _flag(item, "Evidence found elsewhere in the transcript; timestamp may be inaccurate")
        report["flagged"].append(label + " (timestamp)")
    else:
        _flag(item, "Evidence could not be verified against the transcript")
        report["flagged"].append(label + " (evidence unverified)")
    if not item.get("timestamp"):
        _flag(item, "No timestamp provided")

    if "owner" in item:
        if item["owner"] != DEFAULT_OWNER:
            name_tokens = _tokens(item["owner"])
            if not name_tokens or not any(t in window or t in corpus.whole for t in name_tokens):
                report["owners_reset"].append(f"{label} (was '{item['owner']}')")
                _flag(item, f"Owner '{item['owner']}' was not supported by the transcript and was reset")
                item["owner"] = DEFAULT_OWNER
        if item["deadline"] != DEFAULT_DEADLINE:
            parts = _tokens(item["deadline"], 1)
            if not parts or sum(t in window or t in corpus.whole for t in parts) / len(parts) < 0.5:
                report["deadlines_reset"].append(f"{label} (was '{item['deadline']}')")
                _flag(item, f"Deadline '{item['deadline']}' was not supported by the transcript and was reset")
                item["deadline"] = DEFAULT_DEADLINE
    return item


def validate(ai, original_segments, translation_segments):
    corpus = Corpus(original_segments, translation_segments)
    report = {"removed_no_evidence": [], "flagged": [], "owners_reset": [],
              "deadlines_reset": [], "next_meeting_dropped": []}
    out = dict(ai)

    for key, kind, main in (("decisions", "Decision", "decision"),
                            ("action_items", "Action", "action"),
                            ("commitments", "Commitment", "commitment")):
        kept = []
        for item in ai.get(key, []):
            checked = _check_item(dict(item), kind, main, corpus, report)
            if checked is not None:
                kept.append(checked)
        out[key] = kept

    full_text = " ".join(s["text"] for s in corpus.segments)
    has_hint = bool(NEXT_MEETING_HINT.search(full_text))
    kept_meetings = []
    for entry in ai.get("next_meeting", []):
        if has_hint and _support(entry, corpus.whole) >= 0.6:
            kept_meetings.append(entry)
        else:
            report["next_meeting_dropped"].append(entry)
    out["next_meeting"] = kept_meetings

    flags = list(ai.get("review_flags", []))
    for label in report["removed_no_evidence"]:
        flags.append(f"Removed (no evidence): {label}")
    for label in report["owners_reset"]:
        flags.append(f"Owner reset to '{DEFAULT_OWNER}': {label}")
    for label in report["deadlines_reset"]:
        flags.append(f"Deadline reset to '{DEFAULT_DEADLINE}': {label}")
    for entry in report["next_meeting_dropped"]:
        flags.append(f"Next-meeting statement not supported by the transcript and removed: {entry[:120]}")
    out["review_flags"] = flags

    report["counts"] = {k: len(out[k]) for k in ("decisions", "action_items", "commitments", "open_questions", "review_flags")}
    report["passed"] = True
    return out, report
