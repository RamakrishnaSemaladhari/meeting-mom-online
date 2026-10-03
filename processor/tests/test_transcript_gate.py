"""Audio health + transcript quality gate + Whisper fallback (offline).

    python -m unittest discover -s processor/tests -v
"""
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import process_meeting as pm  # noqa: E402
from pipeline.errors import ERROR_NAMES, MomError  # noqa: E402
from pipeline.speech_quality import (  # noqa: E402
    assess_audio, assess_transcript, audio_report_from_ffmpeg)
from test_pipeline import TRANSCRIPT, FakeStore, fake_llm  # noqa: E402

TELUGU_WORDS = ("నమస్కారం ఈ రోజు సమావేశంలో రెన్యువల్ బ్యాక్‌లాగ్ గురించి మాట్లాడదాం పాలసీ కస్టమర్ రిపోర్ట్ "
                "శుక్రవారం లోపు పంపిస్తాను అవును సరే తరువాత చూద్దాం ఖర్చు బడ్జెట్ ఆమోదం కావాలి వెంటనే "
                "టీమ్ వాహనం బీమా క్లెయిమ్ పెండింగ్ సమస్య పరిష్కారం ఫాలో అప్ అవసరం").split()


def healthy_segments(n=60, seed=7):
    """Natural-looking speech: a Zipf-like vocabulary of ~400 words (common words repeat, most are rare)."""
    rnd = random.Random(seed)
    vocab = [f"{TELUGU_WORDS[i % len(TELUGU_WORDS)]}{i // len(TELUGU_WORDS) or ''}" for i in range(400)]
    weights = [1.0 / (rank + 1) for rank in range(len(vocab))]
    return [{"start": i * 10.0, "end": i * 10.0 + 9,
             "text": " ".join(rnd.choices(vocab, weights, k=9))} for i in range(n)]


def looping_segments(n=60):
    return [{"start": i * 10.0, "end": i * 10.0 + 9, "text": "అది మీరు చెప్పండి అది మీరు చెప్పండి"} for i in range(n)]


FFMPEG_OK = """  Duration: 00:10:02.50, start: 0.000000, bitrate: 256 kb/s
[silencedetect @ 0x1] silence_duration: 4.5
[silencedetect @ 0x1] silence_duration: 10.5
[Parsed_volumedetect_0 @ 0x2] mean_volume: -27.3 dB
[Parsed_volumedetect_0 @ 0x2] max_volume: -3.1 dB
"""


class AudioHealth(unittest.TestCase):
    def test_report_parsing(self):
        r = audio_report_from_ffmpeg(FFMPEG_OK)
        self.assertEqual((r["duration_seconds"], r["mean_volume_db"], r["max_volume_db"]), (602.5, -27.3, -3.1))
        self.assertEqual(r["silence_seconds"], 15.0)
        self.assertAlmostEqual(r["silence_ratio"], 0.025, places=3)

    def test_normal_audio_passes(self):
        self.assertEqual(assess_audio(audio_report_from_ffmpeg(FFMPEG_OK)), ([], []))

    def test_silent_and_tiny_audio_fail(self):
        problems, _ = assess_audio({"duration_seconds": 600, "max_volume_db": -70.0})
        self.assertTrue(any("silent" in p for p in problems))
        problems, _ = assess_audio({"duration_seconds": 1.0, "max_volume_db": -5.0})
        self.assertTrue(any("seconds long" in p for p in problems))

    def test_quiet_audio_only_warns(self):
        problems, warnings = assess_audio({"duration_seconds": 600, "mean_volume_db": -50.0, "max_volume_db": -20.0})
        self.assertEqual(problems, [])
        self.assertEqual(len(warnings), 1)

    def test_unknown_metrics_never_fail(self):
        self.assertEqual(assess_audio({}), ([], []))


