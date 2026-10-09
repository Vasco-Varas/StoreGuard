// ---------------------------------------------------------------------------
// StoreGuard store map + theft heatmap (mock).
//
// The map is a hand-drawn TOP-DOWN vector plan of the store filmed in
// `vid_crime_1.mp4`. Coordinates live in the same 0–100 percentage-ish
// space as src/mock/markup.ts: x is 0 (left) → 100 (right) and y is
// 0 (back of the room) → MAP_H (front, where the camera sits). The map's
// aspect ratio is MAP_W × MAP_H so a top-down plan reads naturally.
//
// Everything is local: custom zones and theft markers persist in
// localStorage (no server). Heatmap "thefts" are manual in this mock; in
// production they would come from AI camera detection with a manual
// fallback.
// ---------------------------------------------------------------------------

import { AREA_COLORS, pointInPolygon, type AreaPoint } from './markup'

export const MAP_W = 100
export const MAP_H = 60

export interface MapZone {
  id: string
  name: string
  color: string
  /** Closed polygon, 3+ points, map percentages (0–MAP_W × 0–MAP_H). */
  points: AreaPoint[]
  /** Part of the shipped default layout (not deletable by the user). */
  builtIn?: boolean
}

export interface TheftPoint {
  id: string
  x: number
  y: number
}

export const THEFT_STORAGE_KEY = 'sg-theft-points-v1'
export const ZONE_STORAGE_KEY = 'sg-storemap-zones-v1'

// ---------------------------------------------------------------------------
// Default store layout
//
// Mirrors the room in the reference frame, top-down:
//   · perim­eter walls around (2,2)–(98,58)
//   · a long merchandise shelf wall along the LEFT side — this is the zone
//     the theft demo clips linger on, so demo thefts cluster here
//   · a central display table with seating in front of it
//   · a checkout counter on the right, a service counter on the back-right,
//     and a promo display stand centre-right
//   · a glass entrance in the back wall (drawn by the component; here it is
//     a small targetable strip just inside the doorway)
//
// Edit the shapes below to change the shipped layout — everything (labels,
// hotspot ranking, the camera overlay) reads from this data.
// ---------------------------------------------------------------------------

