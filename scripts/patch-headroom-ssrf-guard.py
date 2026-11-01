#!/usr/bin/env python3
"""Stop Headroom from silently rerouting a rejected ``x-headroom-base-url``.

Why this exists
---------------
Headroom validates the client-supplied upstream in
``headroom/proxy/upstream_guard.py::is_safe_upstream_url``: it resolves the host
on a small thread pool with a 3 s budget and *fails closed* on a DNS miss or an
overrun. The handler then reads that verdict exactly like "no header" and falls
back to the configured default OpenAI target. So a legitimate provider
(``https://opencode.ai/zen/go``) the guard could not resolve had its request
sent to ``api.openai.com`` carrying 9Router's provider key, and OpenAI answered
``401 invalid_api_key`` — credentials and prompt content misrouted in silence.

Observed before the patch: 72x ``ignoring unsafe x-headroom-base-url override``
and 23 outbound requests to ``api.openai.com``, in bursts matching the 401
bursts. 9Router is the only client of this proxy and always sends the provider's
own base URL, so the override is authoritative and there is no verdict to guess.

What it changes
---------------
In the default (no ``HEADROOM_ALLOWED_BASE_URLS``) mode, the override is
honoured without resolution, so no DNS-dependent rejection and no reroute — for
every provider 9Router can route to, with no host list to maintain. A *literal*
internal address (loopback / RFC1918 / link-local / cloud-metadata) is still
refused: judging it needs no DNS. An operator who sets
``HEADROOM_ALLOWED_BASE_URLS`` keeps exactly the old semantics — that list wins.

Residual risk, stated plainly: a hostname that resolves to an internal address
is no longer judged, so DNS rebinding is not caught. Keep the listener on
loopback — 9Router starts it on 127.0.0.1.

Idempotent: re-running is a no-op.
"""

from __future__ import annotations

import pathlib
import re
import sys

BEGIN = "# --- trust x-headroom-base-url (patch:begin) ---"
END = "# --- trust x-headroom-base-url (patch:end) ---"

# Where the default-mode resolution begins: the trust branch belongs just above
# it, after the allowlist branch so a configured list keeps winning.
ANCHOR = """    try:
        infos = _RESOLVER_POOL.submit(
"""

BLOCK = f'''{BEGIN}
    # 9Router is the only client here and always sends the provider's own base
    # URL, so the override is authoritative. Below, the resolver's verdict fails
    # closed on a miss or overrun and the handler turns that into a silent
    # reroute to the default OpenAI target. Judge what needs no DNS and route
    # where the caller asked. HEADROOM_ALLOWED_BASE_URLS, checked above, still
    # wins when an operator sets it.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return True  # a hostname: trusted, no DNS judgement
    return not _is_internal_address(host)  # a literal address: still judged
{END}

'''

# First release of this patch inserted the same branch above the allowlist
# branch, without delimiters, which also put it ahead of a configured
# HEADROOM_ALLOWED_BASE_URLS. Drop it so re-running lands the corrected one.
_LEGACY_RE = re.compile(
    r"[ \t]*# --- trust x-headroom-base-url \(patched\) ---\n"
    r"(?:.*\n)*?"
    r".*still judged[^\n]*\n\n?"
)


def target_path() -> pathlib.Path:
    try:
        import headroom.proxy.upstream_guard as guard
    except ImportError as exc:  # pragma: no cover - operator error
        sys.exit(f"error: cannot import headroom: {exc}")
    return pathlib.Path(guard.__file__)


def strip_existing(source: str) -> str:
    """Remove any previous insertion, delimited or legacy."""
    while BEGIN in source and END in source:
        head, _, rest = source.partition(BEGIN)
        _, _, tail = rest.partition(END)
        source = head + tail.lstrip("\n")
    return _LEGACY_RE.sub("", source, count=1)


def main() -> int:
    path = target_path()
    original = path.read_text()

    if BLOCK + ANCHOR in original and not _LEGACY_RE.search(original):
        print(f"already patched: {path}")
        return 0

    source = strip_existing(original)
    if ANCHOR not in source:
        sys.exit(
            f"error: anchor not found in {path}; headroom layout changed, "
            "review the guard before re-patching"
        )
    path.write_text(source.replace(ANCHOR, BLOCK + ANCHOR, 1))
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
