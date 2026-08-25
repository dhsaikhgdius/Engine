"""Rational frame rates, tick resolutions, and SMPTE timecode for Sequencer.

Pure Python (no ``unreal`` import) mirror of the Director reference
implementations in ``packages/project-schema/src/frameRate.ts`` and
``frontend/director/src/comprehensive/editor/timeline/timecode.ts``, so the
math can be verified host-free with ``python3 director_timebase.py
--self-test`` and by the Gateway test suite
(``backend/gateway/tests/dcc/unrealConnectorModules.test.ts``).

Covers the rates the fixtures document: 23.976 (24000/1001), 24, 25,
29.97 drop-frame (30000/1001), and 30.
"""

from __future__ import annotations

import json
import math
import re
import sys
from typing import Optional, Tuple

Rate = Tuple[int, int]

MAX_RATE_COMPONENT = 1_000_000

# Industry-standard rates, mirrored from DIRECTOR_COMMON_FRAME_RATES.
COMMON_RATES: Tuple[Rate, ...] = (
    (24_000, 1_001),
    (24, 1),
    (25, 1),
    (30_000, 1_001),
    (30, 1),
    (60_000, 1_001),
    (60, 1),
)

TIMECODE_PATTERN = re.compile(r"^(-)?(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$")


class DirectorTimebaseError(ValueError):
    """Raised when a rate or timecode cannot be interpreted."""