function rect(x0: number, y0: number, x1: number, y1: number): AreaPoint[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

export const DEFAULT_ZONES: MapZone[] = [
  {
    id: 'zone-main-shelves',
    name: 'Main Shelves',
    color: AREA_COLORS[0], // #46c8f5
    builtIn: true,
    // Long shelf wall, left side — the theft clip's shelf.
    points: rect(5, 7, 15, 51),
  },
  {
    id: 'zone-display-table',
    name: 'Display Table',
    color: AREA_COLORS[1], // #c084fc
    builtIn: true,
    points: rect(38, 26, 62, 40),
  },
  {
    id: 'zone-seating',
    name: 'Seating Area',
    color: AREA_COLORS[2], // #4ade80
    builtIn: true,
    points: rect(39, 42, 59, 53),
  },
  {
    id: 'zone-checkout',
    name: 'Checkout',
    color: AREA_COLORS[4], // #fbbf24
    builtIn: true,
    points: rect(80, 34, 95, 55),
  },
  {
    id: 'zone-service',
    name: 'Service Counter',
    color: AREA_COLORS[6], // #60a5fa
    builtIn: true,
    points: rect(66, 4, 85, 12),
  },
  {
    id: 'zone-promo',
    name: 'Promo Displays',
    color: AREA_COLORS[3], // #f472b6
    builtIn: true,
    points: rect(66, 20, 79, 33),
  },
  {
    id: 'zone-entrance',
    name: 'Entrance',
    color: AREA_COLORS[5], // #34d399
    builtIn: true,
    // Just inside the back-wall doorway.
    points: rect(11, 4, 25, 12),
  },
  {
    id: 'zone-fridge',
    name: 'Fridges',
    color: AREA_COLORS[7], // #fb923c
    builtIn: true,
    // Cold-counter row, bottom-left corner.
    points: rect(6, 53, 20, 57),
  },
]

/** Where the camera sits in map space (a top-down marker for the overlay). */
export const CAMERA_POSITION: AreaPoint = { x: 94, y: 55 }
/** The back-wall doorway gap, drawn by the component. */
export const ENTRANCE_GAP = { x0: 11, x1: 25, y: 2, sweep: 30 }

// ---------------------------------------------------------------------------
// Geometry helpers (map-percent space)
// ---------------------------------------------------------------------------

export function clampNum(v: number, max: number): number {
  return !Number.isFinite(v) ? 0 : Math.max(0, Math.min(max, v))
}

/** Clamp a point into the 0–MAP_W × 0–MAP_H map. */
export function clampToMap(p: AreaPoint): AreaPoint {
  return { x: clampNum(p.x, MAP_W), y: clampNum(p.y, MAP_H) }
}

export function clampMapPoints(points: AreaPoint[]): AreaPoint[] {
  return points.map(clampToMap)
}

export function zoneCentroid(points: AreaPoint[]): AreaPoint {
  if (points.length === 0) return { x: MAP_W / 2, y: MAP_H / 2 }
  let x = 0
  let y = 0
  for (const p of points) {
    x += p.x
    y += p.y
  }
  return { x: x / points.length, y: y / points.length }
}

/**
 * Rank the map's zones by how many theft markers fall inside them, most
 * targeted first (ties broken by name). Markers outside every zone are
 * counted separately as "unzoned".
 */
export interface HotspotRow {
  id: string
  name: string
  color: string
  builtIn: boolean
  count: number
}

export interface Hotspots {
  /** All zones, sorted by count desc. */
  rows: HotspotRow[]
  /** Total markers inside some zone. */
  zoneTotal: number
  /** Markers that fall outside every zone. */
  unzoned: number
  total: number
}

export function rankHotspots(points: TheftPoint[], zones: MapZone[]): Hotspots {
  const rows = zones
    .map((z) => ({
      id: z.id,
      name: z.name,
      color: z.color,
      builtIn: !!z.builtIn,
      count: points.reduce((n, p) => n + (pointInPolygon(p, z.points) ? 1 : 0), 0),
    }))
    .sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    )
  const zoneTotal = rows.reduce((n, r) => n + r.count, 0)
  return { rows, zoneTotal, unzoned: points.length - zoneTotal, total: points.length }
}

/** Merge the shipped default layout with the owner's custom zones. */
export function mergeZones(userZones: MapZone[]): MapZone[] {
  return [...DEFAULT_ZONES, ...userZones]
}

// ---------------------------------------------------------------------------
// Identity & demo thefts
// ---------------------------------------------------------------------------

export function newPointId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

