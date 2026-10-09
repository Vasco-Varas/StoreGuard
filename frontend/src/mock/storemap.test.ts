import { describe, expect, it } from 'vitest'
import { pointInPolygon } from './markup'
import {
  DEFAULT_ZONES,
  MAP_H,
  MAP_W,
  THEFT_STORAGE_KEY,
  ZONE_STORAGE_KEY,
  clampToMap,
  demoThefts,
  mergeZones,
  rankHotspots,
  sanitizeTheftPoints,
  sanitizeZones,
  saveTheftPoints,
  saveUserZones,
  loadTheftPoints,
  loadUserZones,
  zoneCentroid,
  type MapZone,
  type TheftPoint,
} from './storemap'

const mk = (x: number, y: number, i = 0): TheftPoint => ({ id: `t${i}`, x, y })
const rectZone = (id: string, name: string, x0: number, y0: number, x1: number, y1: number, builtIn = true): MapZone => ({
  id,
  name,
  color: '#fff',
  builtIn,
  points: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
})

describe('default layout data', () => {
  const names = new Set()

  it('has a well-formed, non-overlapping set of built-in zones', () => {
    expect(DEFAULT_ZONES.length).toBeGreaterThanOrEqual(6)
    for (const z of DEFAULT_ZONES) {
      expect(z.id).not.toBe('')
      expect(names.has(z.name)).toBe(false)
      names.add(z.name)
      expect(z.builtIn).toBe(true)
      expect(z.points.length).toBeGreaterThanOrEqual(3)
      for (const p of z.points) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(MAP_W)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(MAP_H)
      }
    }
  })

  it('includes the theft zone (Main Shelves) and a checkout', () => {
    const shelves = DEFAULT_ZONES.find((z) => z.name === 'Main Shelves')
    expect(shelves).toBeTruthy()
    const checkout = DEFAULT_ZONES.find((z) => z.name === 'Checkout')
    expect(checkout).toBeTruthy()
  })

  it('has no zone fully contained inside another (zones stay rankable separately)', () => {
    for (const a of DEFAULT_ZONES) {
      for (const b of DEFAULT_ZONES) {
        if (a.id === b.id) continue
        const inside = a.points.length > 0 && a.points.every((p) => pointInPolygon(p, b.points))
        expect(inside, `${a.name} contained in ${b.name}`).toBe(false)
      }
    }
  })
})

describe('map geometry helpers', () => {
  it('clamps into the 0–MAP_W × 0–MAP_H map, non-finite → 0', () => {
    expect(clampToMap({ x: -5, y: 120 })).toEqual({ x: 0, y: MAP_H })
    expect(clampToMap({ x: NaN, y: 3 })).toEqual({ x: 0, y: 3 })
    expect(clampToMap({ x: 25, y: 10 })).toEqual({ x: 25, y: 10 })
  })

  it('averages a centroid, and defaults to map centre when empty', () => {
    expect(zoneCentroid([{ x: 10, y: 20 }, { x: 30, y: 40 }])).toEqual({ x: 20, y: 30 })
    expect(zoneCentroid([])).toEqual({ x: MAP_W / 2, y: MAP_H / 2 })
  })
})

describe('rankHotspots', () => {
  const zones: MapZone[] = [
    rectZone('a', 'Alpha Shelves', 0, 0, 40, 40),
    rectZone('b', 'Beta Shelf', 45, 0, 70, 40),
  ]

  it('counts and orders most-targeted first, marking unzoned markers', () => {
    const pts = [mk(10, 10, 1), mk(20, 30, 2), mk(50, 10, 3)]
    const h = rankHotspots(pts, zones)
    expect(h.rows[0]).toMatchObject({ id: 'a', name: 'Alpha Shelves', count: 2 })
    expect(h.rows[1]).toMatchObject({ id: 'b', count: 1 })
    expect(h.total).toBe(3)
    expect(h.zoneTotal).toBe(3)
    expect(h.unzoned).toBe(0)
  })

  it('counts markers outside every zone as unzoned, not hidden', () => {
    const h = rankHotspots([mk(90, 90, 1)], zones)
    expect(h.zoneTotal).toBe(0)
    expect(h.unzoned).toBe(1)
    expect(h.total).toBe(1)
  })

  it('breaks count ties alphabetically and tolerates empty input', () => {
    const h1 = rankHotspots([mk(10, 10, 1), mk(50, 10, 2)], zones)
    expect(h1.rows.map((r) => r.id)).toEqual(['a', 'b'])
    const h0 = rankHotspots([], zones)
    expect(h0.total).toBe(0)
    expect(h0.rows.every((r) => r.count === 0)).toBe(true)
  })
})

