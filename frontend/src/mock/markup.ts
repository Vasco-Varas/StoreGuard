// ---------------------------------------------------------------------------
// StoreGuard markup: owner-drawn areas (polygons marked over the frame).
//
// Coordinates are percentages of the video frame (0–100), the same
// convention as src/mock/detections.ts, so an area keeps its position at
// any video size. Areas persist in localStorage — there is no server
// behind this; it is the owner's own markup for the mock demo.
// ---------------------------------------------------------------------------

export interface AreaPoint {
  x: number
  y: number
}

export interface Area {
  id: string
  name: string
  color: string
  /** Closed polygon, 3+ points, frame percentages 0–100. */
  points: AreaPoint[]
}

export const AREA_STORAGE_KEY = 'sg-markup-areas-v1'

/** Distinct, theme-appropriate palette; nextColor skips the used ones. */
export const AREA_COLORS: string[] = [
  '#46c8f5',
  '#c084fc',
  '#4ade80',
  '#f472b6',
  '#fbbf24',
  '#34d399',
  '#60a5fa',
  '#fb923c',
  '#e879f9',
  '#a3e635',
  '#f87171',
  '#38bdf8',
]

// ---------------------------------------------------------------------------
// Geometry helpers (all in frame-percent space)
// ---------------------------------------------------------------------------

function clampNum(v: number): number {
  return !Number.isFinite(v) ? 0 : Math.max(0, Math.min(100, v))
}

/** Clamp a point into the 0–100 frame (non-finite values become 0). */
export function clampToFrame(p: AreaPoint): AreaPoint {
  return { x: clampNum(p.x), y: clampNum(p.y) }
}

export function clampPoints(points: AreaPoint[]): AreaPoint[] {
  return points.map(clampToFrame)
}

export function pointDistance(a: AreaPoint, b: AreaPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Even-odd ray cast. Fewer than 3 points (or a non-finite point) → false. */
export function pointInPolygon(pt: AreaPoint, points: AreaPoint[]): boolean {
  if (points.length < 3) return false
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    const crosses = a.y > pt.y !== b.y > pt.y
    if (crosses) {
      const x = ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
      if (pt.x < x) inside = !inside
    }
  }
  return inside
}

/** Where to pin an area's name label: top-left of its bounding box. */
export function areaLabelPosition(points: AreaPoint[]): AreaPoint {
  let minX = 100
  let minY = 100
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
  }
  return { x: Math.max(1, minX), y: Math.max(2, minY) }
}

/** SVG path for a closed polygon in the 0–100 viewBox. */
export function pointsToPath(points: AreaPoint[]): string {
  if (points.length === 0) return ''
  return (
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(' ') + ' Z'
  )
}

// ---------------------------------------------------------------------------
// Identity, naming, colour
// ---------------------------------------------------------------------------

export function newAreaId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `a-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** "Area 1" style default: one higher than the highest existing "Area n". */
export function defaultAreaName(existing: Area[]): string {
  let max = 0
  for (const a of existing) {
    const m = /^Area\s*(\d+)$/i.exec(a.name.trim())
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `Area ${max + 1}`
}

/** First palette colour not already used; wraps around when all are. */
export function nextColor(existing: Area[]): string {
  const used = new Set(existing.map((a) => a.color))
  return (
    AREA_COLORS.find((c) => !used.has(c)) ??
    AREA_COLORS[existing.length % AREA_COLORS.length]
  )
}

/** Build a finished area from raw draft points. */
export function makeArea(rawPoints: AreaPoint[], existing: Area[]): Area {
  return {
    id: newAreaId(),
    name: defaultAreaName(existing),
    color: nextColor(existing),
    points: clampPoints(rawPoints),
  }
}

// ---------------------------------------------------------------------------
// localStorage persistence
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

/** Keep only well-formed areas: string id/name, 3+ finite points in-frame. */
export function sanitizeAreas(raw: unknown): Area[] {
  if (!Array.isArray(raw)) return []
  const areas: Area[] = []
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
        return clampToFrame({ x: q.x, y: q.y })
      })
      .filter((p): p is AreaPoint => p !== null)
    if (pts.length < 3) continue
    n += 1
    areas.push({
      id: typeof o.id === 'string' && o.id !== '' ? o.id : newAreaId(),
      name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name : `Area ${n}`,
      color: typeof o.color === 'string' && o.color !== '' ? o.color : AREA_COLORS[(n - 1) % AREA_COLORS.length],
      points: pts,
    })
  }
  return areas
}

export function loadAreas(): Area[] {
  const s = localStorage()
  if (!s) return []
  try {
    const raw = s.getItem(AREA_STORAGE_KEY)
    return raw === null ? [] : sanitizeAreas(JSON.parse(raw))
  } catch {
    return []
  }
}

export function saveAreas(areas: Area[]): void {
  const s = localStorage()
  if (!s) return
  try {
    s.setItem(AREA_STORAGE_KEY, JSON.stringify(areas))
  } catch {
    // storage unavailable (private mode etc.) — areas just won't persist
  }
}
