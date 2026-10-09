import { describe, expect, it } from 'vitest'
import {
  SCENES,
  SUSPECT_THRESHOLD,
  evaluateScene,
  interpolate,
  poseJoints,
} from './detections'

const theft = SCENES.find((s) => s.id === 'crime-1')!
const clean = SCENES.find((s) => s.id === 'clean-1')!

describe('interpolate', () => {
  const frames = [
    { t: 0, v: 10 },
    { t: 1, v: 30 },
  ]

  it('clamps at the keyframe ends', () => {
    expect(interpolate(frames, -0.5)).toBe(10)
    expect(interpolate(frames, 1.5)).toBe(30)
  })

  it('returns a value between the bracketing keyframes', () => {
    const mid = interpolate(frames, 0.5)
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(30)
  })

  it('handles empty and zero-span keyframes', () => {
    expect(interpolate([], 0.5)).toBe(0)
    expect(interpolate([{ t: 0.2, v: 7 }], 1)).toBe(7)
  })
})

describe('evaluateScene', () => {
  it('reports the scripted people, with the cashier excluded', () => {
    const state = evaluateScene(theft, 0.3)
    expect(state.people.map((p) => p.id)).toEqual(['P1', 'P2'])
    expect(state.detected).toBe(2)
    expect(state.suspects).toBe(0)
  })

  it('keeps every risk low on the clean clip', () => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      const state = evaluateScene(clean, t)
      for (const p of state.people) {
        expect(p.risk, `clean person ${p.id} at t=${t}`).toBeLessThan(SUSPECT_THRESHOLD)
      }
      expect(state.suspects).toBe(0)
    }
  })

  it('flags exactly one suspect late in the theft clip, none early', () => {
    const early = evaluateScene(theft, 0.2)
    expect(early.suspects).toBe(0)
    expect(early.people.every((p) => p.risk < SUSPECT_THRESHOLD)).toBe(true)

    const late = evaluateScene(theft, 0.88)
    const suspected = late.people.filter((p) => p.suspect)
    expect(suspected).toHaveLength(1)
    expect(suspected[0].id).toBe('P2')
    expect(late.suspects).toBe(1)
  })

  it('wraps time around instead of erroring', () => {
    const wrapped = evaluateScene(theft, 1.4)
    const same = evaluateScene(theft, 0.4)
    expect(wrapped.people).toEqual(same.people)
  })
})

describe('poseJoints', () => {
  it('returns 10+ joints inside the box, moving with the phase', () => {
    const a = poseJoints(0)
    const b = poseJoints(Math.PI)
    expect(a.length).toBeGreaterThanOrEqual(10)
    for (const [x, y] of a) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
    expect(a).not.toEqual(b)
  })
})
