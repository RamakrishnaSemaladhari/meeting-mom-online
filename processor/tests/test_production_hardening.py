from pathlib import Path
import py_compile

ROOT = Path(__file__).resolve().parents[3]


def test_production_python_compiles():
    for path in (ROOT / "scripts").rglob("*.py"):
        py_compile.compile(str(path), doraise=True)


def test_parallel_production_guards_present():
    src = (ROOT / "scripts/pipeline/parallel_batch.py").read_text(encoding="utf-8")
    assert "def transcribe_batch(" in src
    assert "assess_transcript" in src
    assert "FALLBACK_MODEL" in src
    assert 'PROCESSING_MODE", "fresh"' in src
    assert "BATCH_STATUS_{index:03d}.json" in src
    assert "MOM-021" in src
    assert "WORK.mkdir(parents=True, exist_ok=True)" in src


def test_drive_preflight_present():
    src = (ROOT / "scripts/pipeline/drive_store.py").read_text(encoding="utf-8")
    assert "def identity(self)" in src
    assert "def write_probe(" in src
    assert "MOM-013" in src


def test_failure_reporting_preserves_batch_reason():
    src = (ROOT / "scripts/process_meeting.py").read_text(encoding="utf-8")
    assert "def first_failed_batch(" in src
    assert "Batch {batch.get('batch_index')}/{total} failed" in src


def test_web_wait_is_bounded():
    src = (ROOT.parent / "web/app.js").read_text(encoding="utf-8")
    assert "GATEWAY_NO_CONFIRMATION" in src
    assert "GITHUB_RUN_NOT_FOUND" in src
    assert "elapsedMs > 120000" in src
    assert "elapsedMs > 300000" in src
