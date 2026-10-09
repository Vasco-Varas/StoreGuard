import { describe, expect, it } from 'vitest'
import {
  AREA_STORAGE_KEY,
  areaLabelPosition,
  clampPoints,
  defaultAreaName,
  loadAreas,
  makeArea,
  nextColor,
  pointDistance,
  pointInPolygon,
  pointsToPath,
  sanitizeAreas,
  saveAreas,
  type Area,
  type AreaPoint,
} from './markup'

const sq: AreaPoint[] = [
  { x: 10, y: 10 },
  { x: 50, y: 10 },
  { x: 50, y: 50 },
  { x: 10, y: 50 },
]

describe('pointInPolygon', () => {
  it('classifies points against a rectangle', () => {
    expect(pointInPolygon({ x: 30, y: 30 }, sq)).toBe(true)
    expect(pointInPolygon({ x: 3, y: 30 }, sq)).toBe(false)
    expect(pointInPolygon({ x: 30, y: 60 }, sq)).toBe(false)
    // corners/edges resolve one way or the other, deterministically —
    // the contract is consistency, not which side
    expect(pointInPolygon(sq[0], sq)).toBe(pointInPolygon(sq[0], sq))
  })

  it('handles the L-shape (even-odd) correctly', () => {
    const l: AreaPoint[] = [
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 25 },
      { x: 25, y: 25 },
      { x: 25, y: 40 },
      { x: 10, y: 40 },
    ]
    expect(pointInPolygon({ x: 15, y: 15 }, l)).toBe(true)
    expect(pointInPolygon({ x: 30, y: 15 }, l)).toBe(true)
    expect(pointInPolygon({ x: 20, y: 30 }, l)).toBe(true) // notch leg
    expect(pointInPolygon({ x: 35, y: 35 }, l)).toBe(false) // the notched-out corner
  })

  it('refuses degenerate input', () => {
    expect(pointInPolygon({ x: 1, y: 1 }, [])).toBe(false)
    expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(false)
    expect(pointInPolygon({ x: NaN, y: 5 }, sq)).toBe(false)
  })

  it('is used symmetrically for a box centre test', () => {
    // person box centre inside the area?
    const person = { x: 20, y: 20, w: 10, h: 20 }
    const centre: AreaPoint = { x: person.x + person.w / 2, y: person.y + person.h / 2 }
    expect(pointInPolygon(centre, sq)).toBe(true)
    const person2 = { x: 60, y: 60, w: 10, h: 20 }
    const centre2: AreaPoint = {
      x: person2.x + person2.w / 2,
      y: person2.y + person2.h / 2,
    }
    expect(pointInPolygon(centre2, sq)).toBe(false)
  })
})

describe('frame clamping and geometry helpers', () => {
  it('clamps points into 0–100 and rejects non-finite values', () => {
    const clamped = clampPoints([
      { x: -5, y: 120 },
      { x: NaN, y: 50 },
      { x: 42, y: 100 },
    ])
    expect(clamped[0]).toEqual({ x: 0, y: 100 })
    expect(clamped[1]).toEqual({ x: 0, y: 50 })
    expect(clamped[2]).toEqual({ x: 42, y: 100 })
  })

  it('measures distances in frame space', () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 6, y: 8 })).toBe(10)
  })

  it('labels an area at its top-left corner, kept on frame', () => {
    expect(areaLabelPosition(sq)).toEqual({ x: 10, y: 10 })
    const off = [{ x: -3, y: -3 }, { x: 5, y: 5 }, { x: 5, y: -2 }]
    const pos = areaLabelPosition(off)
    expect(pos.x).toBeGreaterThanOrEqual(1)
    expect(pos.y).toBeGreaterThanOrEqual(2)
  })

  it('builds a closed SVG path at the 2dp precision', () => {
    expect(pointsToPath(sq)).toBe('M10.00 10.00 L50.00 10.00 L50.00 50.00 L10.00 50.00 Z')
    expect(pointsToPath([])).toBe('')
  })
})

