"""The opener cell (opener/cell.py): every report is assumed hostile; what leaves is a rebuilt,
whitelisted copy. Each case: the exit code, and nothing ever written outside `outdir`."""
import base64
import gzip
import io
import json
import re
import zlib
from pathlib import Path

import pytest

from conftest import gz, jpeg_bytes, valid_doc
from opener import cell, dests

OK, QUARANTINE = 0, 2


def run(tmp_path, payload, name="in.gz"):
    """Run the cell in-process on `payload` (a doc, or raw bytes written as-is). Returns (code, outdir)."""
    p = tmp_path / name
    p.write_bytes(payload if isinstance(payload, (bytes, bytearray)) else gz(payload))
    out = tmp_path / "out"
    before = {q for q in tmp_path.rglob("*")}
    code = cell.run(p, out)
    after = {q for q in tmp_path.rglob("*")}
    new = {q for q in after - before if not str(q).startswith(str(out))}
    assert not new, f"wrote outside outdir: {new}"
    return code, out


def files(out):
    return sorted(str(q.relative_to(out)) for q in out.rglob("*") if q.is_file())


def test_valid_report_yields_exactly_the_expected_files(tmp_path):
    code, out = run(tmp_path, valid_doc())
    assert code == OK
    assert files(out) == ["index.html", "logs/backend.txt", "logs/main.txt", "logs/renderer.txt", "logs/updater.txt",
                          "report.json", "screens/00-current.jpg", "screens/01-board.jpg"]
    rep = json.loads((out / "report.json").read_text())
    assert rep["manifest"]["shortId"] == "7F3K2Q" and rep["manifest"]["v"] == 1
    assert rep["state"]["settings"] == {"league": "Forbidden Rites", "reference": "exalted"}
    assert rep["screens"] == {"current": "screens/00-current.jpg", "board": "screens/01-board.jpg"}
    assert (out / "logs" / "main.txt").read_text() == "10:00:00 [ui] serving\n"


def test_three_byte_input_and_garbage_are_refused(tmp_path):
    assert run(tmp_path, b"abc")[0] == QUARANTINE
    assert run(tmp_path, b"\x1f\x8b" + b"\x00" * 40)[0] == QUARANTINE
    assert run(tmp_path, gz(b"not json"))[0] == QUARANTINE
    assert run(tmp_path, gz(b"[1,2,3]"))[0] == QUARANTINE


def test_zip_bomb_stops_at_the_ceiling(tmp_path):
    bomb = gzip.compress(b"\x00" * (50 * 1024 * 1024))
    assert len(bomb) < 100_000
    with pytest.raises(cell.Refused, match="too large"):
        cell.decompress_capped(bomb, cell.MAX_PLAIN)
    assert run(tmp_path, bomb)[0] == QUARANTINE


def test_duplicate_keys_depth_and_key_count_are_refused(tmp_path):
    dup = b'{"manifest": {"v": 1}, "manifest": {"v": 2}}'
    assert run(tmp_path, gz(dup))[0] == QUARANTINE
    deep = b"[" * 5000 + b"]" * 5000
    assert run(tmp_path, gz(b'{"manifest":' + deep + b"}"))[0] == QUARANTINE
    many = ("{" + ",".join(f'"k{i}": {i}' for i in range(10_001)) + "}").encode()
    assert run(tmp_path, gz(b'{"manifest": {"v": 1}, "state": ' + many + b"}"))[0] == QUARANTINE


def test_unknown_keys_never_reach_the_output(tmp_path):
    doc = valid_doc()
    doc["__proto__"] = {"polluted": True}
    doc["extra_top"] = "x"
    doc["manifest"]["evil"] = "<script>"
    doc["state"]["session"] = {"cookie": "POESESSID=abc"}
    doc["logs"]["shell"] = "rm -rf /"
    code, out = run(tmp_path, doc)
    assert code == OK
    text = (out / "report.json").read_text()
    for needle in ("polluted", "extra_top", "evil", "POESESSID", "rm -rf", "shell"):
        assert needle not in text, needle
    assert "shell" not in files(out) and not (out / "logs" / "shell.txt").exists()


def test_missing_required_field_or_uncoercible_type_is_quarantined(tmp_path):
    d = valid_doc(); del d["manifest"]["shortId"]
    assert run(tmp_path, d)[0] == QUARANTINE
    d = valid_doc(); d["manifest"]["v"] = "one"
    assert run(tmp_path, d)[0] == QUARANTINE
    d = valid_doc(); d["manifest"]["shortId"] = "../../x"
    assert run(tmp_path, d)[0] == QUARANTINE
    d = valid_doc(); d["logs"]["main"] = "not a list"
    assert run(tmp_path, d)[0] == QUARANTINE


