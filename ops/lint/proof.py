#!/usr/bin/env python3
"""Behaviour fingerprints of the tree, to prove a lint fix changed nothing it should not have.

    ops/lint/proof.py snapshot <dir>      # write the fingerprints of the working tree
    ops/lint/proof.py compare <a> <b>     # per proof: identical, or the files that differ

Each proof is a {name: hash} map, so a difference names its files:
  py-ast     every .py's syntax tree (comments and formatting drop out; docstrings are normalised)
  py-ast-na  the same with annotations removed (a types-only change leaves it identical)
  openapi    the backend's generated API schema
  vite       the production frontend bundle, file by file
  desktop    each desktop/ops script minified by esbuild (comments and local names drop out)
  shell      each shell script minified by shfmt
  tests      the test names each suite defines
Run with the repo's .venv-test python (the backend must import).
"""

import ast
import hashlib
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATED = (
    "desktop/src/vendor/ee2-query/vendor/",
    "desktop/src/vendor/ee2-query/data/",
)


def sha(data) -> str:
    return hashlib.sha256(
        data if isinstance(data, bytes) else data.encode()
    ).hexdigest()[:16]


def tracked(*globs: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "--", *globs],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split("\n")
    return sorted(
        p for p in out if p and (ROOT / p).is_file() and not p.startswith(GENERATED)
    )


class _Normalise(ast.NodeTransformer):
    """Docstrings through inspect.cleandoc (a formatter re-indents them); optionally drop annotations."""

    def __init__(self, annotations: bool):
        self.annotations = annotations

    def _doc(self, node):
        body = getattr(node, "body", None)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body[0].value.value = inspect.cleandoc(body[0].value.value)

    def generic_visit(self, node):
        if isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            self._doc(node)
        if not self.annotations:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                node.returns = None
            if isinstance(node, ast.arg):
                node.annotation = None
        return super().generic_visit(node)

    def visit_AnnAssign(self, node):
        if self.annotations:
            return self.generic_visit(node)
        if node.value is None:  # a bare `x: int` declares nothing at runtime
            return ast.Pass()
        return ast.Assign(
            targets=[node.target], value=self.visit(node.value), lineno=0, col_offset=0
        )


def py_ast(annotations: bool) -> dict:
    out = {}
    for p in tracked("*.py"):
        tree = _Normalise(annotations).visit(ast.parse((ROOT / p).read_text()))
        out[p] = sha(ast.dump(tree, include_attributes=False))
    return out


def openapi() -> dict:
    env = {**os.environ, "DATA_DIR": tempfile.mkdtemp(), "MARKET_SEED": ""}
    code = "import json;from app.main import app;print(json.dumps(app.openapi(),sort_keys=True))"
    r = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT / "backend",
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode:
        raise SystemExit(f"openapi: the backend did not import\n{r.stderr[-2000:]}")
    return {"openapi.json": sha(r.stdout.strip().split("\n")[-1])}


def vite() -> dict:
    out = Path(tempfile.mkdtemp())
    r = subprocess.run(
        [
            "npx",
            "vite",
            "build",
            "--outDir",
            str(out),
            "--emptyOutDir",
            "--logLevel",
            "error",
        ],
        cwd=ROOT / "frontend",
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode:
        raise SystemExit(f"vite: build failed\n{r.stderr[-2000:]}")
    return {
        str(f.relative_to(out)): sha(f.read_bytes())
        for f in sorted(out.rglob("*"))
        if f.is_file()
    }


def desktop() -> dict:
    esbuild = ROOT / "desktop/node_modules/.bin/esbuild"
    out = {}
    for p in tracked(
        "desktop/src/*.js",
        "desktop/scripts/*.mjs",
        "ops/*.mjs",
        "frontend/scripts/*.mjs",
    ):
        r = subprocess.run(
            [str(esbuild), "--minify", "--log-level=error", str(ROOT / p)],
            capture_output=True,
            check=False,
        )
        if r.returncode:
            raise SystemExit(
                f"desktop: esbuild failed on {p}\n{r.stderr.decode()[-1000:]}"
            )
        out[p] = sha(r.stdout)
    return out


def shell() -> dict:
    out = {}
    for p in tracked("*.sh"):
        r = subprocess.run(
            ["shfmt", "-mn", str(ROOT / p)], capture_output=True, check=False
        )
        if r.returncode:
            raise SystemExit(f"shell: shfmt failed on {p}\n{r.stderr.decode()[-1000:]}")
        out[p] = sha(r.stdout)
    return out


PY_TEST = re.compile(r"^\s*(?:async\s+)?def (test_\w+)", re.M)
JS_TEST = re.compile(r"""^\s*(?:test|it)(?:\.\w+)?\(\s*(['"`])(.+?)\1""", re.M)


def tests() -> dict:
    out = {}
    for p in tracked("backend/tests/*.py", "ops/feedback-bot/tests/*.py"):
        for name in PY_TEST.findall((ROOT / p).read_text()):
            out[f"{p}::{name}"] = "1"
    for p in tracked(
        "frontend/test/*.mjs",
        "frontend/test/*.jsx",
        "desktop/test/*.mjs",
        "ops/lint/*.test.mjs",
    ):
        for _, name in JS_TEST.findall((ROOT / p).read_text()):
            out[f"{p}::{name}"] = "1"
    return out


PROOFS = {
    "py-ast": lambda: py_ast(True),
    "py-ast-na": lambda: py_ast(False),
    "openapi": openapi,
    "vite": vite,
    "desktop": desktop,
    "shell": shell,
    "tests": tests,
}


def snapshot(dest: Path, only: list[str]) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name in only or PROOFS:
        (dest / f"{name}.json").write_text(
            json.dumps(PROOFS[name](), indent=0, sort_keys=True)
        )
        print(f"  {name}: recorded")


def compare(a: Path, b: Path) -> int:
    differs = 0
    for name in PROOFS:
        fa, fb = a / f"{name}.json", b / f"{name}.json"
        if not fa.exists() or not fb.exists():
            print(f"  {name}: not recorded in both")
            continue
        x, y = json.loads(fa.read_text()), json.loads(fb.read_text())
        changed = sorted(k for k in x.keys() | y.keys() if x.get(k) != y.get(k))
        if not changed:
            print(f"  {name}: identical ({len(x)})")
            continue
        differs += 1
        print(f"  {name}: {len(changed)} differ")
        for k in changed[:40]:
            print(
                f"      {'removed' if k not in y else 'added' if k not in x else 'changed'}  {k}"
            )
        if len(changed) > 40:
            print(f"      … and {len(changed) - 40} more")
    return differs


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "snapshot":
        unknown = [n for n in argv[2:] if n not in PROOFS]
        if unknown:
            raise SystemExit(
                f"unknown proof: {', '.join(unknown)} (known: {', '.join(PROOFS)})"
            )
        snapshot(Path(argv[1]), argv[2:])
        return 0
    if len(argv) == 3 and argv[0] == "compare":
        return 1 if compare(Path(argv[1]), Path(argv[2])) else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
