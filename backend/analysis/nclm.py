"""landmarks.bin reader, layout NCLM-v1 (contracts/landmarks-header.schema.json).

Mirror of packages/capture-kit/src/landmarks.ts decodeLandmarks: 'NCLM', uint32 LE header length,
JSON header, then length-prefixed little-endian records. Points are returned as float32 values
widened to Python floats, exactly as the TypeScript reader sees them.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field

HAND_POINTS = 21
POSE_POINTS = 33
FACE_POINTS = 478
BLENDSHAPES = 52


@dataclass
class Point:
    x: float
    y: float
    z: float
    v: float | None = None


@dataclass
class Hand:
    label: str  # MediaPipe raw label: 'Left' | 'Right'
    score: float
    pts: list[Point]


@dataclass
class Frame:
    t_ns: int
    seq: int
    hands: list[Hand] = field(default_factory=list)
    pose: list[Point] | None = None
    face: list[Point] | None = None


def _floats(buf: bytes, o: int, n: int) -> tuple[list[float], int]:
    return list(struct.unpack_from(f"<{n}f", buf, o)), o + 4 * n


def read_landmarks(buf: bytes) -> tuple[dict, list[Frame]]:
    if len(buf) < 8 or buf[:4] != b"NCLM":
        raise ValueError("not a NCLM stream")
    (h_len,) = struct.unpack_from("<I", buf, 4)
    if 8 + h_len > len(buf):
        raise ValueError("truncated header")
    header = json.loads(buf[8 : 8 + h_len].decode("utf-8"))
    frames: list[Frame] = []
    o = 8 + h_len
    while o < len(buf):
        if o + 4 > len(buf):
            raise ValueError("truncated record")
        (length,) = struct.unpack_from("<I", buf, o)
        end = o + 4 + length
        if end > len(buf):
            raise ValueError("truncated record")
        o += 4
        t_ns, seq = struct.unpack_from("<qi", buf, o)
        hand_count = buf[o + 13]
        flags = buf[o + 14]
        o += 16 + 16  # fixed part + 4 stats floats
        f = Frame(t_ns=t_ns, seq=seq)
        for _ in range(hand_count):
            label = "Right" if buf[o] == 1 else "Left"
            (score,) = struct.unpack_from("<f", buf, o + 4)
            o += 8
            vals, o = _floats(buf, o, HAND_POINTS * 4)
            pts = [Point(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]) for i in range(0, len(vals), 4)]
            f.hands.append(Hand(label, score, pts))
        if flags & 1:
            vals, o = _floats(buf, o, POSE_POINTS * 4)
            f.pose = [Point(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]) for i in range(0, len(vals), 4)]
        if flags & 2:
            o += 12  # yaw, pitch, roll
            vals, o = _floats(buf, o, FACE_POINTS * 3)
            f.face = [Point(vals[i], vals[i + 1], vals[i + 2]) for i in range(0, len(vals), 3)]
            if flags & 4:
                o += 4 * BLENDSHAPES
        if o != end:
            raise ValueError(f"record length mismatch at seq {seq}")
        frames.append(f)
    return header, frames
