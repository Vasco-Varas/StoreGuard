import { describe, expect, it } from 'vitest'
import { SCENES, SUSPECT_THRESHOLD } from './detections'
import {
  evalRealScene,
  parseRealClip,
  samplesAt,
  thiefRiskCurve,
  POSE17_BONES,
  type RealClip,
  type RealSample,
} from './realDetections'

// Synthetic clip: person 0 walks left-to-right; person 1 stands at the cashier.
function makeClip(thiefTrackId = 0): RealClip {
  const samples: RealSample[] = [
    { t: 0.25, people: [
      { id: 0, x: 20, y: 50, w: 10, h: 35, conf: 0.9, kpts: kpts(20, 50) },
      { id: 1, x: 80, y: 65, w: 8, h: 30, conf: 0.85 },
    ]},
    { t: 0.5, people: [
      { id: 0, x: 30, y: 51, w: 10, h: 36, conf: 0.92, kpts: kpts(30, 51) },
      { id: 1, x: 82, y: 66, w: 8, h: 30, conf: 0.84 },
    ]},
    { t: 0.75, people: [
      { id: 0, x: 40, y: 52, w: 10, h: 36, conf: 0.9, kpts: kpts(40, 52) },
      // person 1 left the frame
    ]},
    { t: 1, people: [
      { id: 0, x: 50, y: 53, w: 10, h: 35, conf: 0.88, kpts: kpts(50, 53) },
    ]},
  ]
  return parseRealClip({ source: 'test-model', thiefTrackId, samples })
}

// 17 near-trivial joints: two "eyes" at the top, all visible except index 3.
function kpts(x: number, y: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = []
  for (let i = 0; i < 17; i++) {
    const kx = 0.1 + (i % 5) * 0.2 // 0–1 in box units
    const ky = 0.05 + Math.floor(i / 5) * 0.3
    pts.push([kx, ky, i === 3 ? 0 : 1])
  }
  void x
  void y
  return pts
}

const crime1 = SCENES.find((s) => s.id === 'crime-1')!
const clean1 = SCENES.find((s) => s.id === 'clean-1')!

describe('parseRealClip', () => {
  it('assigns labels by first appearance in t order', () => {
    const clip = makeClip()
    expect(clip.labelOf.get(0)).toBe('P1')
    expect(clip.labelOf.get(1)).toBe('P2')
  })

  it('drops samples/people with non-finite geometry but keeps the rest', () => {
    const clip = parseRealClip({
      source: 's',
      thiefTrackId: -1,
      samples: [
        { t: 0.1, people: [
          { id: 0, x: 1, y: 2, w: 3, h: 4, conf: 0.9 },
          { id: 5, x: Number.NaN, y: 2, w: 3, h: 4, conf: 0.9 }, // bad -> dropped
        ]},
        { t: Number.NaN, people: [{ id: 0, x: 1, y: 2, w: 3, h: 4, conf: 0.9 }] }, // bad t -> dropped
      ],
    })
    expect(clip.samples).toHaveLength(1)
    expect(clip.samples[0].people.map((p) => p.id)).toEqual([0])
  })

  it('keeps 17-joint kpts, drops malformed ones', () => {
    const clip = parseRealClip({
      source: 's',
      thiefTrackId: 0,
      samples: [
        { t: 0, people: [
          { id: 0, x: 1, y: 1, w: 5, h: 5, conf: 0.9, kpts: kpts(1, 1) },
          { id: 1, x: 2, y: 2, w: 5, h: 5, conf: 0.9, kpts: [[0.1, 0.1, 1], [0.2, 0.2, 1]] },
        ]},
      ],
    })
    expect(clip.samples[0].people[0].kpts).toHaveLength(17)
    expect(clip.samples[0].people[1].kpts).toBeUndefined()
  })

  it('coerces a non-integer thiefTrackId to -1', () => {
    expect(parseRealClip({ source: 's', thiefTrackId: 'nope', samples: [] }).thiefTrackId).toBe(-1)
    expect(parseRealClip({ source: 's', thiefTrackId: 2.5, samples: [] }).thiefTrackId).toBe(-1)
    expect(makeClip(1).thiefTrackId).toBe(1)
  })
})