export function newZoneId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `z-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

export function nextZoneColor(existing: MapZone[]): string {
  const used = new Set(existing.map((z) => z.color))
  return (
    AREA_COLORS.find((c) => !used.has(c)) ??
    AREA_COLORS[existing.length % AREA_COLORS.length]
  )
}

/** "Zone 1" style default, numbered after existing "Zone n". */
export function defaultZoneName(existing: MapZone[]): string {
  let max = 0
  for (const z of existing) {
    const m = /^Zone\s*(\d+)$/i.exec(z.name.trim())
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `Zone ${max + 1}`
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (so the demo spread is reproducible + testable)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeGauss(rand: () => number): () => number {
  return () => {
    // Box–Muller
    let u = 0
    let v = 0
    while (u === 0) u = rand()
    while (v === 0) v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/**
 * Build a plausible set of theft markers for the pitch: most cluster on the
 * "Main Shelves" (the zone the theft clips linger on), with a secondary
 * cluster at the Display Table and a few near the Entrance. Deterministic for
 * a given seed so the demo reads the same every load.
 */
export function demoThefts(seed = 20240101): TheftPoint[] {
  const rand = mulberry32(seed)
  const gauss = makeGauss(rand)
  const drop = (cx: number, cy: number, sx: number, sy: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const p = clampToMap({ x: cx + gauss() * sx, y: cy + gauss() * sy })
      return p
    }
    throw new Error('unreachable')
  }
  const spread: Array<[number, number, number, number, number]> = [
    // [cx, cy, sx, sy, count]
    [10, 29, 2.4, 11, 16], // Main Shelves — the theft zone, dominant cluster
    [50, 33, 9, 4.5, 4], // Display Table — secondary
    [18, 8, 5, 3, 3], // Entrance — grab-and-run scatter
  ]
  const out: TheftPoint[] = []
  for (const [cx, cy, sx, sy, n] of spread) {
    for (let i = 0; i < n; i++) out.push({ id: newPointId(), ...drop(cx, cy, sx, sy, n) })
  }
  return out
}

// ---------------------------------------------------------------------------
// sanitize + localStorage persistence
// ---------------------------------------------------------------------------

function localStorage(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? (globalThis.localStorage as Storage)
      : null
  } catch {
    return null
  }
}

/** Keep only well-formed theft points: finite x/y clamped into the map. */
export function sanitizeTheftPoints(raw: unknown): TheftPoint[] {
  if (!Array.isArray(raw)) return []
  const out: TheftPoint[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.x !== 'number' || typeof o.y !== 'number') continue
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) continue
    out.push({ ...clampToMap({ x: o.x, y: o.y }), id: typeof o.id === 'string' && o.id !== '' ? o.id : newPointId() })
  }
  return out
}

/** Keep only well-formed custom zones: 3+ finite points in-map + a name. */
export function sanitizeZones(raw: unknown): MapZone[] {
  if (!Array.isArray(raw)) return []
  const out: MapZone[] = []
  let n = 0
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (!Array.isArray(o.points)) continue
    const pts = (o.points as unknown[])
      .map((p): AreaPoint | null => {
        if (typeof p !== 'object' || p === null) return null
        const q = p as Record<string, unknown>
        if (typeof q.x !== 'number' || typeof q.y !== 'number') return null
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null
        return clampToMap({ x: q.x, y: q.y })
      })
      .filter((p): p is AreaPoint => p !== null)
    if (pts.length < 3) continue
    n += 1
    out.push({
      id: typeof o.id === 'string' && o.id !== '' ? o.id : newZoneId(),
      name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name : `Zone ${n}`,
      color: typeof o.color === 'string' && o.color !== '' ? o.color : `#${((0x100000 + (n - 1)) & 0xffffff).toString(16)}`.padStart(7, '0'),
      points: pts,
    })
  }
  return out
}

export function loadTheftPoints(): TheftPoint[] {
  const s = localStorage()
  if (!s) return []
  try {
    const raw = s.getItem(THEFT_STORAGE_KEY)
    return raw === null ? [] : sanitizeTheftPoints(JSON.parse(raw))
  } catch {
    return []
  }
}

export function saveTheftPoints(points: TheftPoint[]): void {
  const s = localStorage()
  if (!s) return
  try {
    s.setItem(THEFT_STORAGE_KEY, JSON.stringify(points))
  } catch {
    // storage unavailable — markers just won't persist
  }
}

export function loadUserZones(): MapZone[] {
  const s = localStorage()
  if (!s) return []
  try {
    const raw = s.getItem(ZONE_STORAGE_KEY)
    return raw === null ? [] : sanitizeZones(JSON.parse(raw))
  } catch {
    return []
  }
}

export function saveUserZones(zones: MapZone[]): void {
  const s = localStorage()
  if (!s) return
  try {
    s.setItem(ZONE_STORAGE_KEY, JSON.stringify(zones))
  } catch {
    // storage unavailable — custom zones just won't persist
  }
}