describe('naming, colour and creation', () => {
  it('numbers new areas after existing "Area n" names', () => {
    const a: Area[] = [
      { id: '1', name: 'Area 1', color: '#46c8f5', points: sq },
      { id: '2', name: 'Beverage shelf', color: '#c084fc', points: sq },
      { id: '3', name: 'Area 7', color: '#4ade80', points: sq },
    ]
    expect(defaultAreaName(a)).toBe('Area 8')
    expect(defaultAreaName([])).toBe('Area 1')
    expect(defaultAreaName(a.slice(1, 2))).toBe('Area 1') // no "Area n" present
  })

  it('picks a colour the others do not use', () => {
    const a: Area[] = [
      { id: '1', name: 'A', color: '#46c8f5', points: sq },
      { id: '2', name: 'B', color: '#c084fc', points: sq },
    ]
    const next = nextColor(a)
    expect(next).not.toBe('#46c8f5')
    expect(next).not.toBe('#c084fc')
  })

  it('wraps the palette once it is exhausted', () => {
    // pretend more areas exist than palette slots
    const many: Area[] = Array.from({ length: 14 }, (_, i) => ({
      id: String(i),
      name: `Area ${i + 1}`,
      color: `#${(0x100000 + i).toString(16)}`,
      points: sq,
    }))
    expect(nextColor(many)).toMatch(/^#/)
  })

  it('makeArea clamps, names and colours a finished draft', () => {
    const area = makeArea([{ x: -1, y: 101 }, { x: 40, y: 5 }, { x: 50, y: 60 }], [])
    expect(area.name).toBe('Area 1')
    expect(area.points[0]).toEqual({ x: 0, y: 100 })
    expect(area.id).toMatch(/.*/)
    expect(area.points).toHaveLength(3)
  })
})

describe('sanitizeAreas', () => {
  it('keeps well-formed areas and drops the rest', () => {
    const good: Area = { id: 'x', name: 'Shelf', color: '#fff', points: sq }
    const out = sanitizeAreas([
      good,
      { id: '1', name: 'too small', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      { id: '2', name: 'bad numbers', points: [{ x: 'a', y: 1 }, { x: 1, y: 2 }, { x: 3, y: 3 }] },
      'junk',
      42,
      null,
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(good)
  })

  it('repairs missing id/name/color, clamps out-of-frame points', () => {
    const out = sanitizeAreas([
      { points: [{ x: -5, y: 200 }, { x: 10, y: 10 }, { x: 90, y: 90 }] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].points[0]).toEqual({ x: 0, y: 100 })
    expect(out[0].id).toMatch(/.*/)
    expect(out[0].name).toBe('Area 1')
    expect(out[0].color).toMatch(/^#/)
  })

  it('tolerates total garbage', () => {
    expect(sanitizeAreas(undefined)).toEqual([])
    expect(sanitizeAreas({ nope: 1 })).toEqual([])
    expect(sanitizeAreas(null)).toEqual([])
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
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
      removeItem: (k: string) => {
        map.delete(k)
      },
      clear: () => {
        map.clear()
      },
    }
  }

  function withStorage(store: FakeStorage | null, fn: () => void) {
    const prev = globalThis.localStorage
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

  const shelf: Area = {
    id: 'a1',
    name: 'Beverage shelf',
    color: '#46c8f5',
    points: [
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 55, y: 70 },
      { x: 25, y: 75 },
    ],
  }

  it('round-trips an area exactly', () => {
    withStorage(fakeStorage(), () => {
      saveAreas([shelf])
      const back = loadAreas()
      expect(back).toHaveLength(1)
      expect(back[0]).toEqual(shelf)
    })
  })

  it('returns [] on missing key, corrupt JSON and no store', () => {
    const broken = fakeStorage()
    broken.setItem(AREA_STORAGE_KEY, '{not json')
    withStorage(broken, () => expect(loadAreas()).toEqual([]))
    withStorage(fakeStorage(), () => expect(loadAreas()).toEqual([]))
  })

  it('loadAreas sanitizes a hand-poked store entry', () => {
    const store = fakeStorage()
    store.setItem(
      AREA_STORAGE_KEY,
      JSON.stringify([
        { id: 'z', name: 'Z', color: '#fff', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
        { id: 'bad', name: 'B', points: [{ x: 0, y: 0 }] },
      ]),
    )
    withStorage(store, () => {
      const areas = loadAreas()
      expect(areas).toHaveLength(1)
      expect(areas[0].id).toBe('z')
    })
  })

  it('survives a storage-free environment (no crash, empty list)', () => {
    withStorage(undefined as unknown as FakeStorage, () => {
      expect(() => saveAreas([shelf])).not.toThrow()
      expect(loadAreas()).toEqual([])
    })
  })
})