def test_screens_with_hostile_names_are_dropped_and_files_land_only_at_schema_paths(tmp_path):
    d = valid_doc()
    d["screens"]["../../.ssh/authorized_keys"] = d["screens"]["board"]
    d["screens"]["/etc/passwd"] = d["screens"]["board"]
    d["screens"]["not-a-dest"] = d["screens"]["board"]
    code, out = run(tmp_path, d)
    assert code == OK
    assert [f for f in files(out) if f.startswith("screens/")] == ["screens/00-current.jpg", "screens/01-board.jpg"]
    assert not (tmp_path / ".ssh").exists()


def test_screen_bytes_that_are_not_a_jpeg_are_dropped_not_fatal(tmp_path):
    d = valid_doc()
    d["screens"]["board"] = base64.b64encode(b"%PDF-1.4 " + b"x" * 100).decode()
    d["screens"]["settings"] = base64.b64encode(b"\x7fELF" + b"\x00" * 100).decode()
    d["screens"]["strategy-hold"] = "not base64 at all!!"
    code, out = run(tmp_path, d)
    assert code == OK
    assert [f for f in files(out) if f.startswith("screens/")] == ["screens/00-current.jpg"]
    rep = json.loads((out / "report.json").read_text())
    assert rep["screens"] == {"current": "screens/00-current.jpg"}


def test_decompression_bomb_jpeg_is_dropped(tmp_path):
    from PIL import Image
    # A 100 MP JPEG is only a few hundred KB — MAX_IMAGE_PIXELS must stop it before decode.
    Image.MAX_IMAGE_PIXELS = None
    buf = io.BytesIO(); Image.new("L", (10_000, 10_000), 0).save(buf, "JPEG", quality=10)
    Image.MAX_IMAGE_PIXELS = cell.MAX_PIXELS
    assert len(buf.getvalue()) < cell.MAX_SCREEN_BYTES
    d = valid_doc(); d["screens"]["board"] = base64.b64encode(buf.getvalue()).decode()
    code, out = run(tmp_path, d)
    assert code == OK
    assert "screens/01-board.jpg" not in files(out)


def test_a_valid_screen_comes_out_re_encoded(tmp_path):
    src = jpeg_bytes(120, 90, (10, 200, 10))
    d = valid_doc(); d["screens"]["board"] = base64.b64encode(src).decode()
    code, out = run(tmp_path, d)
    got = (out / "screens" / "01-board.jpg").read_bytes()
    assert got != src and got[:3] == b"\xff\xd8\xff"
    from PIL import Image
    im = Image.open(io.BytesIO(got)); im.load()
    assert im.size == (120, 90) and im.mode == "RGB"


def test_index_html_escapes_everything_and_forbids_scripts(tmp_path):
    d = valid_doc()
    d["logs"]["main"] = ["</script><script>alert(1)</script>", "<img src=x onerror=alert(2)>"]
    d["state"]["status"]["league"] = "<b>bold</b>"
    code, out = run(tmp_path, d)
    html = (out / "index.html").read_text()
    assert "<script" not in html and "<img src=x" not in html and "<b>bold" not in html
    assert "&lt;script&gt;" in html
    assert 'Content-Security-Policy" content="default-src \'none\'; img-src \'self\'' in html
    assert "<a " not in html
    for f in ("screens/00-current.jpg", "screens/01-board.jpg"):
        assert f in html


def test_logs_are_capped_per_line_and_per_file(tmp_path):
    d = valid_doc()
    d["logs"]["main"] = ["x" * 5000] * 1000
    d["logs"]["backend"] = "y" * 500_000
    code, out = run(tmp_path, d)
    main = (out / "logs" / "main.txt").read_text().splitlines()
    assert len(main) == cell.MAX_LOG_LINES and all(len(l) <= cell.MAX_LOG_LINE for l in main)
    assert len((out / "logs" / "backend.txt").read_text()) <= cell.MAX_LOG_LINES * (cell.MAX_LOG_LINE + 1)


def test_state_is_rebuilt_bounded(tmp_path):
    d = valid_doc()
    d["state"]["diag"] = {"s": "z" * 10_000, "nested": {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": 1}}}}}}}}}}
    code, out = run(tmp_path, d)
    rep = json.loads((out / "report.json").read_text())
    assert len(rep["state"]["diag"]["s"]) == cell.MAX_STR
    assert "i" not in json.dumps(rep["state"]["diag"])   # beyond the depth ceiling is cut, not copied


def test_cell_imports_only_the_allowed_modules():
    src = (Path(cell.__file__)).read_text()
    imports = set(re.findall(r"^\s*(?:from|import)\s+([\w.]+)", src, re.M))
    allowed = {"zlib", "json", "html", "pathlib", "PIL", "PIL.Image", "sys", "re", "base64", "io", ".dests", "__future__"}
    assert imports <= allowed, imports - allowed
    for bad in ("subprocess", "pickle", "yaml", "eval(", "exec(", "socket", "os.system", "importlib"):
        assert bad not in src, bad


def test_dests_pinned_to_the_frontend_list():
    js = (Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib" / "dests.js").read_text()
    ids = re.findall(r"\{ id: '([a-z-]+)'", js)
    assert list(dests.SCREENS) == ["current", *ids]
