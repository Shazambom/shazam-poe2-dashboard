#!/bin/bash
# Place / refresh the GitHub token that shazam uses to upload the market seed to the
# `market-seed-latest` GitHub Release (so Windows CI can download it — it can't reach the
# LAN). The token is written to shazam:~/.poe2-gh-token (chmod 600) and is NEVER printed to
# the terminal: it flows straight from its source into ssh -> file. Re-run any time to rotate.
#
# Modes:
#   ./refresh-gh-token.sh              # paste a fine-grained PAT (recommended: scope = this
#                                      #   repo only, Contents: Read and write). Silent read.
#   ./refresh-gh-token.sh --from-gh    # reuse the Mac's existing `gh` login token (zero UI,
#                                      #   but BROAD scope — prefer a scoped PAT).
#
# After writing, it validates the token against the GitHub API from shazam and prints ONLY the
# authenticated login + whether it can write to the repo — not the token.
set -euo pipefail

SSH=sshshazambom
REMOTE_FILE='~/.poe2-gh-token'
GH_REPO="${GH_REPO:-Shazambom/shazam-poe2-dashboard}"

get_token() {
  if [ "${1:-}" = "--from-gh" ]; then
    command -v gh >/dev/null || { echo "gh not found on this machine" >&2; exit 1; }
    gh auth token
  else
    # Read silently from the controlling terminal so the value never lands in scrollback,
    # process args, or this script's stdout.
    printf 'Paste GitHub token (input hidden), then Enter: ' >&2
    IFS= read -rs TOK < /dev/tty
    printf '\n' >&2
    printf '%s' "$TOK"
  fi
}

# Pipe the token directly into a file on shazam. `umask 077` + explicit chmod = 600.
get_token "${1:-}" | $SSH 'umask 077; cat > ~/.poe2-gh-token && chmod 600 ~/.poe2-gh-token && echo "token written to ~/.poe2-gh-token"'

echo "validating from shazam (token not shown)..."
# Validate WITHOUT echoing the token: read it on shazam, call the API, print only the result.
$SSH "GH_REPO='$GH_REPO' bash -s" <<'REMOTE'
set -euo pipefail
TOK=$(cat ~/.poe2-gh-token)
who=$(curl -fsS -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
       https://api.github.com/user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)
perm=$(curl -fsS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" \
       -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GH_REPO")
echo "  authenticated as: ${who:-<unknown>}"
echo "  repo $GH_REPO reachable: HTTP $perm (expect 200)"
echo "  (a real write is exercised by upload-seed-github.sh at release time)"
REMOTE
echo "done. shazam can now upload the seed asset during a release."