class QualityGate(unittest.TestCase):
    def test_varied_telugu_passes(self):
        verdict = assess_transcript(healthy_segments(), audio_seconds=600)
        self.assertTrue(verdict["passed"], verdict["problems"])

    def test_hour_long_meeting_is_not_a_false_positive(self):
        verdict = assess_transcript(healthy_segments(n=360, seed=3), audio_seconds=3600)   # ~3,200 words
        self.assertTrue(verdict["passed"], verdict["problems"])

    def test_loop_covering_a_third_of_a_long_recording_fails(self):
        segs = healthy_segments(n=120, seed=5)
        for i in range(40, 80):
            segs[i]["text"] = "అది మీరు చెప్పండి అది మీరు చెప్పండి అవును సరే"
        self.assertFalse(assess_transcript(segs, audio_seconds=1200)["passed"])

    def test_normal_english_passes(self):
        self.assertTrue(assess_transcript(TRANSCRIPT, audio_seconds=200)["passed"])

    def test_repetition_loop_fails(self):
        verdict = assess_transcript(looping_segments(), audio_seconds=600)
        self.assertFalse(verdict["passed"])
        self.assertGreaterEqual(len(verdict["problems"]), 2)

    def test_loop_with_slight_variation_still_fails(self):
        segs = [{"start": i * 10.0, "end": i * 10.0 + 9,
                 "text": "అది మీరు చెప్పండి అది మీరు చెప్పండి" + (" అవును" if i % 7 == 0 else "")} for i in range(60)]
        self.assertFalse(assess_transcript(segs, audio_seconds=600)["passed"])

    def test_run_of_duplicates_in_middle_of_good_text_fails(self):
        segs = healthy_segments(30)
        for i in range(10, 17):
            segs[i]["text"] = "ధన్యవాదాలు చూసినందుకు"
        verdict = assess_transcript(segs, audio_seconds=300)
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("consecutive" in p for p in verdict["problems"]))

    def test_transcript_stopping_early_fails(self):
        verdict = assess_transcript(healthy_segments(5), audio_seconds=1200)  # ends at 49s of a 20 min recording
        self.assertFalse(verdict["passed"])
        self.assertTrue(any("ends at" in p for p in verdict["problems"]))

    def test_short_real_utterance_is_not_flagged_as_loop(self):
        segs = [{"start": 0, "end": 4, "text": "Yes, that works for everyone on the team."}]
        self.assertTrue(assess_transcript(segs, audio_seconds=5)["passed"])

    def test_empty_and_garbage(self):
        self.assertFalse(assess_transcript([], audio_seconds=100)["passed"])
        garbage = [{"start": 0, "end": 5, "text": "\ufffd" * 80}]
        self.assertFalse(assess_transcript(garbage)["passed"])

    def test_error_codes_registered(self):
        self.assertEqual(ERROR_NAMES["MOM-019"], "Transcript quality failure")
        self.assertEqual(ERROR_NAMES["MOM-020"], "Audio health failure")


