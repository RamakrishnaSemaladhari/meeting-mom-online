"""Staged AI understanding (spec issues 2, 3, 4, 7).

Transcript -> chunks (original + aligned English translation) -> per-chunk
evidence -> deterministic consolidation -> Complete Conversation Summary ->
Executive Summary.  The LLM is injected (json_fn / text_fn) so the model is a
configuration choice and the stages are testable without Ollama."""
import difflib
import json
import os
import re
import urllib.error
import urllib.request

from .errors import MomError

DEFAULT_OWNER = "Not explicitly assigned"
DEFAULT_DEADLINE = "Not explicitly stated"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
SCHEMA_VERSION = "1.0"

CHUNK_KEYS = ["section_summary", "discussion_points", "decisions", "action_items",
              "commitments", "open_questions", "next_meeting", "review_flags", "translation"]
OUTPUT_KEYS = ["executive_summary", "complete_conversation_summary", "discussion_points",
               "decisions", "action_items", "commitments", "open_questions",
               "next_meeting", "review_flags"]

# JSON schema supplied directly to Ollama. This is stronger than JSON-mode alone:
# the model is constrained to the exact evidence-extraction shape before generation.
CHUNK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": CHUNK_KEYS,
    "properties": {
        "section_summary": {"type": "string"},
        "discussion_points": {"type": "array", "items": {"type": "string"}},
        "decisions": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["decision", "timestamp", "evidence"],
            "properties": {"decision": {"type": "string"}, "timestamp": {"type": "string"}, "evidence": {"type": "string"}}}},
        "action_items": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["action", "owner", "deadline", "timestamp", "evidence"],
            "properties": {"action": {"type": "string"}, "owner": {"type": "string"}, "deadline": {"type": "string"}, "timestamp": {"type": "string"}, "evidence": {"type": "string"}}}},
        "commitments": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["commitment", "owner", "deadline", "timestamp", "evidence"],
            "properties": {"commitment": {"type": "string"}, "owner": {"type": "string"}, "deadline": {"type": "string"}, "timestamp": {"type": "string"}, "evidence": {"type": "string"}}}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "next_meeting": {"type": "array", "items": {"type": "string"}},
        "review_flags": {"type": "array", "items": {"type": "string"}},
        "translation": {"type": "array", "items": {"type": "object", "additionalProperties": False,
            "required": ["timestamp", "text"],
            "properties": {"timestamp": {"type": "string"}, "text": {"type": "string"}}}},
    },
}

_EMPTY_OWNER = {"", "none", "n/a", "na", "unknown", "unassigned", "not specified", "not stated", "null"}


