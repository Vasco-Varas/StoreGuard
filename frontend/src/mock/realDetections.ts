// ---------------------------------------------------------------------------
// Real YOLO detections for the demo clips.
//
// `tools/generate_detections.py` (run on a GPU machine) writes one JSON file
// per clip to frontend/public/detections/. When the file exists, the app
// renders REAL detection boxes and 17-joint skeletons from it; when it is
// missing, the app silently falls back to the scripted mock in
// `detections.ts`, so the demo works with or without the generated data.
//
// Stealing risk is ALWAYS the scripted curve from `detections.ts` — it is a
// pitch prop by design. The generated data only decides WHICH tracked person
// carries the "thief" curve (the clip's `thiefTrackId`) and where the boxes
// and skeletons actually are.
// ---------------------------------------------------------------------------

import {
  SUSPECT_THRESHOLD,
  interpolate,
  type Keyframe,
  type Scene,
  type SceneState,
} from './detections'

// One detected person at one sampled moment. Box is frame %; kpts are the 17
// COCO joints as [x, y, visibility], normalized to the person's box.
export interface RealPersonSample {
  /** Stable YOLO track id within the clip. */
  id: number
  x: number
  y: number
  w: number
  h: number
  conf: number
  kpts?: Array<[number, number, number]>
}

export interface RealSample {
  /** Clip progress, 0–1 (samples are evenly spaced). */
  t: number
  people: RealPersonSample[]
}

export interface RealClip {
  source: string
  /** Track id that should carry the scripted "thief" risk curve. */
  thiefTrackId: number
  samples: RealSample[]
  /** Human label per track id, by first appearance: -> "P1", "P2", ... */
  labelOf: Map<number, string>
}

/** COCO 17-joint skeleton edges (joints: 0 nose, 1-2 eyes, 3-4 ears,
 *  5-6 shoulders, 7-8 elbows, 9-10 wrists, 11-12 hips, 13-14 knees, 15-16 ankles). */
