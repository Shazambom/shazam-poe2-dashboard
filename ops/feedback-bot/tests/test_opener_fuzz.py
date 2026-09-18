"""Fuzz the cell: random bytes, random JSON trees and byte-level mutations of a valid report. The
cell always returns OK or QUARANTINE (never raises), and never writes outside outdir. ~200 examples
in the gate; `--hypothesis-profile=long` for more."""
import json
import random

from hypothesis import given
from hypothesis import strategies as st

from conftest import gz, valid_doc
from opener import cell


json_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats(allow_nan=False) | st.text(max_size=40),
    lambda inner: st.lists(inner, max_size=6) | st.dictionaries(st.text(max_size=12), inner, max_size=6),
    max_leaves=40,
)


def _run(tmp_path, payload):
    inp = tmp_path / "in.gz"
    inp.write_bytes(payload)
    out = tmp_path / "out"
    code = cell.run(inp, out)
    assert code in (cell.OK, cell.QUARANTINE)
    stray = [q for q in tmp_path.rglob("*") if q != inp and not str(q).startswith(str(out))]
    assert not stray, stray
    return code


@given(st.binary(max_size=4000))
def test_random_bytes(tmp_path_factory, data):
    _run(tmp_path_factory.mktemp("fz"), data)


@given(json_values)
def test_random_json_trees(tmp_path_factory, tree):
    _run(tmp_path_factory.mktemp("fz"), gz(json.dumps(tree).encode()))


@given(st.dictionaries(st.sampled_from(["manifest", "state", "logs", "screens", "x"]), json_values, max_size=5))
def test_random_top_level_shapes(tmp_path_factory, doc):
    _run(tmp_path_factory.mktemp("fz"), gz(doc))


@given(st.integers(min_value=0, max_value=2**32 - 1), st.integers(min_value=1, max_value=40))
def test_byte_mutations_of_a_valid_report(tmp_path_factory, seed, n):
    raw = bytearray(json.dumps(valid_doc()).encode())
    rng = random.Random(seed)
    for _ in range(n):
        raw[rng.randrange(len(raw))] = rng.randrange(256)
    _run(tmp_path_factory.mktemp("fz"), gz(bytes(raw)))