def fmt_ts(seconds):
    h, rem = divmod(int(max(seconds, 0)), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def segments_from_whisper(data):
    out = []
    for s in data.get("transcription") or data.get("segments") or []:
        off = s.get("offsets")
        if off and "from" in off:
            start = off["from"] / 1000.0
            end = off.get("to", off["from"]) / 1000.0
        else:
            start = float(s.get("start", 0) or 0)
            end = float(s.get("end", start) or start)
        text = (s.get("text") or "").strip()
        if text:
            out.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    return out


def seg_line(seg):
    return f"[{fmt_ts(seg['start'])} - {fmt_ts(seg['end'])}] {seg['text']}"


def chunk_segments(segments, max_chars):
    chunks, cur, size = [], [], 0
    for seg in segments:
        n = len(seg_line(seg)) + 1
        if cur and size + n > max_chars:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(seg)
        size += n
    if cur:
        chunks.append(cur)
    return chunks


def _norm_text(text):
    return " ".join(re.findall(r"\w+", text.lower()))


def translation_for_chunk(chunk, translation_segments):
    if not translation_segments or not chunk:
        return []
    lo, hi = chunk[0]["start"] - 1.0, chunk[-1]["end"] + 1.0
    picked = [t for t in translation_segments if lo <= (t["start"] + t["end"]) / 2 <= hi]
    if not picked:
        return []
    a = _norm_text(" ".join(s["text"] for s in chunk))
    b = _norm_text(" ".join(t["text"] for t in picked))
    if a and b and difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() > 0.92:
        return []
    return [seg_line(t) for t in picked]


def _post(model, messages, as_json, temperature, timeout=900, schema=None, num_predict=None):
    body = {
        "model": model, "stream": False, "messages": messages,
        "options": {
            "temperature": temperature,
            "num_ctx": int(os.environ.get("AI_NUM_CTX", "8192")),
            "num_predict": int(num_predict or os.environ.get("AI_NUM_PREDICT", "1400")),
        },
    }
    if "qwen3:1.7b" in model or "qwen3" in model:
        body["think"] = False
    if as_json:
        # Ollama structured outputs accept a JSON schema in format; this constrains
        # generation instead of asking the model to obey JSON formatting by prompt alone.
        body["format"] = schema or "json"
    req = urllib.request.Request(OLLAMA_URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()).get("message", {}).get("content", "")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise MomError("MOM-009", f"AI model '{model}' is not available in Ollama.")
        raise MomError("MOM-008", f"Ollama returned HTTP {exc.code}.")
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
        raise MomError("MOM-008", f"Ollama is unavailable: {exc}")


def make_ollama_fns(model):
    def json_fn(prompt, schema=None):
        messages = [
            {"role": "system", "content": "Return only the requested structured data. Never invent facts."},
            {"role": "user", "content": prompt}]
        # First attempt uses schema-constrained decoding. If parsing still fails, retry
        # once with the same schema at temperature 0 rather than asking the model to
        # repair its own prose output.
        content = _post(model, messages, True, 0.0, schema=schema)
        try:
            return json.loads(content)
        except ValueError:
            fixed = _post(model, messages, True, 0.0, schema=schema)
            try:
                return json.loads(fixed)
            except ValueError:
                raise MomError("MOM-010", "The AI model returned JSON that could not be parsed after schema-constrained retry.")

    def text_fn(prompt):
        messages = [
            {"role": "system", "content": "Write plain prose only. No markdown, no bullet symbols."},
            {"role": "user", "content": prompt}]
        return _post(model, messages, False, 0.2).strip()

    return json_fn, text_fn


def _s(value):
    return value.strip() if isinstance(value, str) else ("" if value is None else str(value).strip())


def _str_list(value):
    if value is None or value == "":
        return []
    if isinstance(value, (str, int, float)):
        return [_s(value)]
    if isinstance(value, dict):
        value = [", ".join(f"{k}: {_s(v)}" for k, v in value.items())]
    return [t for t in (_s(v if not isinstance(v, dict) else json.dumps(v, ensure_ascii=False)) for v in value) if t]


def _items(value, main_key, with_owner):
    if isinstance(value, (str, dict)):
        value = [value]
    out = []
    for raw in value or []:
        item = {main_key: _s(raw)} if isinstance(raw, str) else dict(raw) if isinstance(raw, dict) else {}
        main = _s(item.get(main_key))
        if not main:
            continue
        clean = {main_key: main}
        if with_owner:
            owner = _s(item.get("owner"))
            deadline = _s(item.get("deadline"))
            clean["owner"] = DEFAULT_OWNER if owner.lower() in _EMPTY_OWNER else owner
            clean["deadline"] = DEFAULT_DEADLINE if deadline.lower() in _EMPTY_OWNER else deadline
        clean["timestamp"] = _s(item.get("timestamp"))
        clean["evidence"] = _s(item.get("evidence"))
        clean["review_flag"] = _s(item.get("review_flag"))
        out.append(clean)
    return out


def normalize_chunk(obj):
    obj = obj if isinstance(obj, dict) else {}
    return {
        "section_summary": _s(obj.get("section_summary") or obj.get("summary")),
        "translation": [
            {"timestamp": _s(x.get("timestamp")), "text": _s(x.get("text"))}
            for x in (obj.get("translation") or []) if isinstance(x, dict) and _s(x.get("text"))
        ],
        "discussion_points": _str_list(obj.get("discussion_points")),
        "decisions": _items(obj.get("decisions"), "decision", False),
        "action_items": _items(obj.get("action_items"), "action", True),
        "commitments": _items(obj.get("commitments"), "commitment", True),
        "open_questions": _str_list(obj.get("open_questions")),
        "next_meeting": _str_list(obj.get("next_meeting")),
        "review_flags": _str_list(obj.get("review_flags")),
    }


def _dedupe(items, key=None):
    seen, out = {}, []
    for item in items:
        text = item if key is None else item[key]
        k = _norm_text(text)
        if not k:
            continue
        if k in seen:
            if key and not out[seen[k]].get("evidence") and item.get("evidence"):
                out[seen[k]] = item
            continue
        seen[k] = len(out)
        out.append(item)
    return out


def merge_sections(sections):
    return {
        "discussion_points": _dedupe([p for s in sections for p in s["discussion_points"]]),
        "decisions": _dedupe([d for s in sections for d in s["decisions"]], "decision"),
        "action_items": _dedupe([a for s in sections for a in s["action_items"]], "action"),
        "commitments": _dedupe([c for s in sections for c in s["commitments"]], "commitment"),
        "open_questions": _dedupe([q for s in sections for q in s["open_questions"]]),
        "next_meeting": _dedupe([n for s in sections for n in s["next_meeting"]]),
        "review_flags": _dedupe([f for s in sections for f in s["review_flags"]]),
    }


RULES = """Rules:
- Never invent facts. Use only what is in the transcript.
- A suggestion is NOT a decision. A possibility is NOT a commitment.
- A discussed date is NOT a deadline unless it was explicitly committed.
- If the owner is not explicit, use "Not explicitly assigned".
- If the deadline is not explicit, use "Not explicitly stated".
- Every decision, action item and commitment needs "timestamp" (HH:MM:SS of the relevant segment) and "evidence" (a short quote or close paraphrase from the transcript).
- Participant metadata is context only; it is NOT proof of who said anything.
- Preserve ambiguity and conflicting statements in review_flags. Do not silently resolve conflicting dates.
- next_meeting: only if a next meeting was explicitly mentioned, otherwise [].
- Do not turn AI inference into meeting content."""


def _meta_for_prompt(metadata):
    keep = ["title", "meeting_type", "meeting_subtype", "date", "start_time", "end_time", "venue", "mode", "agenda", "learning_context", "case_reference", "legal_objective", "drafting_instruction", "session_notes", "participants"]
    return json.dumps({k: metadata.get(k) for k in keep if metadata.get(k)}, ensure_ascii=False, indent=1)


def _type_guidance(metadata):
    meeting_type = str(metadata.get("meeting_type") or "meeting_mom")
    subtype = str(metadata.get("meeting_subtype") or "general")
    if meeting_type == "legal_stage_1_analysis":
        return ("Legal Stage 1: separate transcript facts from legal analysis. Extract stated facts, issues, "
                "possible provisions/charges only when actually discussed, arguments, risks and unresolved questions. "
                "Do not present a legal conclusion that was not stated in the discussion.")
    if meeting_type == "legal_stage_2_verification":
        return ("Legal Stage 2: treat uploaded reference documents as separate evidence when available. "
                "Identify document-versus-discussion discrepancies and mark every unverified point for review. "
                "Do not silently resolve conflicts.")
    if meeting_type == "legal_stage_3_drafting":
        return ("Legal Stage 3: capture the exact drafting objective, document requested, material clauses/facts, "
                "instructions, approvals and unresolved drafting points. Do not invent legal text or authorities.")
    if meeting_type == "legal_client_case":
        return ("Legal client/case discussion: preserve client-stated facts, issues, instructions, commitments and "
                "follow-ups separately from legal analysis. Mark uncertain or disputed facts for review.")
    if meeting_type == "lecture_learning":
        return ("Lecture/learning mode: emphasize concepts taught, explanations, examples, questions, takeaways, "
                "learning gaps and follow-up study items. Do not turn examples into factual claims about the learner.")
    if meeting_type == "notes":
        return ("Notes mode: produce a faithful structured record of the supplied conversation/notes, preserving "
                "important observations and uncertainty rather than forcing a formal MoM.")
    if meeting_type == "continuity_comparison":
        return ("Continuity/comparison mode: distinguish current-session evidence from prior documents or prior MoM. "
                "Highlight changes, unresolved carry-forward items and explicit confirmations.")
    return f"Meeting type: {meeting_type}; subtype: {subtype}. Structure the output according to the stated purpose while preserving the evidence-first rules."


def chunk_prompt(metadata, index, total, chunk, translation_lines):
    translation = ""
    if translation_lines:
        translation = ("\nENGLISH TRANSLATION of the same time span (use for understanding; "
                       "keep original wording in mind):\n" + "\n".join(translation_lines) + "\n")
    return f"""You are the evidence-first meeting understanding engine.
This is section {index} of {total} of ONE meeting, covering {fmt_ts(chunk[0]['start'])} to {fmt_ts(chunk[-1]['end'])}.

Meeting metadata (context only):
{_meta_for_prompt(metadata)}

Type-specific processing guidance:
{_type_guidance(metadata)}

ORIGINAL TRANSCRIPT (timestamped):
{chr(10).join(seg_line(s) for s in chunk)}
{translation}
Return ONLY valid JSON with exactly these keys:
section_summary, discussion_points, decisions, action_items, commitments, open_questions, next_meeting, review_flags, translation

section_summary: a detailed chronological account (6-12 sentences) of what was discussed in THIS section: topics, explanations, concerns, alternatives, changes in direction, conclusions, unresolved matters.
discussion_points: array of short strings.
decisions: objects with keys decision, timestamp, evidence.
action_items: objects with keys action, owner, deadline, timestamp, evidence.
commitments: objects with keys commitment, owner, deadline, timestamp, evidence.
open_questions, next_meeting, review_flags: arrays of strings.
translation: timestamped English translation of the ORIGINAL TRANSCRIPT for this section. If the original is already English, copy the original text. Preserve meaning; do not summarize or omit content.

{RULES}"""


def complete_summary_prompt(metadata, section_summaries):
    numbered = "\n\n".join(f"Section {i} summary:\n{t}" for i, t in enumerate(section_summaries, 1))
    return f"""You are summarizing the complete conversation of a meeting, not merely extracting action items.

Describe the meeting from beginning to end.

Capture: purpose, opening context, topics discussed, explanations, concerns, alternatives, disagreements or uncertainty, changes in direction, conclusions, decisions, unresolved matters, and closing/follow-up context.

Do not invent information. Do not turn suggestions into decisions. Do not add facts that are absent from the section summaries below.
The result must be a coherent account of the entire conversation, written as several paragraphs of plain prose in chronological order.

Meeting metadata (context only):
{_meta_for_prompt(metadata)}

Type-specific processing guidance:
{_type_guidance(metadata)}

Chronological section summaries (each derived directly from the transcript):
{numbered}"""


def executive_summary_prompt(metadata, complete_summary, merged):
    decisions = "\n".join(f"- {d['decision']}" for d in merged["decisions"]) or "- None explicitly recorded"
    actions = "\n".join(f"- {a['action']} (owner: {a['owner']}; deadline: {a['deadline']})"
                        for a in merged["action_items"]) or "- None explicitly recorded"
    issues = "\n".join(f"- {q}" for q in merged["open_questions"] + merged["review_flags"]) or "- None recorded"
    return f"""Write a concise management-level executive summary of this meeting in plain prose (no markdown).
Cover, in short labelled lines: Purpose; Major outcomes; Critical decisions; Key actions; Important risks/issues; Immediate next steps.
Use ONLY the information below. Do not invent anything. If a category has nothing recorded, say so briefly.

Meeting metadata (context only):
{_meta_for_prompt(metadata)}

Type-specific processing guidance:
{_type_guidance(metadata)}

Complete conversation summary:
{complete_summary}

Recorded decisions:
{decisions}

Recorded action items:
{actions}

Open questions and review flags:
{issues}"""


def run_understanding(metadata, original_segments, translation_segments, json_fn, text_fn,
                      max_chars=8000, progress=None, model=""):
    if not original_segments:
        raise MomError("MOM-010", "Whisper produced no timestamped transcript segments.")
    chunks = chunk_segments(original_segments, max_chars)
    sections = []
    translation_out = []
    for i, chunk in enumerate(chunks, 1):
        if progress:
            progress("ANALYZING", f"Evidence extraction {i}/{len(chunks)}", 60 + int(15 * (i - 1) / len(chunks)))
        raw = json_fn(chunk_prompt(metadata, i, len(chunks), chunk,
                                   translation_for_chunk(chunk, translation_segments)), CHUNK_SCHEMA)
        normalized = normalize_chunk(raw)
        sections.append(normalized)
        for item in normalized.get("translation", []):
            translation_out.append({
                "timestamp": item.get("timestamp", ""),
                "text": item.get("text", "")
            })

    merged = merge_sections(sections)
    section_texts = [s["section_summary"] for s in sections]
    for i, t in enumerate(section_texts, 1):
        if not t:
            merged["review_flags"].append(f"Section {i}: the AI produced no narrative summary; review the transcript.")
    usable = [t for t in section_texts if t]

    if progress:
        progress("SUMMARIZING", "Writing Complete Conversation Summary", 78)
    if not usable:
        complete = ""
    elif len(usable) == 1:
        complete = usable[0]
    else:
        complete = text_fn(complete_summary_prompt(metadata, usable))
    if not complete:
        merged["review_flags"].append("Complete Conversation Summary could not be produced.")

    if progress:
        progress("SUMMARIZING", "Writing Executive Summary", 83)
    executive = text_fn(executive_summary_prompt(metadata, complete, merged)) if complete else ""
    if not executive:
        merged["review_flags"].append("Executive Summary could not be produced.")

    result = {"executive_summary": executive, "complete_conversation_summary": complete}
    result.update(merged)
    result = {k: result[k] for k in OUTPUT_KEYS}
    result["schema_version"] = SCHEMA_VERSION
    result["generated_with"] = {"ai_model": model, "sections": len(chunks)}
    result["translation_segments"] = translation_out
    return result
