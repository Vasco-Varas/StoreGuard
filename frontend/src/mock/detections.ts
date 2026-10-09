// ---------------------------------------------------------------------------
// StoreGuard mock: scripted, NON-AI detection timeline.
//
// Every position is a percentage of the video frame (x: left, y: top,
// w/h: size, all 0–100), and every moment is a fraction of the clip's
// runtime (t: 0–1), so the same timeline scales to clips of any length.
// Edit the keyframes in SCENES to re-time or re-place anything.
// ---------------------------------------------------------------------------

export interface Keyframe {
  t: number
  v: number
}

export interface TrackKeyframe {
  t: number
  x: number
  y: number
  w: number
  h: number
  conf: number
}

export interface PersonTrack {
  /** Short id shown on the box, e.g. "P1". */
  id: string
  /** Movement path across the clip (at least one frame). */
  path: TrackKeyframe[]
  /** Stealing-likelihood keyframes, 0–100. */
  risk: Keyframe[]
  /** Walk speed used to wobble the skeleton (cycles/s of clip time). */
  gait?: number
}

export interface Scene {
  id: string
  label: string
  /** The demo the UI shows next to the clip switcher. */
  demo: 'theft' | 'clean'
  video: string
  people: PersonTrack[]
  cashier?: { x: number; y: number; w: number; h: number }
}

/** Risk at or above this gets a SUSPECT flag on the person box. */
export const SUSPECT_THRESHOLD = 70

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function interpolate(frames: Keyframe[], t: number): number {
  if (frames.length === 0) return 0
  if (t <= frames[0].t) return frames[0].v
  const last = frames[frames.length - 1]
  if (t >= last.t) return last.v
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i]
    const b = frames[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      return span > 0 ? lerp(a.v, b.v, smoothstep((t - a.t) / span)) : b.v
    }
  }
  return last.v
}

function interpolatePath(path: TrackKeyframe[], t: number): TrackKeyframe {
  if (path.length === 1) return path[0]
  if (t <= path[0].t) return path[0]
  const last = path[path.length - 1]
  if (t >= last.t) return last
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const f = span > 0 ? smoothstep((t - a.t) / span) : 1
      return {
        t,
        x: lerp(a.x, b.x, f),
        y: lerp(a.y, b.y, f),
        w: lerp(a.w, b.w, f),
        h: lerp(a.h, b.h, f),
        conf: lerp(a.conf, b.conf, f),
      }
    }
  }
  return last
}

// ---------------------------------------------------------------------------
// Skeleton: ~10 joints walking inside the bounding box.
// Joints are normalized to the box; the gait phase animates the limbs.
// ---------------------------------------------------------------------------

export const SKELETON_BONES: Array<[number, number]> = [
  [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6], [1, 7], [2, 7], [7, 9],
  [9, 11], [8, 10], [10, 12],
]

export function poseJoints(phase: number): Array<[number, number]> {
  const s = Math.sin(phase)
  const c = Math.cos(phase)
  const bob = c * 0.015 // vertical bobbing of the torso
  // [0] head, 1 L-shoulder, 2 R-shoulder, 3 L-elbow, 4 R-elbow, 5 L-hand,
  // 6 R-hand, 7 pelvis, 8 L-hip, 9 L-knee, 10 R-knee, 11 L-foot, 12 R-foot
  // (joints are [x,y] in 0–1 box units; legs chain pelvis→knee→foot per
  // SKELETON_BONES)
  return [
    [0.5, 0.06 + bob],
    [0.38, 0.2 + bob],
    [0.62, 0.2 + bob],
    [0.35, 0.36 + bob + s * 0.06],
    [0.65, 0.36 + bob - s * 0.06],
    [0.38, 0.52 + bob + s * 0.09],
    [0.62, 0.52 + bob - s * 0.09],
    [0.5, 0.44 + bob],
    [0.45, 0.48 + bob],
    [0.5 + s * 0.13, 0.72 + bob],
    [0.45 - s * 0.13, 0.72 + bob],
    [0.52 + s * 0.17, 0.92 - Math.max(0, s) * 0.06],
    [0.48 - s * 0.17, 0.92 - Math.max(0, -s) * 0.06],
  ]
}

// ---------------------------------------------------------------------------
// Scene evaluation
// ---------------------------------------------------------------------------

export interface PersonState {
  id: string
  /** Real YOLO track id (only in the real-detections mode). */
  trackId?: number
  x: number
  y: number
  w: number
  h: number
  conf: number
  risk: number
  suspect: boolean
  /** Standing at the cashier — excluded from risk and the "detected" count. */
  staff?: boolean
  /** Real 17 COCO pose joints as [x, y, vis], normalized to this box. */
  kpts?: Array<[number, number, number]>
  gait: number
}