export const POSE17_BONES: Array<[number, number]> = [
  [1, 2], [3, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
]

// ---------------------------------------------------------------------------
// Loading (two-step, so a missing file never 404s in the console)
// ---------------------------------------------------------------------------

const cache = new Map<string, RealClip | null>()
const inFlight = new Map<string, Promise<RealClip | null>>()

export function loadRealClip(video: string): Promise<RealClip | null> {
  if (cache.has(video)) return Promise.resolve(cache.get(video)!)
  const started = inFlight.get(video)
  if (started) return started

  const pending = (async () => {
    let clip: RealClip | null = null
    try {
      const stem = (video.split(/[\\/]/).pop() ?? '').replace(/\.[^./\\]+$/, '')
      if (/^[A-Za-z0-9_-]+$/.test(stem)) {
        const res = await fetch(`${import.meta.env.BASE_URL}detections/${stem}.json`)
        if (res.ok) clip = parseRealClip(await res.json())
      }
    } catch {
      clip = null // offline / API down -> scripted mock
    }
    if (clip && clip.samples.length === 0) clip = null
    cache.set(video, clip)
    return clip
  })()
  inFlight.set(video, pending)
  void pending.finally(() => inFlight.delete(video))
  return pending
}

// ---------------------------------------------------------------------------
// Parsing + sanitising
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseRealClip(raw: unknown): RealClip {
  const root = (raw ?? {}) as Record<string, unknown>
  const source = typeof root.source === 'string' ? root.source : 'yolo'
  const thiefRaw = num(root.thiefTrackId)
  const thiefTrackId = thiefRaw !== null && Number.isInteger(thiefRaw) ? thiefRaw : -1

  const samplesIn = Array.isArray(root.samples) ? root.samples : []
  const samples: RealSample[] = []
  for (const s of samplesIn) {
    const row = s as Record<string, unknown>
    const t = num(row.t)
    const peopleIn = Array.isArray(row.people) ? row.people : []
    const people: RealPersonSample[] = []
    for (const p of peopleIn) {
      const q = p as Record<string, unknown>
      const id = num(q.id)
      const x = num(q.x)
      const y = num(q.y)
      const w = num(q.w)
      const h = num(q.h)
      const conf = num(q.conf)
      if (id === null || !Number.isInteger(id) || x === null || y === null || w === null || h === null) continue
      let kpts: Array<[number, number, number]> | undefined
      if (Array.isArray(q.kpts) && q.kpts.length === 17) {
        const pts: Array<[number, number, number]> = []
        let ok = true
        for (const k of q.kpts) {
          const a = Array.isArray(k) ? k : []
          const kx = num(a[0])
          const ky = num(a[1])
          const kv = a.length < 3 ? 1 : num(a[2])
          if (kx === null || ky === null || kv === null) {
            ok = false
            break
          }
          pts.push([kx, ky, kv])
        }
        kpts = ok ? pts : undefined
      }
      people.push({ id, x, y, w, h, conf: conf ?? 0, kpts })
    }
    if (t !== null && t >= 0 && t <= 1) samples.push({ t, people })
  }
  samples.sort((a, b) => a.t - b.t)

  const labelOf = new Map<number, string>()
  let n = 1
  for (const s of samples)
    for (const p of s.people)
      if (!labelOf.has(p.id)) labelOf.set(p.id, `P${n++}`)

  return { source, thiefTrackId, samples, labelOf }
}

// ---------------------------------------------------------------------------
// Evaluating a scene with the real clip (mock risk on top of real boxes)
// ---------------------------------------------------------------------------

/** The scripted risk curve that spikes — the "thief" curve — or null for a
 *  clean scene where nobody's risk ever gets hot. */
export function thiefRiskCurve(scene: Scene): Keyframe[] | null {
  let best: Keyframe[] | null = null
  let bestMax = 0
  for (const p of scene.people) {
    const maxV = Math.max(...p.risk.map((k) => k.v))
    if (maxV > bestMax) {
      bestMax = maxV
      best = p.risk
    }
  }
  return best !== null && bestMax >= SUSPECT_THRESHOLD ? best : null
}

/** Frame-% containment: is this person's centre inside the box? */
function inBox(p: RealPersonSample, box: { x: number; y: number; w: number; h: number }): boolean {
  const cx = p.x + p.w / 2
  const cy = p.y + p.h / 2
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
}

/** Interpolate the real samples to clip progress t: tracks present in both
 *  neighbouring samples get linearly-blended boxes (60 fps from 10 fps data);
 *  a track present in only one sample appears/disappears at the midpoint. */
export function samplesAt(clip: RealClip, t: number): RealPersonSample[] {
  const s = clip.samples
  if (s.length === 0) return []
  if (s.length === 1 || t <= s[0].t) return s[0].people
  const last = s[s.length - 1]
  if (t >= last.t) return last.people

  let i = 0
  while (i < s.length - 2 && s[i + 1].t < t) i++
  const a = s[i]
  const b = s[i + 1]
  const span = b.t - a.t
  const f = span > 0 ? (t - a.t) / span : 0

  const out: RealPersonSample[] = []
  for (const pa of a.people) {
    const pb = b.people.find((q) => q.id === pa.id)
    if (!pb) {
      if (f < 0.5) out.push(pa) // leaving the frame: keep until the midpoint
      continue
    }
    const lerp1 = (u: number, v: number) => u + (v - u) * f
    const person: RealPersonSample = {
      id: pa.id,
      x: lerp1(pa.x, pb.x),
      y: lerp1(pa.y, pb.y),
      w: lerp1(pa.w, pb.w),
      h: lerp1(pa.h, pb.h),
      conf: lerp1(pa.conf, pb.conf),
    }
    const kb = pb.kpts
    if (pa.kpts && kb) {
      person.kpts = pa.kpts.map(
        (k, j) => [lerp1(k[0], kb[j][0]), lerp1(k[1], kb[j][1]), lerp1(k[2], kb[j][2])],
      )
    }
    out.push(person)
  }
  for (const pb of b.people) {
    if (!a.people.some((q) => q.id === pb.id) && f >= 0.5) out.push(pb) // entering
  }
  return out
}

export function evalRealScene(scene: Scene, clip: RealClip, t: number): SceneState {
  const clamped = ((t % 1) + 1) % 1
  const peopleHere = samplesAt(clip, clamped)
  const hot = thiefRiskCurve(scene)
  const low = scene.people[0]?.risk ?? []

  const people = peopleHere.map((p) => {
    const staff = scene.cashier ? inBox(p, scene.cashier) : false
    const riskCurve = hot !== null && !staff && p.id === clip.thiefTrackId ? hot : low
    const risk = Math.max(0, Math.min(100, interpolate(riskCurve, clamped)))
    return {
      id: clip.labelOf.get(p.id) ?? `T${p.id}`,
      trackId: p.id,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      conf: p.conf,
      risk,
      suspect: !staff && risk >= SUSPECT_THRESHOLD,
      staff,
      gait: 0.8,
      kpts: p.kpts,
    }
  })

  return {
    t: clamped,
    people,
    detected: people.filter((p) => !p.staff).length,
    suspects: people.filter((p) => p.suspect).length,
    source: clip.source,
  }
}
