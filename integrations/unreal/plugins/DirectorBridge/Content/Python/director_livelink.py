"""Preview-only live camera/pose protocol for the Unreal connector.

Pure Python (no ``unreal`` import). Implements the session logic for the
``director-unreal-live-preview-v1`` loopback protocol: newline-delimited JSON
messages carrying monotonically increasing sequence numbers. The session

- requires a ``hello`` with the shared loopback token before any frame,
- drops reordered or duplicated frames (stale sequence numbers),
- detects disconnects through an activity timeout,
- never touches scene assets: this is a viewport preview channel only. The
  durable scene channel remains the hash-verified exchange/return package.

The Gateway side of this protocol lives in
``backend/gateway/dcc/unrealLivePreview.ts`` with matching
disconnect/reorder/duplicate tests; the ``live_link`` capability is
``native`` as a preview-only channel and is never the durable scene channel.
Verified host-free by ``backend/gateway/tests/dcc/unrealConnectorModules.test.ts``.
"""

from __future__ import annotations

import hmac
import json
import sys
from typing import Optional, Tuple

PROTOCOL = "director-unreal-live-preview-v1"
MAX_LINE_BYTES = 64 * 1024
DEFAULT_STALE_TIMEOUT_MS = 5_000

# Session decision verbs returned by handle_line.
APPLY = "apply"
DROP = "drop"
HELLO_OK = "hello_ok"
CLOSED = "closed"
ERROR = "error"


def _is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (
        float("inf"),
        float("-inf"),
    )


def _valid_transform(transform) -> bool:
    if not isinstance(transform, dict):
        return False
    for key, size in (("location", 3), ("rotationQuaternion", 4), ("scale", 3)):
        value = transform.get(key)
        if not isinstance(value, list) or len(value) != size:
            return False
        if not all(_is_finite_number(component) for component in value):
            return False
    return True


class PreviewSession:
    """One preview session with token, sequence, and liveness rules."""

    def __init__(self, token: str, stale_timeout_ms: int = DEFAULT_STALE_TIMEOUT_MS):
        if not token or not isinstance(token, str):
            raise ValueError("A non-empty preview token is required.")
        self._token = token
        self._stale_timeout_ms = max(100, int(stale_timeout_ms))
        self._authenticated = False
        self._closed = False
        self._last_sequence: Optional[int] = None
        self._last_activity_ms: Optional[int] = None
        self.applied_count = 0
        self.dropped_count = 0

    @property
    def authenticated(self) -> bool:
        return self._authenticated

    @property
    def closed(self) -> bool:
        return self._closed

    def is_stale(self, now_ms: int) -> bool:
        """True when the peer has been silent past the disconnect timeout."""
        if self._last_activity_ms is None:
            return False
        return now_ms - self._last_activity_ms > self._stale_timeout_ms

    def handle_line(self, line: str, now_ms: int) -> Tuple[str, Optional[dict], Optional[str]]:
        """Process one protocol line.

        @param line: One newline-delimited JSON message.
        @param now_ms: Monotonic wall time in milliseconds.
        @returns ``(verb, payload, reason)`` where verb is one of ``apply``,
            ``drop``, ``hello_ok``, ``closed``, or ``error``. ``payload`` is
            the validated frame body for ``apply``.
        """
        if self._closed:
            return (ERROR, None, "session is closed")
        if len(line.encode("utf-8", errors="replace")) > MAX_LINE_BYTES:
            return (ERROR, None, "message exceeds the line budget")
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return (ERROR, None, "malformed JSON")
        if not isinstance(message, dict):
            return (ERROR, None, "message must be a JSON object")

        message_type = message.get("type")
        if not self._authenticated:
            if message_type != "hello":
                return (ERROR, None, "the first message must be hello")
            if message.get("protocol") != PROTOCOL:
                return (ERROR, None, f"unsupported protocol {message.get('protocol')!r}")
            token = message.get("token")
            if not isinstance(token, str) or not hmac.compare_digest(token, self._token):
                return (ERROR, None, "invalid preview token")
            self._authenticated = True
            self._last_activity_ms = now_ms
            return (HELLO_OK, None, None)

        self._last_activity_ms = now_ms
        if message_type == "bye":
            self._closed = True
            return (CLOSED, None, None)
        if message_type != "camera_frame":
            return (DROP, None, f"unknown message type {message_type!r}")

        sequence = message.get("seq")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
            return (DROP, None, "camera_frame requires a non-negative integer seq")
        if self._last_sequence is not None and sequence <= self._last_sequence:
            self.dropped_count += 1
            return (DROP, None, f"stale sequence {sequence} (last applied {self._last_sequence})")
        transform = message.get("transform")
        if not _valid_transform(transform):
            self.dropped_count += 1
            return (DROP, None, "camera_frame transform is malformed")
        focal_length = message.get("focalLengthMm")
        if focal_length is not None and (not _is_finite_number(focal_length) or focal_length <= 0):
            self.dropped_count += 1
            return (DROP, None, "camera_frame focalLengthMm must be a positive number")

        self._last_sequence = sequence
        self.applied_count += 1
        payload = {"seq": sequence, "transform": transform}
        if focal_length is not None:
            payload["focalLengthMm"] = focal_length
        return (APPLY, payload, None)


def _run_cli(argv: list) -> int:
    """Scripted session driver used by the host-free Gateway tests.

    stdin: ``{"token": str, "staleTimeoutMs": int, "events": [
      {"atMs": int, "line": str} | {"atMs": int, "checkStale": true}
    ]}``; stdout: the per-event decisions plus final counters.
    """
    payload = json.loads(sys.stdin.read())
    session = PreviewSession(payload["token"], payload.get("staleTimeoutMs", DEFAULT_STALE_TIMEOUT_MS))
    decisions = []
    for event in payload.get("events", []):
        at_ms = event["atMs"]
        if event.get("checkStale"):
            decisions.append({"stale": session.is_stale(at_ms)})
            continue
        verb, body, reason = session.handle_line(event["line"], at_ms)
        decisions.append({"verb": verb, "payload": body, "reason": reason})
    print(
        json.dumps(
            {
                "ok": True,
                "decisions": decisions,
                "applied": session.applied_count,
                "dropped": session.dropped_count,
                "closed": session.closed,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_cli(sys.argv[1:]))