def _reduced_rate(numerator: int, denominator: int) -> Optional[Rate]:
    if numerator <= 0 or denominator <= 0:
        return None
    if numerator > MAX_RATE_COMPONENT or denominator > MAX_RATE_COMPONENT:
        return None
    divisor = math.gcd(numerator, denominator)
    rate = (numerator // divisor, denominator // divisor)
    value = rate[0] / rate[1]
    return rate if 1.0 <= value <= 240.0 else None


def _decimal_rate(value: float) -> Optional[Rate]:
    if not math.isfinite(value) or value < 1.0 or value > 240.0:
        return None
    for rate in COMMON_RATES:
        if abs(rate[0] / rate[1] - value) < 0.000_1:
            return rate
    text = repr(float(value)).lower()
    if "e" in text:
        return _reduced_rate(round(value * 1_000_000), 1_000_000)
    decimals = len(text.split(".")[1]) if "." in text else 0
    denominator = 10 ** min(6, decimals)
    return _reduced_rate(round(value * denominator), denominator)


def normalize_rate(rate_input, fallback: Rate = (24, 1)) -> Rate:
    """Normalize a rate (dict, [num, den], number, or "num/den" string) to a reduced pair."""
    parsed: Optional[Rate] = None
    if isinstance(rate_input, dict):
        numerator = rate_input.get("numerator")
        denominator = rate_input.get("denominator")
        if isinstance(numerator, int) and isinstance(denominator, int):
            parsed = _reduced_rate(numerator, denominator)
    elif isinstance(rate_input, (list, tuple)) and len(rate_input) == 2:
        if all(isinstance(component, int) for component in rate_input):
            parsed = _reduced_rate(rate_input[0], rate_input[1])
    elif isinstance(rate_input, (int, float)) and not isinstance(rate_input, bool):
        parsed = _decimal_rate(float(rate_input))
    elif isinstance(rate_input, str):
        text = re.sub(r"\s*(?:NDF|DF)\s*$", "", rate_input.strip(), flags=re.IGNORECASE)
        fraction = re.match(r"^(\d+)\s*/\s*(\d+)$", text)
        if fraction:
            parsed = _reduced_rate(int(fraction.group(1)), int(fraction.group(2)))
        else:
            try:
                parsed = _decimal_rate(float(text))
            except ValueError:
                parsed = None
    return parsed if parsed is not None else fallback


def serialize_rate(rate: Rate) -> str:
    """Canonical ``numerator/denominator`` string for receipts."""
    return f"{rate[0]}/{rate[1]}"


def nominal_fps(rate: Rate) -> int:
    """Nearest integer fps (24 for 23.976, 30 for 29.97)."""
    return round(rate[0] / rate[1])


def supports_drop_frame(rate: Rate) -> bool:
    """Only NTSC 29.97 and 59.94 carry the SMPTE drop-frame convention."""
    return rate in ((30_000, 1_001), (60_000, 1_001))


def tick_resolution(rate: Rate) -> Rate:
    """Sequencer tick resolution for a display rate.

    Prefers Unreal's default 24000/1 whenever it yields an integer tick count
    per display frame (24, 25, 30, 60, and 23.976 all do). NTSC rates whose
    frames do not divide 24000 ticks (29.97, 59.94) use ``numerator/1``, which
    always gives an integer ``denominator`` ticks per frame.
    """
    numerator, denominator = rate
    if (24_000 * denominator) % numerator == 0:
        return (24_000, 1)
    return (numerator, 1)


def ticks_per_frame(rate: Rate) -> int:
    """Integer ticks per display frame at the derived tick resolution."""
    tick_numerator, tick_denominator = tick_resolution(rate)
    ticks = (tick_numerator * rate[1]) / (tick_denominator * rate[0])
    if abs(ticks - round(ticks)) > 1e-9:
        raise DirectorTimebaseError(f"Tick resolution is not frame-aligned for rate {serialize_rate(rate)}")
    return round(ticks)


def _drop_frame_count(rate: Rate) -> int:
    return round(nominal_fps(rate) * (2 / 30))


def _frames_per_24_hours(rate: Rate, drop_frame: bool) -> int:
    nominal = nominal_fps(rate)
    if not drop_frame:
        return nominal * 60 * 60 * 24
    dropped = _drop_frame_count(rate)
    return nominal * 60 * 60 * 24 - dropped * (24 * 60 - 24 * 6)


def _to_timecode_frame_number(frame: int, rate: Rate, drop_frame: bool) -> int:
    if not drop_frame:
        return frame
    nominal = nominal_fps(rate)
    dropped = _drop_frame_count(rate)
    frames_per_minute = nominal * 60 - dropped
    frames_per_ten_minutes = nominal * 60 * 10 - dropped * 9
    ten_minute_blocks = frame // frames_per_ten_minutes
    block_remainder = frame % frames_per_ten_minutes
    extra = dropped * ((block_remainder - dropped) // frames_per_minute) if block_remainder >= dropped else 0
    return frame + dropped * 9 * ten_minute_blocks + extra


def format_timecode(frame: int, rate_input, drop_frame: bool = False, wrap_24_hours: bool = True) -> str:
    """Format a frame number as SMPTE timecode (mirror of formatSmpteTimecode)."""
    rate = normalize_rate(rate_input)
    drop = bool(drop_frame and supports_drop_frame(rate))
    negative = frame < 0
    normalized = abs(int(frame))
    if wrap_24_hours:
        normalized %= _frames_per_24_hours(rate, drop)
    timecode_frame = _to_timecode_frame_number(normalized, rate, drop)
    nominal = nominal_fps(rate)
    frames = timecode_frame % nominal
    total_seconds = timecode_frame // nominal
    seconds = total_seconds % 60
    minutes = (total_seconds // 60) % 60
    hours = total_seconds // 3_600
    separator = ";" if drop else ":"
    sign = "-" if negative else ""
    return f"{sign}{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{frames:02d}"


def parse_timecode(source: str, rate_input, drop_frame: Optional[bool] = None) -> Optional[int]:
    """Parse SMPTE timecode to a frame number (mirror of parseSmpteTimecode).

    Returns ``None`` for malformed strings, out-of-range fields, a separator
    that contradicts the requested drop-frame mode, or drop-frame timecodes
    that name a dropped frame (for example ``00:01:00;00`` at 29.97 DF).
    """
    match = TIMECODE_PATTERN.match(source.strip())
    if not match:
        return None
    rate = normalize_rate(rate_input)
    requested_drop = (match.group(5) == ";") if drop_frame is None else bool(drop_frame)
    drop = bool(requested_drop and supports_drop_frame(rate))
    if requested_drop and not drop:
        return None
    if (match.group(5) == ";") != drop:
        return None
    hours = int(match.group(2))
    minutes = int(match.group(3))
    seconds = int(match.group(4))
    frames = int(match.group(6))
    nominal = nominal_fps(rate)
    if hours > 23 or minutes > 59 or seconds > 59 or frames >= nominal:
        return None
    dropped = _drop_frame_count(rate) if drop else 0
    if drop and minutes % 10 != 0 and seconds == 0 and frames < dropped:
        return None
    total_minutes = hours * 60 + minutes
    frame = (hours * 3_600 + minutes * 60 + seconds) * nominal + frames - dropped * (total_minutes - total_minutes // 10)
    return -frame if match.group(1) else frame


def timebase_from_manifest(timeline: Optional[dict]) -> dict:
    """Resolve a manifest timeline to {rate, dropFrame, startTimecode}.

    Prefers the explicit rational ``timebase`` stanza; falls back to the
    legacy decimal ``fps`` field, then to 24 fps NDF at ``00:00:00:00``.
    """
    timeline = timeline or {}
    stanza = timeline.get("timebase") or {}
    rate = normalize_rate(stanza.get("rate"), normalize_rate(timeline.get("fps"), (24, 1)))
    drop_frame = bool(stanza.get("dropFrame")) and supports_drop_frame(rate)
    default_start = "00:00:00;00" if drop_frame else "00:00:00:00"
    candidate = stanza.get("startTimecode")
    start_timecode = candidate if isinstance(candidate, str) and TIMECODE_PATTERN.match(candidate) else default_start
    if parse_timecode(start_timecode, rate, drop_frame) is None:
        start_timecode = default_start
    return {"rate": {"numerator": rate[0], "denominator": rate[1]}, "dropFrame": drop_frame, "startTimecode": start_timecode}


# Golden cases mirrored by the Gateway host-free tests. Keep values in sync
# with the TypeScript reference implementations.
SELF_TEST_CASES = [
    {"kind": "normalize", "input": 23.976, "rate": [24_000, 1_001]},
    {"kind": "normalize", "input": 29.97, "rate": [30_000, 1_001]},
    {"kind": "normalize", "input": "30000/1001", "rate": [30_000, 1_001]},
    {"kind": "normalize", "input": 24, "rate": [24, 1]},
    {"kind": "normalize", "input": 25, "rate": [25, 1]},
    {"kind": "normalize", "input": 30, "rate": [30, 1]},
    {"kind": "tick", "rate": [24, 1], "tick": [24_000, 1], "ticksPerFrame": 1_000},
    {"kind": "tick", "rate": [24_000, 1_001], "tick": [24_000, 1], "ticksPerFrame": 1_001},
    {"kind": "tick", "rate": [25, 1], "tick": [24_000, 1], "ticksPerFrame": 960},
    {"kind": "tick", "rate": [30_000, 1_001], "tick": [30_000, 1], "ticksPerFrame": 1_001},
    {"kind": "tick", "rate": [30, 1], "tick": [24_000, 1], "ticksPerFrame": 800},
    {"kind": "tick", "rate": [60_000, 1_001], "tick": [60_000, 1], "ticksPerFrame": 1_001},
    {"kind": "parse", "timecode": "01:00:00:00", "rate": [24, 1], "dropFrame": False, "frame": 86_400},
    {"kind": "parse", "timecode": "00:00:01:12", "rate": [24, 1], "dropFrame": False, "frame": 36},
    # 23.976 NDF counts frames at the nominal 24.
    {"kind": "parse", "timecode": "01:00:00:00", "rate": [24_000, 1_001], "dropFrame": False, "frame": 86_400},
    {"kind": "parse", "timecode": "10:01:30:20", "rate": [25, 1], "dropFrame": False, "frame": 902_270},
    # 29.97 drop-frame: two frame numbers are dropped every minute except each tenth.
    {"kind": "parse", "timecode": "00:01:00;02", "rate": [30_000, 1_001], "dropFrame": True, "frame": 1_800},
    {"kind": "parse", "timecode": "00:10:00;00", "rate": [30_000, 1_001], "dropFrame": True, "frame": 17_982},
    {"kind": "parse", "timecode": "01:00:00;00", "rate": [30_000, 1_001], "dropFrame": True, "frame": 107_892},
    {"kind": "parse", "timecode": "00:01:00;00", "rate": [30_000, 1_001], "dropFrame": True, "frame": None},
    {"kind": "parse", "timecode": "00:01:00:00", "rate": [30, 1], "dropFrame": False, "frame": 1_800},
    # A drop-frame separator is rejected on rates without the convention.
    {"kind": "parse", "timecode": "00:01:00;00", "rate": [24, 1], "dropFrame": None, "frame": None},
    {"kind": "format", "frame": 1_800, "rate": [30_000, 1_001], "dropFrame": True, "timecode": "00:01:00;02"},
    {"kind": "format", "frame": 17_982, "rate": [30_000, 1_001], "dropFrame": True, "timecode": "00:10:00;00"},
    {"kind": "format", "frame": 86_400, "rate": [24_000, 1_001], "dropFrame": False, "timecode": "01:00:00:00"},
]


def run_self_test() -> int:
    failures = []
    for case in SELF_TEST_CASES:
        if case["kind"] == "normalize":
            actual = normalize_rate(case["input"])
            if list(actual) != case["rate"]:
                failures.append(f"normalize({case['input']!r}) = {actual}, expected {case['rate']}")
        elif case["kind"] == "tick":
            rate = (case["rate"][0], case["rate"][1])
            actual_tick = tick_resolution(rate)
            if list(actual_tick) != case["tick"]:
                failures.append(f"tick_resolution({rate}) = {actual_tick}, expected {case['tick']}")
            actual_ticks = ticks_per_frame(rate)
            if actual_ticks != case["ticksPerFrame"]:
                failures.append(f"ticks_per_frame({rate}) = {actual_ticks}, expected {case['ticksPerFrame']}")
        elif case["kind"] == "parse":
            actual = parse_timecode(case["timecode"], tuple(case["rate"]), case["dropFrame"])
            if actual != case["frame"]:
                failures.append(f"parse_timecode({case['timecode']}) = {actual}, expected {case['frame']}")
        elif case["kind"] == "format":
            actual = format_timecode(case["frame"], tuple(case["rate"]), case["dropFrame"])
            if actual != case["timecode"]:
                failures.append(f"format_timecode({case['frame']}) = {actual}, expected {case['timecode']}")
    # Round-trip invariants across every supported rate.
    for rate in COMMON_RATES:
        drop_modes = (False, True) if supports_drop_frame(rate) else (False,)
        for drop in drop_modes:
            for frame in (0, 1, 899, 1_799, 1_800, 17_981, 17_982, 107_892, 902_270):
                encoded = format_timecode(frame, rate, drop)
                decoded = parse_timecode(encoded, rate, drop)
                if decoded != frame:
                    failures.append(f"round trip failed at {rate} drop={drop} frame={frame}: {encoded} -> {decoded}")
    if failures:
        print(json.dumps({"ok": False, "failures": failures}))
        return 1
    print(json.dumps({"ok": True, "cases": len(SELF_TEST_CASES)}))
    return 0


def _run_cli(argv: list) -> int:
    """JSON-in/JSON-out CLI used by the host-free Gateway tests."""
    if "--self-test" in argv:
        return run_self_test()
    payload = json.loads(sys.stdin.read())
    operation = payload.get("op")
    if operation == "parse_timecode":
        result = parse_timecode(payload["timecode"], payload["rate"], payload.get("dropFrame"))
    elif operation == "format_timecode":
        result = format_timecode(payload["frame"], payload["rate"], payload.get("dropFrame", False))
    elif operation == "normalize_rate":
        result = list(normalize_rate(payload["rate"]))
    elif operation == "tick_resolution":
        result = list(tick_resolution(normalize_rate(payload["rate"])))
    elif operation == "timebase_from_manifest":
        result = timebase_from_manifest(payload.get("timeline"))
    else:
        print(json.dumps({"ok": False, "error": f"unknown op {operation!r}"}))
        return 2
    print(json.dumps({"ok": True, "result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_cli(sys.argv[1:]))