export interface SceneState {
  t: number
  people: PersonState[]
  /** People in view, cashier excluded (the whole point of the marker). */
  detected: number
  suspects: number
  /** Model name when real YOLO detections drive the view (e.g. "yolov8n-pose");
   *  absent (undefined) in scripted-mock mode. */
  source?: string
}

export function evaluateScene(scene: Scene, t: number): SceneState {
  const clamped = ((t % 1) + 1) % 1
  const people = scene.people.map((p) => {
    const box = interpolatePath(p.path, clamped)
    const risk = Math.max(0, Math.min(100, interpolate(p.risk, clamped)))
    return {
      id: p.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      conf: box.conf,
      risk,
      suspect: risk >= SUSPECT_THRESHOLD,
      gait: p.gait ?? 0.9,
    }
  })
  return {
    t: clamped,
    people,
    detected: people.length,
    suspects: people.filter((p) => p.suspect).length,
  }
}

// ---------------------------------------------------------------------------
// The scripts. Cashier: fixed, always excluded, never flagged.
// ---------------------------------------------------------------------------

/** Cashier: a fixed region of the frame. Marked, never analysed, never
 *  flagged — this is what the dashboard shows by a dedicated box. */
const CASHIER = { x: 76, y: 60, w: 15, h: 32 }

/** Two-person theft script: shopper P1 browses; P2 lingers on a shelf,
 *  then risk climbs steeply and crosses the SUSPECT threshold in the last
 *  quarter of the clip before the person walks out. `risk` is P2's curve. */
// Resolves a public/ file against the deploy base (relative, so it works under
// a GitHub Pages sub-path as well as at the site root).
const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`

function theftScene(id: string, video: string, risk: Keyframe[]): Scene {
  return {
    id,
    label: 'CAM 1 · Store A',
    demo: 'theft',
    video,
    cashier: CASHIER,
    people: [
      {
        id: 'P1',
        path: [
          { t: 0, x: 6, y: 38, w: 12, h: 40, conf: 0.91 },
          { t: 0.45, x: 30, y: 40, w: 12, h: 40, conf: 0.93 },
          { t: 1, x: 52, y: 42, w: 12, h: 40, conf: 0.88 },
        ],
        risk: [
          { t: 0, v: 4 },
          { t: 0.5, v: 7 },
          { t: 1, v: 3 },
        ],
        gait: 0.7,
      },
      {
        id: 'P2',
        path: [
          { t: 0, x: -4, y: 55, w: 11, h: 38, conf: 0.86 },
          { t: 0.08, x: 14, y: 56, w: 11, h: 38, conf: 0.92 },
          { t: 0.55, x: 38, y: 57, w: 11, h: 38, conf: 0.94 },
          { t: 0.82, x: 56, y: 56, w: 11, h: 38, conf: 0.92 },
          { t: 1, x: 70, y: 55, w: 11, h: 38, conf: 0.9 },
        ],
        risk,
        gait: 1.1,
      },
    ],
  }
}

export const SCENES: Scene[] = [
  theftScene('crime-1', asset('cameras/vid_crime_1.mp4'), [
    { t: 0, v: 5 },
    { t: 0.55, v: 9 },
    { t: 0.7, v: 22 },
    { t: 0.8, v: 58 },
    { t: 0.86, v: 94 },
    { t: 0.93, v: 96 },
    { t: 0.98, v: 30 },
    { t: 1, v: 6 },
  ]),
  theftScene('crime-2', asset('cameras/vid_crime_2.mp4'), [
    { t: 0, v: 6 },
    { t: 0.5, v: 8 },
    { t: 0.66, v: 18 },
    { t: 0.78, v: 64 },
    { t: 0.84, v: 91 },
    { t: 0.9, v: 93 },
    { t: 0.96, v: 38 },
    { t: 1, v: 5 },
  ]),
  theftScene('crime-3', asset('cameras/vid_crime_3.mp4'), [
    { t: 0, v: 4 },
    { t: 0.5, v: 10 },
    { t: 0.68, v: 16 },
    { t: 0.8, v: 52 },
    { t: 0.87, v: 88 },
    { t: 0.94, v: 90 },
    { t: 0.98, v: 25 },
    { t: 1, v: 4 },
  ]),
  {
    id: 'clean-1',
    label: 'CAM 1 · Store A',
    demo: 'clean',
    video: asset('cameras/vid_nocrime_1.mp4'),
    cashier: CASHIER,
    people: [
      {
        id: 'P1',
        path: [
          { t: 0, x: 18, y: 40, w: 12, h: 40, conf: 0.9 },
          { t: 0.5, x: 44, y: 42, w: 12, h: 40, conf: 0.92 },
          { t: 1, x: 66, y: 44, w: 12, h: 40, conf: 0.89 },
        ],
        risk: [
          { t: 0, v: 2 },
          { t: 0.4, v: 6 },
          { t: 0.7, v: 3 },
          { t: 1, v: 2 },
        ],
        gait: 0.6,
      },
    ],
  },
]
