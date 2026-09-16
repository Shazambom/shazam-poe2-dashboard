"""Pure guards for the Trading workspace document (PUT /api/trading/workspace).

The backend VALIDATES and never truncates: a document inside the limits is stored byte-for-byte
(fields are additive and unknown ones pass through), and a rejection names the exact limit so a
client that hits one is a bug to fix, not data to silently lose. No per-field schema.
"""
import json
from dataclasses import dataclass

MAX_WORKSPACE_BYTES = 2_000_000
MAX_WORKSPACE_NODES = 5000
MAX_WORKSPACE_DEPTH = 32
KINDS = ("folder", "search")


@dataclass(frozen=True)
class WorkspaceError:
    status: int
    detail: str


def validate_workspace(ws) -> "WorkspaceError | None":
    if not isinstance(ws, dict) or ws.get("version") != 2:
        return WorkspaceError(400, "workspace.version must be 2")
    tree = ws.get("tree")
    if not isinstance(tree, list):
        return WorkspaceError(400, "workspace.tree must be a list")
    try:
        size = len(json.dumps(ws, separators=(",", ":")))
    except (TypeError, ValueError):
        return WorkspaceError(400, "workspace document is not JSON-serialisable (cyclic?)")
    if size > MAX_WORKSPACE_BYTES:
        return WorkspaceError(413, f"workspace is {size} bytes; MAX_WORKSPACE_BYTES is {MAX_WORKSPACE_BYTES}")

    # Iterative walk (explicit stack) so a cyclic document terminates via the node/depth caps
    # rather than recursing forever. json.dumps above already rejects true cycles; this also
    # bounds pathological-but-acyclic shapes.
    seen: set = set()
    count = 0
    stack = [(n, 1) for n in reversed(tree)]
    while stack:
        n, depth = stack.pop()
        count += 1
        if count > MAX_WORKSPACE_NODES:
            return WorkspaceError(400, f"workspace has more than MAX_WORKSPACE_NODES ({MAX_WORKSPACE_NODES}) nodes")
        if depth > MAX_WORKSPACE_DEPTH:
            return WorkspaceError(400, f"workspace nests deeper than MAX_WORKSPACE_DEPTH ({MAX_WORKSPACE_DEPTH})")
        if not isinstance(n, dict):
            return WorkspaceError(400, "every workspace node must be an object")
        nid = n.get("id")
        if not isinstance(nid, str) or not nid:
            return WorkspaceError(400, "every workspace node needs a string id")
        if nid in seen:
            return WorkspaceError(400, f"duplicate node id {nid!r}")
        seen.add(nid)
        kind = n.get("kind")
        if kind not in KINDS:
            return WorkspaceError(400, f"node {nid!r} has unknown kind {kind!r}")
        if kind == "folder":
            kids = n.get("children", [])
            if not isinstance(kids, list):
                return WorkspaceError(400, f"folder {nid!r}.children must be a list")
            stack.extend((k, depth + 1) for k in reversed(kids))
    return None
