"""Offline tests: no Drive, Whisper or Ollama needed. Fast-path regression coverage. Run from the repo root:
    python -m unittest discover -s processor/tests -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import process_meeting as pm  # noqa: E402
from docx import Document  # noqa: E402
from pipeline import ai_understanding as ai  # noqa: E402
from pipeline.docx_builder import build_mom_doc  # noqa: E402
from pipeline.drive_store import FOLDER, choose_audio, select_audio  # noqa: E402
from pipeline.errors import MomError  # noqa: E402
from pipeline.status import StatusReporter, sanitize  # noqa: E402
from pipeline.validation import parse_ts_seconds, validate  # noqa: E402


class FakeStore:
    """In-memory stand-in for DriveStore."""
    def __init__(self):
        self.files = {}      # (parent, name) -> bytes
        self.folders = {}    # (parent, name) -> id
        self.meta = {}       # file_id -> meta
        self.audio_bytes = b"fake-audio"

    def ensure_folder(self, parent, name):
        return self.folders.setdefault((parent, name), f"{parent}/{name}")

    def list_children(self, parent, name=None, folders=None):
        return [m for m in self.meta.values() if parent in m.get("parents", [])
                and (folders is None or (m["mimeType"] == FOLDER) == folders)]

    def find_one(self, parent, name):
        if (parent, name) in self.files:
            return {"id": f"{parent}::{name}", "name": name}
        return None

    def read_bytes(self, file_id):
        parent, name = file_id.split("::")
        return self.files[(parent, name)]

    def get_meta(self, file_id):
        if file_id not in self.meta:
            raise MomError("MOM-001", "not found")
        return self.meta[file_id]

    def download(self, file_id, dest):
        Path(dest).write_bytes(self.audio_bytes)

    def upsert_text(self, parent, name, text, mime="text/plain"):
        self.files[(parent, name)] = text.encode("utf-8")

    def upsert_file(self, parent, name, path, mime):
        self.files[(parent, name)] = Path(path).read_bytes()

    def text(self, parent, name):
        return self.files[(parent, name)].decode("utf-8")


def seg(a, b, text):
    return {"start": a, "end": b, "text": text}


TRANSCRIPT = [
    seg(0, 20, "Welcome everyone. Today we review the vendor contract and the release schedule."),
    seg(20, 60, "Ravi said the vendor contract needs legal review before signing."),
    seg(60, 100, "We decided to postpone the release until the security audit is complete."),
    seg(100, 140, "Priya will send the audit checklist to the team by Friday."),
    seg(140, 180, "Maybe we could also look at a new logo someday, no commitment on that."),
    seg(180, 200, "Let us meet again next Tuesday to confirm the audit status."),
]


class WhisperParsing(unittest.TestCase):
    def test_offsets_are_milliseconds(self):
        data = {"transcription": [{"offsets": {"from": 500, "to": 2500}, "text": " Hello "}]}
        self.assertEqual(ai.segments_from_whisper(data), [{"start": 0.5, "end": 2.5, "text": "Hello"}])

    def test_empty_segments_dropped(self):
        data = {"transcription": [{"offsets": {"from": 0, "to": 1000}, "text": "  "}]}
        self.assertEqual(ai.segments_from_whisper(data), [])


class Chunking(unittest.TestCase):
    def test_chunks_respect_budget_and_order(self):
        chunks = ai.chunk_segments(TRANSCRIPT, 200)
        self.assertGreater(len(chunks), 1)
        self.assertEqual([s for c in chunks for s in c], TRANSCRIPT)

    def test_english_translation_not_duplicated(self):
        self.assertEqual(ai.translation_for_chunk(TRANSCRIPT, [dict(s) for s in TRANSCRIPT]), [])

    def test_foreign_translation_included_and_time_aligned(self):
        orig = [seg(0, 10, "నమస్కారం అందరికీ"), seg(10, 20, "ఈ రోజు ఒప్పందం గురించి")]
        trans = [seg(0, 10, "Hello everyone"), seg(10, 20, "Today about the contract"), seg(500, 510, "far away")]
        lines = ai.translation_for_chunk(orig, trans)
        self.assertEqual(len(lines), 2)
        self.assertIn("Hello everyone", lines[0])


class AudioSelection(unittest.TestCase):
    F1 = {"id": "a", "name": "old.m4a", "createdTime": "2026-01-01T00:00:00Z"}
    F2 = {"id": "b", "name": "new.m4a", "createdTime": "2026-02-01T00:00:00Z"}

    def test_single_file_ok(self):
        self.assertEqual(choose_audio([self.F1], strict=True)[0]["id"], "a")

    def test_none_is_mom001(self):
        with self.assertRaises(MomError) as cm:
            choose_audio([])
        self.assertEqual(cm.exception.code, "MOM-001")

    def test_ambiguous_strict_refuses(self):
        with self.assertRaises(MomError):
            choose_audio([self.F1, self.F2], strict=True)

    def test_ambiguous_lenient_picks_newest_with_warning(self):
        f, warnings = choose_audio([self.F1, self.F2], strict=False)
        self.assertEqual(f["id"], "b")
        self.assertEqual(len(warnings), 1)

    def test_exact_file_id_wins_over_newer_file(self):
        store = FakeStore()
        store.meta = {"a": dict(self.F1, mimeType="audio/mp4", parents=["AUD"]),
                      "b": dict(self.F2, mimeType="audio/mp4", parents=["AUD"])}
        f, warnings = select_audio(store, "AUD", "a", strict=True)
        self.assertEqual((f["id"], warnings), ("a", []))

    def test_file_id_outside_audio_folder_rejected(self):
        store = FakeStore()
        store.meta = {"a": dict(self.F1, mimeType="audio/mp4", parents=["OTHER"])}
        with self.assertRaises(MomError):
            select_audio(store, "AUD", "a")


class Normalisation(unittest.TestCase):
    def test_sloppy_small_model_output_is_repaired(self):
        raw = {"summary": "S", "decisions": ["Postpone release"],
               "action_items": [{"action": "Send checklist", "owner": "", "deadline": "unknown"}, "bad", {"owner": "x"}],
               "open_questions": "Who signs?", "next_meeting": None, "review_flags": ["a", {"k": "v"}]}
        out = ai.normalize_chunk(raw)
        self.assertEqual(out["section_summary"], "S")
        self.assertEqual(out["decisions"][0]["decision"], "Postpone release")
        a = out["action_items"]
        self.assertEqual(a[0]["owner"], ai.DEFAULT_OWNER)
        self.assertEqual(a[0]["deadline"], ai.DEFAULT_DEADLINE)
        self.assertEqual(a[1]["action"], "bad")
        self.assertEqual(len(a), 2)  # item without main text dropped
        self.assertEqual(out["open_questions"], ["Who signs?"])
        self.assertEqual(out["next_meeting"], [])

    def test_dedupe_keeps_item_with_evidence(self):
        a = {"decision": "Postpone release", "timestamp": "", "evidence": "", "review_flag": ""}
        b = dict(a, evidence="we decided to postpone")
        merged = ai.merge_sections([ai.normalize_chunk({"decisions": [a]}), ai.normalize_chunk({"decisions": [b]})])
        self.assertEqual(len(merged["decisions"]), 1)
        self.assertEqual(merged["decisions"][0]["evidence"], "we decided to postpone")


def fake_llm():
    calls = {"json": [], "text": []}

    def json_fn(prompt, schema=None):
        calls["json"].append(prompt)
        n = len(calls["json"])
        return {
            "section_summary": f"Narrative of section {n}.",
            "discussion_points": ["Vendor contract and release schedule"],
            "decisions": [{"decision": "Postpone the release until the security audit is complete",
                           "timestamp": "00:01:00",
                           "evidence": "We decided to postpone the release until the security audit is complete"}],
            "action_items": [{"action": "Send the audit checklist", "owner": "Priya", "deadline": "Friday",
                              "timestamp": "00:01:40",
                              "evidence": "Priya will send the audit checklist to the team by Friday"}],
            "commitments": [], "open_questions": [], "next_meeting": [], "review_flags": []}

    def text_fn(prompt):
        calls["text"].append(prompt)
        return "Combined narrative." if "Chronological section summaries" in prompt else "Purpose: review. Outcomes: postponed."
    return json_fn, text_fn, calls


class Understanding(unittest.TestCase):
    def test_both_summaries_produced_and_staged(self):
        j, t, calls = fake_llm()
        out = ai.run_understanding({"title": "T"}, TRANSCRIPT, [], j, t, max_chars=200, model="m")
        self.assertGreater(len(calls["json"]), 1)                    # chunked, not one giant prompt
        self.assertEqual(out["complete_conversation_summary"], "Combined narrative.")
        self.assertTrue(out["executive_summary"].startswith("Purpose"))
        self.assertNotEqual(out["executive_summary"], out["complete_conversation_summary"])
        self.assertEqual(len(out["decisions"]), 1)                   # duplicates across chunks merged
        for key in ai.OUTPUT_KEYS:
            self.assertIn(key, out)

    def test_translation_reaches_ai_prompt(self):
        j, t, calls = fake_llm()
        orig = [seg(0, 10, "నమస్కారం అందరికీ")]
        ai.run_understanding({}, orig, [seg(0, 10, "Hello everyone")], j, t)
        self.assertIn("ENGLISH TRANSLATION", calls["json"][0])
        self.assertIn("Hello everyone", calls["json"][0])


class Validation(unittest.TestCase):
    def base(self, **over):
        ai_obj = {"executive_summary": "e", "complete_conversation_summary": "c", "discussion_points": [],
                  "decisions": [], "action_items": [], "commitments": [], "open_questions": [],
                  "next_meeting": [], "review_flags": []}
        ai_obj.update(over)
        return ai_obj

    def item(self, key, text, **kw):
        d = {key: text, "timestamp": "", "evidence": "", "review_flag": ""}
        if key in ("action", "commitment"):
            d.update(owner=ai.DEFAULT_OWNER, deadline=ai.DEFAULT_DEADLINE)
        d.update(kw)
        return d

    def test_supported_items_pass_clean(self):
        obj = self.base(
            decisions=[self.item("decision", "Postpone release", timestamp="00:01:00",
                                 evidence="We decided to postpone the release until the security audit is complete")],
            action_items=[self.item("action", "Send checklist", owner="Priya", deadline="Friday", timestamp="00:01:40",
                                    evidence="Priya will send the audit checklist to the team by Friday")])
        out, rep = validate(obj, TRANSCRIPT, [])
        self.assertEqual(out["decisions"][0]["review_flag"], "")
        self.assertEqual(out["action_items"][0]["owner"], "Priya")
        self.assertEqual(out["action_items"][0]["deadline"], "Friday")
        self.assertEqual(rep["removed_no_evidence"], [])

    def test_decision_without_evidence_removed_and_reported(self):
        out, rep = validate(self.base(decisions=[self.item("decision", "Buy a new server")]), TRANSCRIPT, [])
        self.assertEqual(out["decisions"], [])
        self.assertTrue(any("Buy a new server" in f for f in out["review_flags"]))

    def test_fabricated_evidence_flagged_not_trusted(self):
        obj = self.base(decisions=[self.item("decision", "Hire ten engineers", timestamp="00:01:00",
                                             evidence="The board approved hiring ten engineers immediately")])
        out, _ = validate(obj, TRANSCRIPT, [])
        self.assertIn("could not be verified", out["decisions"][0]["review_flag"])

    def test_invented_owner_and_deadline_reset(self):
        obj = self.base(action_items=[self.item(
            "action", "Send checklist", owner="Suresh", deadline="31 December", timestamp="00:01:40",
            evidence="Priya will send the audit checklist to the team by Friday")])
        out, rep = validate(obj, TRANSCRIPT, [])
        self.assertEqual(out["action_items"][0]["owner"], ai.DEFAULT_OWNER)
        self.assertEqual(out["action_items"][0]["deadline"], ai.DEFAULT_DEADLINE)
        self.assertEqual(len(rep["owners_reset"]), 1)
        self.assertEqual(len(rep["deadlines_reset"]), 1)

    def test_next_meeting_kept_only_when_stated(self):
        stated, _ = validate(self.base(next_meeting=["Meet again next Tuesday to confirm audit status"]), TRANSCRIPT, [])
        self.assertEqual(len(stated["next_meeting"]), 1)
        no_meeting = [seg(0, 5, "We talked about the budget only.")]
        dropped, rep = validate(self.base(next_meeting=["Next meeting on Monday"]), no_meeting, [])
        self.assertEqual(dropped["next_meeting"], [])
        self.assertEqual(len(rep["next_meeting_dropped"]), 1)

    def test_timestamp_parsing(self):
        self.assertEqual(parse_ts_seconds("00:01:12"), 72)
        self.assertEqual(parse_ts_seconds("[00:01:12 - 00:01:25]"), 72)
        self.assertEqual(parse_ts_seconds("1:12"), 72)
        self.assertEqual(parse_ts_seconds("72.5"), 72.5)
        self.assertIsNone(parse_ts_seconds("later"))


class Docx(unittest.TestCase):
    def test_all_sections_present(self):
        j, t, _ = fake_llm()
        out = ai.run_understanding({}, TRANSCRIPT, [], j, t, max_chars=200)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "m.docx"
            build_mom_doc({"title": "Weekly Review", "date": "2026-10-02",
                           "participants": [{"name": "Ravi", "designation": "Lead"}]}, out).save(p)
            headings = [x.text for x in Document(p).paragraphs if x.style.name.startswith("Heading")]
        for h in ("Executive Summary", "Complete Conversation Summary", "Key Discussion Points", "Decisions",
                  "Action Items", "Commitments", "Open Questions / Pending Follow-up", "Next Meeting", "Review Flags"):
            self.assertIn(h, headings)


class Status(unittest.TestCase):
    def test_status_file_contract_and_failure_isolation(self):
        class Broken:
            def upsert_text(self, *a, **k):
                raise MomError("MOM-013", "boom")
        with tempfile.TemporaryDirectory() as d:
            r = StatusReporter(Broken(), "F", "M1", Path(d) / "s.json", "ai")
            r.update("ANALYZING", "working", 62)       # must not raise even though upload fails
            r.fail("MOM-008", 'Ollama down "private_key": "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----"')
            data = json.loads((Path(d) / "s.json").read_text())
        for k in ("meeting_id", "status", "progress_percent", "current_stage", "message", "started_at",
                  "updated_at", "completed_at", "error_code", "error_message"):
            self.assertIn(k, data)
        self.assertEqual((data["status"], data["error_code"]), ("FAILED", "MOM-008"))
        self.assertNotIn("BEGIN PRIVATE", data["error_message"])

    def test_sanitize_truncates(self):
        self.assertLessEqual(len(sanitize("x" * 5000)), 500)


class EndToEnd(unittest.TestCase):
    """Runs every stage with whisper/ffmpeg/Ollama faked and Drive in memory."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.store = FakeStore()
        self.store.meta["AUDIO1"] = {"id": "AUDIO1", "name": "meeting.m4a", "mimeType": "audio/mp4",
                                     "parents": ["AUD"], "createdTime": "2026-10-01T10:00:00Z"}
        self.store.upsert_text("MEET", "meeting_metadata.json", json.dumps({"title": "Weekly Review", "date": "2026-10-02"}))
        os.environ.update(MEETING_ID="M1", AUDIO_FOLDER_ID="AUD", MEETING_FOLDER_ID="MEET", AUDIO_FILE_ID="AUDIO1")
        whisper_data = {"transcription": [{"offsets": {"from": int(s["start"] * 1000), "to": int(s["end"] * 1000)},
                                           "text": s["text"]} for s in TRANSCRIPT]}
        self.orig = pm.whisper_json, pm.run_cmd, pm.DriveStore.from_env, ai.make_ollama_fns
        pm.whisper_json = lambda *a, **k: whisper_data
        pm.run_cmd = lambda cmd, code: Path(cmd[-1]).write_bytes(b"wav")
        pm.DriveStore.from_env = classmethod(lambda cls: self.store)
        ai.make_ollama_fns = lambda model: fake_llm()[:2]

    def tearDown(self):
        pm.whisper_json, pm.run_cmd, pm.DriveStore.from_env, ai.make_ollama_fns = self.orig
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_main(self, stage):
        sys.argv = ["process_meeting.py", "--stage", stage]
        try:
            pm.main()
        except SystemExit as e:
            return e.code
        return 0

    def status(self):
        return json.loads(self.store.text("MEET", "PROCESSING_STATUS.json"))

    def test_full_pipeline_completes_with_all_outputs(self):
        for stage in ("init", "whisper", "translation", "ai", "mom"):
            self.assertEqual(self.run_main(stage), 0, stage)
        st = self.status()
        self.assertEqual((st["status"], st["progress_percent"]), ("COMPLETED", 100))
        self.assertIsNotNone(st["completed_at"])
        expected = {
            "MEET/TRANSCRIPT": ["Original Transcript.txt", "Transcript.json"],
            "MEET/TRANSLATION": ["English Translation.txt", "Translation.json"],
            "MEET/AI": ["AI Evidence.json", "AI Understanding.json", "Complete Conversation Summary.txt", "Executive Summary.txt"],
            "MEET/MOM": ["Weekly Review - AI_MOM.docx", "PROCESSING_COMPLETE.json"],
        }
        for folder, names in expected.items():
            for n in names:
                self.assertIn((folder, n), self.store.files, f"{folder}/{n} missing")
        evidence = json.loads(self.store.text("MEET/AI", "AI Evidence.json"))
        self.assertTrue(evidence["validated"])
        self.assertTrue(evidence["summary"])                       # mobile app compatibility
        self.assertNotEqual(evidence["executive_summary"], evidence["complete_conversation_summary"])
        self.assertIn("[00:01:00", self.store.text("MEET/TRANSCRIPT", "Original Transcript.txt"))
        self.assertFalse(Path(".meeting_work/source_audio").exists())   # audio removed after translation
        self.assertFalse(Path(".meeting_work/meeting.wav").exists())

    def test_plural_folder_names_are_reused_not_duplicated(self):
        self.store.meta["T"] = {"id": "T", "name": "TRANSCRIPTS", "mimeType": FOLDER, "parents": ["MEET"]}
        self.store.meta["L"] = {"id": "L", "name": "TRANSLATIONS", "mimeType": FOLDER, "parents": ["MEET"]}
        folders = pm.resolve_folders(self.store, "MEET")
        self.assertEqual((folders["TRANSCRIPT"], folders["TRANSLATION"]), ("T", "L"))
        self.assertEqual(folders["AI"], "MEET/AI")                    # missing ones are created

    def test_status_is_per_stage_not_completed_after_first_stage(self):
        """Regression: each workflow step is a separate process; only the last may report COMPLETED."""
        self.run_main("init")
        self.run_main("whisper")
        st = self.status()
        self.assertNotEqual(st["status"], "COMPLETED")
        self.assertLess(st["progress_percent"], 100)
        self.run_main("translation")
        self.assertNotEqual(self.status()["status"], "COMPLETED")
        for stage in ("ai", "mom"):
            self.run_main(stage)
        self.assertEqual(self.status()["stage"], "COMPLETED")         # web app reads `stage`

    def test_rerun_overwrites_instead_of_duplicating(self):
        for _ in range(2):
            for stage in ("init", "whisper"):
                self.run_main(stage)
        self.assertEqual(sum(1 for k in self.store.files if k[1] == "Transcript.json"), 1)

    def test_failure_writes_status_with_error_code(self):
        os.environ["AUDIO_FILE_ID"] = ""
        self.store.meta.clear()                                      # no audio anywhere
        self.assertEqual(self.run_main("whisper"), 1)
        st = self.status()
        self.assertEqual((st["status"], st["error_code"]), ("FAILED", "MOM-001"))

    def test_fail_stage_marks_failed_but_never_overwrites_completed(self):
        os.environ.update(FAILED_STEP="Prepare Whisper runtime", FAILED_ERROR_CODE="MOM-005")
        self.run_main("fail")
        self.assertEqual((self.status()["status"], self.status()["error_code"]), ("FAILED", "MOM-005"))
        for stage in ("init", "whisper", "translation", "ai", "mom"):
            self.run_main(stage)
        self.run_main("fail")
        self.assertEqual(self.status()["status"], "COMPLETED")


if __name__ == "__main__":
    unittest.main()
