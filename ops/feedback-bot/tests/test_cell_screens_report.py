"""What the opener drops, it says (reading report XWZGZ0, 2026-10-03: the Board and Hold screens never
reached the inbox, the manifest said "not partial", and the sealed original is gone once opened, so
where they were lost could not be told). report.json now carries `screensDropped` {name: reason} for
every screen the report held that did not come out, and the app's own `screensMissing` {name: reason}
(bounded, names slug-shaped); hostile names are counted, never echoed. The logs keep 2000 lines (the
backend's 64 KB tail was being cut to 400, about 5 minutes of polling, on report FY0M4R)."""
import base64
import json

from conftest import valid_doc
from test_cell import OK, run


def report_json(out):
    return json.loads((out / "report.json").read_text())


def test_every_dropped_screen_is_named_with_its_reason(tmp_path):
    d = valid_doc()
    d["screens"]["economy-hold"] = base64.b64encode(b"%PDF-1.4 " + b"x" * 100).decode()
    d["screens"]["settings"] = "not base64 at all!!"
    d["screens"]["future-screen"] = d["screens"]["board"]          # a newer app's screen this opener doesn't know
    d["screens"]["../../etc/passwd"] = d["screens"]["board"]
    code, out = run(tmp_path, d)
    assert code == OK
    assert report_json(out)["screensDropped"] == {
        "economy-hold": "not a readable JPEG", "settings": "not a readable JPEG",
        "future-screen": "not a screen this opener knows", "(invalid names)": "1"}


def test_nothing_dropped_is_an_empty_map(tmp_path):
    code, out = run(tmp_path, valid_doc())
    assert report_json(out)["screensDropped"] == {}


def test_the_apps_missing_screens_are_carried_bounded(tmp_path):
    d = valid_doc()
    d["manifest"]["screensMissing"] = {"board": "timeout", "economy-hold": "error: boom", "<script>": "x", "settings": 5}
    code, out = run(tmp_path, d)
    assert report_json(out)["manifest"]["screensMissing"] == {"board": "timeout", "economy-hold": "error: boom"}
    d["manifest"]["screensMissing"] = {"s-" + "abcdefghij"[i // 10] + "abcdefghij"[i % 10]: "timeout" for i in range(100)}
    code, out = run(tmp_path, d)
    assert len(report_json(out)["manifest"]["screensMissing"]) <= 30


def test_an_older_app_without_the_field_reads_as_nothing_missing(tmp_path):
    code, out = run(tmp_path, valid_doc())
    assert report_json(out)["manifest"]["screensMissing"] == {}


def test_logs_keep_2000_lines(tmp_path):
    d = valid_doc()
    d["logs"]["backend"] = "".join(f"line {i}\n" for i in range(1500))
    code, out = run(tmp_path, d)
    assert len((out / "logs" / "backend.txt").read_text().splitlines()) == 1500