class Orchestration(unittest.TestCase):
    """Drives the real stages with Whisper, ffmpeg, Drive and Ollama replaced by fakes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        for name in ("primary.bin", "fallback.bin"):
            Path(name).write_bytes(b"x")
        self.store = FakeStore()
        self.store.meta["AUDIO1"] = {"id": "AUDIO1", "name": "m.m4a", "mimeType": "audio/mp4",
                                     "parents": ["AUD"], "createdTime": "2026-10-01T10:00:00Z"}
        self.store.upsert_text("MEET", "meeting_metadata.json", json.dumps({"title": "T", "language_hint": "auto"}))
        os.environ.update(MEETING_ID="M1", AUDIO_FOLDER_ID="AUD", MEETING_FOLDER_ID="MEET", AUDIO_FILE_ID="AUDIO1")
        os.environ.pop("WHISPER_LANGUAGE", None)
        self.saved = (pm.whisper_json, pm.run_cmd, pm.DriveStore.from_env, pm.WHISPER_MODEL, pm.FALLBACK_MODEL, pm.audio_health)
        pm.WHISPER_MODEL, pm.FALLBACK_MODEL = Path("primary.bin"), Path("fallback.bin")
        pm.run_cmd = lambda cmd, code: Path(cmd[-1]).write_bytes(b"wav")
        pm.DriveStore.from_env = classmethod(lambda cls: self.store)
        pm.audio_health = lambda wav, status=None: ({"duration_seconds": 600.0}, [])
        self.calls = []

    def tearDown(self):
        (pm.whisper_json, pm.run_cmd, pm.DriveStore.from_env, pm.WHISPER_MODEL, pm.FALLBACK_MODEL, pm.audio_health) = self.saved
        os.chdir(self.cwd)
        self.tmp.cleanup()

    @staticmethod
    def whisper_data(segments, lang="te"):
        return {"result": {"language": lang}, "transcription": [
            {"offsets": {"from": int(s["start"] * 1000), "to": int(s["end"] * 1000)}, "text": s["text"]} for s in segments]}

    def install_whisper(self, by_model):
        def fake(wav, base, translate=False, model=None, language="auto"):
            self.calls.append({"model": Path(model).name if model else "primary.bin", "translate": translate, "language": language})
            return by_model[(Path(model).name if model else "primary.bin", translate)]
        pm.whisper_json = fake

    def run_stage(self, stage):
        sys.argv = ["process_meeting.py", "--stage", stage]
        try:
            pm.main()
        except SystemExit as e:
            return e.code
        return 0

    def status(self):
        return json.loads(self.store.text("MEET", "PROCESSING_STATUS.json"))

    def test_loop_on_primary_recovers_with_fallback_model(self):
        good = self.whisper_data(healthy_segments())
        self.install_whisper({("primary.bin", False): self.whisper_data(looping_segments()), ("fallback.bin", False): good})
        self.assertEqual(self.run_stage("whisper"), 0)
        saved = json.loads(self.store.text("MEET/TRANSCRIPT", "Transcript.json"))
        self.assertEqual(saved["_quality"]["model_used"], "fallback.bin")
        self.assertEqual([a["passed"] for a in saved["_quality"]["attempts"]], [False, True])
        self.assertEqual([c["model"] for c in self.calls], ["primary.bin", "fallback.bin"])
        self.assertNotIn("అది మీరు చెప్పండి అది మీరు చెప్పండి", self.store.text("MEET/TRANSCRIPT", "Original Transcript.txt"))

    def test_loop_on_every_model_fails_with_mom019_and_saves_nothing(self):
        bad = self.whisper_data(looping_segments())
        self.install_whisper({("primary.bin", False): bad, ("fallback.bin", False): bad})
        self.assertEqual(self.run_stage("whisper"), 1)
        st = self.status()
        self.assertEqual((st["status"], st["error_code"]), ("FAILED", "MOM-019"))
        self.assertNotIn(("MEET/TRANSCRIPT", "Original Transcript.txt"), self.store.files)
        self.assertNotIn(("MEET/TRANSCRIPT", "Transcript.json"), self.store.files)

    def test_without_fallback_model_failure_says_so(self):
        pm.FALLBACK_MODEL = Path("missing.bin")
        self.install_whisper({("primary.bin", False): self.whisper_data(looping_segments())})
        self.assertEqual(self.run_stage("whisper"), 1)
        self.assertIn("no stronger fallback model", self.status()["error_message"])

    def test_good_primary_never_touches_fallback(self):
        self.install_whisper({("primary.bin", False): self.whisper_data(healthy_segments())})
        self.assertEqual(self.run_stage("whisper"), 0)
        self.assertEqual([c["model"] for c in self.calls], ["primary.bin"])

    def test_language_hint_from_metadata_and_env(self):
        self.store.upsert_text("MEET", "meeting_metadata.json", json.dumps({"title": "T", "language_hint": "te"}))
        self.install_whisper({("primary.bin", False): self.whisper_data(healthy_segments())})
        self.run_stage("whisper")
        self.assertEqual(self.calls[0]["language"], "te")
        for bad in ("en/te/hi", "telugu-hindi", ""):
            self.assertEqual(pm.language_hint(bad), "auto")
        os.environ["WHISPER_LANGUAGE"] = "hi"
        self.assertEqual(pm.language_hint("te"), "hi")

    def test_english_recording_skips_second_whisper_pass(self):
        pm.audio_health = lambda wav, status=None: ({"duration_seconds": 200.0}, [])
        self.install_whisper({("primary.bin", False): self.whisper_data(TRANSCRIPT, lang="en")})
        self.assertEqual(self.run_stage("whisper"), 0)
        self.assertEqual(self.run_stage("translation"), 0)
        self.assertEqual([c["translate"] for c in self.calls], [False])      # no -tr pass
        self.assertIn(("MEET/TRANSLATION", "Translation.json"), self.store.files)

    def test_translation_uses_primary_model_never_turbo(self):
        self.install_whisper({("primary.bin", False): self.whisper_data(healthy_segments()),
                              ("primary.bin", True): self.whisper_data(TRANSCRIPT, lang="te")})
        self.run_stage("whisper")
        self.assertEqual(self.run_stage("translation"), 0)
        self.assertEqual(self.calls[-1], {"model": "primary.bin", "translate": True, "language": "auto"})

    def test_looping_translation_is_discarded_not_fed_to_ai(self):
        self.install_whisper({("primary.bin", False): self.whisper_data(healthy_segments()),
                              ("primary.bin", True): self.whisper_data(looping_segments())})
        self.run_stage("whisper")
        self.assertEqual(self.run_stage("translation"), 0)                    # pipeline continues on the good transcript
        saved = json.loads(self.store.text("MEET/TRANSLATION", "Translation.json"))
        self.assertFalse(saved["_quality"]["passed"])
        self.assertEqual(saved["transcription"], [])
        self.assertIn("No separate English translation", self.store.text("MEET/TRANSLATION", "English Translation.txt"))
        warnings = json.loads(Path(".meeting_work/audio_warnings.json").read_text())
        self.assertTrue(any("translation was discarded" in w for w in warnings))

    def test_silent_audio_fails_with_mom020_before_whisper(self):
        def silent(wav, status=None):
            raise MomError("MOM-020", "Audio health check failed: silent")
        pm.audio_health = silent
        self.install_whisper({})
        self.assertEqual(self.run_stage("whisper"), 1)
        self.assertEqual(self.status()["error_code"], "MOM-020")
        self.assertEqual(self.calls, [])


class WhisperCommand(unittest.TestCase):
    def test_flags_reach_whisper_cli(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd()
            os.chdir(d)
            try:
                for name in ("whisper-cli", "m.bin", "vad.bin"):
                    Path(name).write_bytes(b"x")
                saved = pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL, pm.run_cmd
                pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL = Path("whisper-cli"), Path("m.bin"), Path("vad.bin")
                seen = {}

                def fake_run(cmd, code):
                    seen["cmd"] = cmd
                    Path(cmd[cmd.index("-of") + 1] + ".json").write_text(json.dumps({"transcription": []}))
                pm.run_cmd = fake_run
                pm.whisper_json(Path("a.wav"), Path("out"), language="te")
                cmd = seen["cmd"]
                for flag in ("-nf", "--vad", "-sns"):
                    self.assertIn(flag, cmd)
                self.assertEqual(cmd[cmd.index("-mc") + 1], "0")
                self.assertEqual(cmd[cmd.index("-l") + 1], "te")
                self.assertIn("-oj", cmd)
                self.assertNotIn("-ojf", cmd)       # token-level JSON (-ojf) is not needed and adds per-token text that can carry partial UTF-8
                self.assertNotIn("-tr", cmd)
                pm.whisper_json(Path("a.wav"), Path("out"), translate=True)
                self.assertIn("-tr", seen["cmd"])
            finally:
                pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL, pm.run_cmd = saved
                os.chdir(cwd)

    def test_missing_vad_model_is_infrastructure_error(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd()
            os.chdir(d)
            saved = pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL
            try:
                for name in ("whisper-cli", "m.bin"):
                    Path(name).write_bytes(b"x")
                pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL = Path("whisper-cli"), Path("m.bin"), Path("none.bin")
                with self.assertRaises(MomError) as cm:
                    pm.whisper_json(Path("a.wav"), Path("out"))
                self.assertEqual(cm.exception.code, "MOM-006")
            finally:
                pm.WHISPER, pm.WHISPER_MODEL, pm.VAD_MODEL = saved
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