describe('mergeZones', () => {
  it('keeps defaults first, appends user zones as editable (not builtIn)', () => {
    const merged = mergeZones([rectZone('u1', 'Zone 1', 5, 5, 20, 20, false)])
    expect(merged.length).toBe(DEFAULT_ZONES.length + 1)
    expect(merged[0].id).toBe(DEFAULT_ZONES[0].id)
    expect(merged[merged.length - 1].id).toBe('u1')
    expect(merged[merged.length - 1].builtIn).toBeFalsy()
  })
})

describe('demoThefts', () => {
  it('drops 15–25 deterministic, in-map clusters', () => {
    const a = demoThefts()
    const b = demoThefts()
    expect(a.length).toBeGreaterThanOrEqual(15)
    expect(a.length).toBeLessThanOrEqual(25)
    for (const p of a) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(MAP_W)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(MAP_H)
    }
    // same seed → same spread; ids are freshly random per call
    expect(a.map((p) => [p.x, p.y])).toEqual(b.map((p) => [p.x, p.y]))
  })

  it('clusters most markers on Main Shelves, so a pitch shows a top targeted zone', () => {
    const h = rankHotspots(demoThefts(), mergeZones([]))
    expect(h.total).toBeGreaterThanOrEqual(15)
    expect(h.rows[0].name).toBe('Main Shelves')
    expect(h.rows[0].count).toBeGreaterThanOrEqual(10)
    expect(h.rows[0].count).toBeGreaterThan(h.rows[1].count)
  })
})

describe('sanitize', () => {
  it('keepWell-formed theft points, clamps, drops junk', () => {
    const out = sanitizeTheftPoints([
      { id: 'a', x: 10, y: 20 },
      { x: -5, y: 1000 },
      { id: 'b', x: 'nope', y: 5 },
      { id: 'c', x: NaN, y: 5 },
      42,
      null,
    ])
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ x: 0, y: MAP_H })
    expect(sanitizeTheftPoints('nope')).toEqual([])
  })

  it('keeps well-formed zones, repairs missing fields, clamps points', () => {
    const out = sanitizeZones([
      { id: 'z', name: 'Z', color: '#fff', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 200, y: 200 }] },
      { name: 'too small', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      'junk',
      null,
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('z')
    expect(out[0].points[3]).toEqual({ x: MAP_W, y: MAP_H })
  })
})

describe('localStorage round-trip', () => {
  interface FakeStorage {
    getItem(k: string): string | null
    setItem(k: string, v: string): void
    removeItem(k: string): void
    clear(): void
  }

  function fakeStorage(): FakeStorage {
    const map = new Map<string, string>()
    return {
      getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k, v) => {
        map.set(k, v)
      },
      removeItem: (k) => {
        map.delete(k)
      },
      clear: () => map.clear(),
    }
  }

  function withStorage(store: FakeStorage | null, fn: () => void) {
    const prev = (globalThis as Record<string, unknown>).localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      value: store as unknown as Storage,
      configurable: true,
    })
    try {
      fn()
    } finally {
      if (prev === undefined) delete (globalThis as Record<string, unknown>).localStorage
      else
        Object.defineProperty(globalThis, 'localStorage', {
          value: prev,
          configurable: true,
        })
    }
  }

  const shelf: MapZone = { id: 'c1', name: 'Corner', color: '#46c8f5', points: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }] }

  it('round-trips theft points and custom zones', () => {
    withStorage(fakeStorage(), () => {
      saveTheftPoints([mk(10, 20, 1), mk(50, 30, 2)])
      expect(loadTheftPoints()).toHaveLength(2)
      saveUserZones([shelf])
      expect(loadUserZones()).toHaveLength(1)
      expect(loadUserZones()[0].id).toBe('c1')
    })
  })

  it('returns [] for missing/corrupt values and a storage-free environment', () => {
    const broken = fakeStorage()
    broken.setItem(THEFT_STORAGE_KEY, '{not json')
    broken.setItem(ZONE_STORAGE_KEY, '["nope"]')
    withStorage(broken, () => {
      expect(loadTheftPoints()).toEqual([])
      expect(loadUserZones()).toEqual([])
    })
    withStorage(fakeStorage(), () => {
      expect(loadTheftPoints()).toEqual([])
      expect(loadUserZones()).toEqual([])
    })
    withStorage(undefined as unknown as FakeStorage, () => {
      expect(() => saveTheftPoints([mk(1, 1, 1)])).not.toThrow()
      expect(() => saveUserZones([shelf])).not.toThrow()
      expect(loadTheftPoints()).toEqual([])
      expect(loadUserZones()).toEqual([])
    })
  })
})
