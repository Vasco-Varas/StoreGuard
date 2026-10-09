#!/usr/bin/env python3
"""
StoreGuard — real person detections + 17-point poses for the demo clips.

This script runs on YOUR machine (a GPU box — that's the point; it also
works on CPU, just slower). It is the "real YOLO" half of the StoreGuard
demo: it processes the stock camera clips, detects people + pose with
ultralytics, tracks them across frames, and writes one JSON per clip that
the web app picks up automatically. Without the JSON the app falls back to
its scripted mock tracks, so nothing breaks if you never run this.

One-time setup:
    pip install ultralytics opencv-python numpy

Examples:
    python tools/generate_detections.py                          # all clips, yolov8n-pose @ 10 fps
    python tools/generate_detections.py --clip vid_crime_1 --clip vid_nocrime_1
    python tools/generate_detections.py --model yolov8s-pose --fps 15
    python tools/generate_detections.py --device cpu

Output (one per clip, named <clip-stem>.json in --out; the web app looks it
up by clip filename, so keep the names):
    {
      "source": "yolov8n-pose",
      "video": "vid_crime_1.mp4",
      "thiefTrackId": 2,
      "samples": [
        { "t": 0.0,
          "people": [
            { "id": 0, "x": 12.3, "y": 38.1, "w": 11.2, "h": 39.5,
              "conf": 0.87,
              "kpts": [[0.51, 0.04, 1], ...] }   # 17 COCO joints,
                                                 # [x, y, vis], 0-1 of the box
          ] }, ...
      ]
    }

Box coordinates are percentages of the frame (x,y = top-left; w,h = size),
matching how the web app positions overlays. Person ids are stable within a
clip (a simple IoU tracker). "thiefTrackId" is the person closest to where
the scripted risk spike of the demo happens — the web app applies its
mocked "thief" risk curve to that person only. Risk values are deliberately
NOT generated here: stealing-likelihood is a pitch prop, keep it scripted.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

try:
    import cv2
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency: pip install opencv-python")

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency: pip install ultralytics")

ROOT = Path(__file__).resolve().parent.parent

# Where the script's "story" happens: the risk spike lands in the last few
# seconds of the clip, in the middle of the frame. Used to pick which
# tracked person the mocked thief risk curve belongs to.
CLIMAX_T = 0.85
CLIMAX_WINDOW = 0.20
DEFAULT_THIEF_X = 55.0  # frame %, horizontal
DEFAULT_THIEF_Y = 56.0  # frame %, vertical


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--model",
        default="yolov8n-pose",
        help="any ultralytics pose weight: name, URL or local .pt (default: %(default)s)",
    )
    ap.add_argument(
        "--src",
        default=str(ROOT / "frontend/public/cameras"),
        help="directory with the camera clips (default: %(default)s)",
    )
    ap.add_argument(
        "--out",
        default=str(ROOT / "frontend/public/detections"),
        help="where the JSON files are written (default: %(default)s)",
    )
    ap.add_argument(
        "--fps", type=float, default=10.0,
        help="sample rate in fps (default: 10 — plenty for the animation)",
    )
    ap.add_argument(
        "--min-conf", type=float, default=0.35,
        help="minimum person confidence to keep (default: %(default)s)",
    )
    ap.add_argument(
        "--device", default="auto",
        help="torch device: 'auto', '0', '1', 'cpu' (default: auto -> GPU if available)",
    )
    ap.add_argument(
        "--clip", action="append", default=None,
        help="process only this clip (stem or filename, repeatable)",
    )
    ap.add_argument(
        "--thief-x", type=float, default=DEFAULT_THIEF_X,
        help="horiz. frame %% of the scripted thief's late position (default: %(default)s)",
    )
    ap.add_argument(
        "--thief-y", type=float, default=DEFAULT_THIEF_Y,
        help="vert. frame %% of the scripted thief's late position (default: %(default)s)",
    )
    return ap.parse_args()


def resolve_device(name: str) -> str:
    if name in ("auto", ""):
        try:
            import torch
            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"
    return name


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Minimal IoU tracker (greedy, no velocity model — the clips are short and
# mostly 1-2 people, so this is all they need)
# ---------------------------------------------------------------------------

def box_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


class Tracker:
    """Greedy IoU matching. A track survives `max_age` samples without a hit
    (bridges the frames a detector blinks, drops people who have left)."""

    def __init__(self, iou_thresh: float = 0.3, max_age: int = 8):
        self.iou_thresh = iou_thresh
        self.max_age = max_age
        self.tracks: dict[int, dict] = {}
        self._next_id = 0

    def update(
        self, dets: list[tuple[list[float], float, int, int]]
    ) -> list[tuple[int, list[float], float, int, int]]:
        """dets: [(box in frame %, conf, box_index, sample_index)]
        -> [(track_id, box, conf, box_index, sample_index)]."""
        for tr in self.tracks.values():
            tr["age"] += 1
            tr["matched"] = False

        out: list[tuple[int, list[float], float, int, int]] = []
        for box, conf, row, n in dets:
            best_tid, best_iou = None, 0.0
            for tid, tr in self.tracks.items():
                if tr["matched"]:
                    continue
                iou = box_iou(box, tr["box"])
                if iou > best_iou:
                    best_iou, best_tid = iou, tid
            if best_tid is not None and best_iou >= self.iou_thresh:
                tr = self.tracks[best_tid]
                tr["box"] = box
                tr["matched"] = True
                tr["age"] = 0
                out.append((best_tid, box, conf, row, n))
            else:
                self.tracks[self._next_id] = {"box": box, "age": 0, "matched": True}
                out.append((self._next_id, box, conf, row, n))
                self._next_id += 1

        self.tracks = {tid: tr for tid, tr in self.tracks.items() if tr["age"] <= self.max_age}
        return out


# ---------------------------------------------------------------------------
# Frame -> person samples
# ---------------------------------------------------------------------------

def kpts_row(result, row: int, box: list[float]) -> list[list[float]] | None:
    """17 joints of person `row` as [x, y, vis] normalized to that person's
    box. x/y come from ultralytics' normalized keypoints; vis is 0 for joints
    that land far outside the box (the model's per-joint visibility flag is
    not part of the stable API across 8.x versions, so this bounding-box
    heuristic is the portable one)."""
    kpts = result.keypoints
    xyn = getattr(kpts, "xyn", None) if kpts is not None else None
    if xyn is None:
        return None
    x, y, w, h = box
    if w <= 0 or h <= 0:
        return None
    out: list[list[float]] = []
    krow = xyn[row]  # (17, 2), normalized to the *image*
    for j in range(17):
        kx = float(krow[j, 0]) * 100.0
        ky = float(krow[j, 1]) * 100.0
        bx = (kx - x) / w
        by = (ky - y) / h
        vis = 1.0 if -0.4 <= bx <= 1.4 and -0.4 <= by <= 1.4 else 0.0
        out.append([round(bx, 4), round(by, 4), vis])
    return out


def process_clip(model, path: Path, args: argparse.Namespace, device: str) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open {path} with OpenCV")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(fps / args.fps)))
    tracker = Tracker(max_age=max(4, int(round(args.fps))))

    samples: list[list[dict]] = []
    counts: dict[int, int] = {}
    idx = 0
    while True:
        if not cap.grab():
            break
        if idx % step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            result = model.predict(
                frame, classes=[0], conf=args.min_conf, device=device, verbose=False
            )[0]

            boxes = result.boxes
            dets: list[tuple[list[float], float, int, int]] = []
            if boxes is not None and len(boxes) > 0:
                for r in range(len(boxes)):
                    x1, y1, x2, y2 = (float(v) for v in boxes.xyxyn[r].tolist())
                    dets.append(
                        (
                            [x1 * 100.0, y1 * 100.0, (x2 - x1) * 100.0, (y2 - y1) * 100.0],
                            float(boxes.conf[r]),
                            r,
                            idx,
                        )
                    )

            people: list[dict] = []
            for tid, box, conf, row, _n in tracker.update(dets):
                x = round(_clamp(box[0], 0.0, max(0.0, 100.0 - box[2])), 2)
                y = round(_clamp(box[1], 0.0, max(0.0, 100.0 - box[3])), 2)
                w = round(min(100.0, max(0.0, box[2])), 2)
                h = round(min(100.0, max(0.0, box[3])), 2)
                person: dict = {"id": tid, "x": x, "y": y, "w": w, "h": h, "conf": round(conf, 3)}
                k = kpts_row(result, row, box)
                if k:
                    person["kpts"] = k
                people.append(person)
                counts[tid] = counts.get(tid, 0) + 1

            samples.append(people)
        idx += 1
    cap.release()

    if not samples:
        raise RuntimeError(f"No frames could be read from {path}")

    # Re-time to clip progress 0–1 (samples are evenly spaced by construction)
    # and drop tracks that only ever appeared in one or two samples (flash).
    short = {tid for tid, c in counts.items() if c < 2}
    ret: list[dict] = []
    n = len(samples)
    for i, people in enumerate(samples):
        filtered = [p for p in people if p["id"] not in short]
        if filtered:
            ret.append({"t": round(i / (n - 1), 4) if n > 1 else 0.0, "people": filtered})

    return {
        "source": args.model,
        "video": path.name,
        "thiefTrackId": pick_thief(ret, args),
        "samples": ret,
        "_n_frames": idx + 1,
    }


def pick_thief(samples: list[dict], args: argparse.Namespace) -> int:
    """Which person gets the mocked thief risk curve.

    Preference = the person who is both visible during the scripted climax of
    the clip (the last stretch where risk spikes) and whose average position
    in that window is closest to `--thief-x/--thief-y` (frame %). Presence
    during the window is part of the score, so a passer-by who only happens
    to cross the spot loses to someone standing there. Returns -1 when
    nobody was detected.
    """
    if not samples:
        return -1
    t_lo, t_hi = CLIMAX_T - CLIMAX_WINDOW / 2, CLIMAX_T + CLIMAX_WINDOW / 2
    window = [s for s in samples if t_lo <= s["t"] <= t_hi] or samples[-1:]
    ids = sorted({p["id"] for s in samples for p in s["people"]})
    if not ids:
        return -1

    def score(pid: int) -> float:
        pts = [
            (p["x"] + p["w"] / 2, p["y"] + p["h"] / 2)
            for s in window
            for p in s["people"]
            if p["id"] == pid
        ]
        if not pts:
            return float("inf")
        cx = sum(x for x, _y in pts) / len(pts)
        cy = sum(y for _x, y in pts) / len(pts)
        presence = len(pts) / max(1, len(window))
        return math.hypot(cx - args.thief_x, cy - args.thief_y) / max(0.35, presence)

    return min(ids, key=score)


def main() -> None:
    args = parse_args()
    src = Path(args.src).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()
    if not src.is_dir():
        sys.exit(f"Clips directory not found: {src}")

    clips = sorted(src.glob("*.mp4"))
    if not clips:
        sys.exit(f"No .mp4 files in {src}")
    if args.clip:
        wanted = {c.replace(".mp4", "") for c in args.clip}
        clips = [c for c in clips if c.stem in wanted or c.name in wanted]
        if not clips:
            sys.exit("None of the --clip names match a .mp4 in the clips directory")

    device = resolve_device(args.device)
    print(f"Model: {args.model}  (device: {device})")
    model = YOLO(args.model)

    out.mkdir(parents=True, exist_ok=True)
    for path in clips:
        print(path.name, "...")
        t0 = time.time()
        data = process_clip(model, path, args, device)
        n_tracks = len({p["id"] for s in data["samples"] for p in s["people"]})
        dest = out / f"{path.stem}.json"
        n_frames = data.pop("_n_frames")
        dest.write_text(json.dumps(data))
        print(
            f"  {n_frames} frames -> {len(data['samples'])} samples, "
            f"{n_tracks} person(s), thief -> track {data['thiefTrackId']} "
            f"({dest.stat().st_size / 1024:.0f} KB, {time.time() - t0:.1f}s) -> {dest}"
        )

    print(
        "\nDone. The web app uses these JSONs automatically (real boxes and "
        "skeletons, risk stays scripted); delete a file to fall back to the "
        "scripted mock for that clip."
    )


if __name__ == "__main__":
    main()