describe('samplesAt', () => {
  it('interpolates box and joints between samples', () => {
    const clip = makeClip()
    const at = samplesAt(clip, 0.625) // midpoint of 0.5..0.75
    const p0 = at.find((p) => p.id === 0)!
    expect(p0.x).toBeCloseTo(35)
    expect(p0.h).toBeCloseTo(36)
    // kpts interpolated element-wise
    const prev = kpts(30, 51)
    const next = kpts(40, 52)
    expect(p0.kpts![0]).toEqual([
      (prev[0][0] + next[0][0]) / 2,
      (prev[0][1] + next[0][1]) / 2,
      1,
    ])
    // person 1 is gone (only in the a-sample, f=0.5 -> not kept; midpoint goes to b)
    expect(at.find((p) => p.id === 1)).toBeUndefined()
  })

  it('clamps outside the sample range', () => {
    const clip = makeClip()
    // before the first sample: the first sample as-is (person 1 is there)
    expect(samplesAt(clip, -1).map((p) => p.id)).toEqual([0, 1])
    const end = samplesAt(clip, 5)
    expect(end.map((p) => p.id)).toEqual([0])
  })
})

describe('thiefRiskCurve', () => {
  it('is the curve that spikes in a theft scene', () => {
    const hot = thiefRiskCurve(crime1)!
    expect(Math.max(...hot.map((k) => k.v))).toBeGreaterThanOrEqual(SUSPECT_THRESHOLD)
    expect(hot).toBe(crime1.people[1].risk)
  })

  it('is null for a clean scene', () => {
    expect(thiefRiskCurve(clean1)).toBeNull()
  })
})

describe('evalRealScene', () => {
  it('renders real boxes, applies the scripted thief risk to the thief track only', () => {
    const clip = makeClip()
    const at = evalRealScene(crime1, clip, 0.86)
    const thief = at.people.find((p) => p.trackId === 0)!
    const other = at.people.find((p) => p.trackId !== 0)

    // thief risk comes from the scripted curve (94 at t=0.86)
    expect(thief.risk).toBeCloseTo(94, 0)
    expect(thief.suspect).toBe(true)
    expect(thief.id).toBe('P1')
    expect(thief.kpts).toBeDefined()

    // non-thief uses the low curve
    if (other) {
      expect(other.risk).toBeLessThan(SUSPECT_THRESHOLD)
      expect(other.suspect).toBe(false)
    }
    expect(at.source).toBe('test-model')
  })

  it('marks a person standing at the cashier as staff, excluded from counts', () => {
    const clip = makeClip(1) // thief curve belongs to the cashier person
    const at = evalRealScene(crime1, clip, 0.3)
    const cashier = at.people.find((p) => p.trackId === 1)!
    expect(cashier.staff).toBe(true)
    expect(cashier.risk).toBeLessThan(SUSPECT_THRESHOLD) // staff never get the thief curve
    expect(cashier.suspect).toBe(false)
    expect(at.detected).toBe(1) // cashier excluded from "people in view"
    expect(at.suspects).toBe(0)
  })

  it('never flags anyone in a clean scene, whoever the thiefTrackId is', () => {
    const clip = makeClip(0)
    const at = evalRealScene(clean1, clip, 0.9)
    for (const p of at.people) {
      expect(p.suspect).toBe(false)
      expect(p.risk).toBeLessThan(SUSPECT_THRESHOLD)
    }
  })

  it('excludes staff from "detected" but not suspects', () => {
    const clip = makeClip()
    const at = evalRealScene(crime1, clip, 0.6)
    // person 0 (thief) + person 1 (cashier→staff) both in view; staff excluded
    expect(at.people).toHaveLength(2)
    expect(at.detected).toBe(1)
    expect(at.suspects).toBe(0)
  })
})

describe('POSE17_BONES', () => {
  it('only references joint indices 0..16', () => {
    for (const [a, b] of POSE17_BONES) {
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(17)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(17)
    }
  })
})
