import { useEffect, useRef, useState } from 'react'
import {
  SCENES,
  SKELETON_BONES,
  SUSPECT_THRESHOLD,
  evaluateScene,
  poseJoints,
  type Scene,
  type SceneState,
} from './mock/detections'
import {
  evalRealScene,
  loadRealClip,
  POSE17_BONES,
  type RealClip,
} from './mock/realDetections'
import {
  areaLabelPosition,
  clampToFrame,
  loadAreas,
  makeArea,
  pointDistance,
  pointInPolygon,
  pointsToPath,
  saveAreas,
  type Area,
  type AreaPoint,
} from './mock/markup'
import StoreMapView from './StoreMapView'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How close a click must land to the first draft vertex to close the polygon (frame %). */
const CLOSE_RADIUS = 4
const MAX_DRAFT_VERTS = 24
const UNDO_LIMIT = 50

const riskColor = (risk: number) =>
  `hsl(${120 - Math.max(0, Math.min(100, risk)) * 1.2}, 85%, 52%)`

const clipTitle = (scene: Scene) =>
  scene.demo === 'theft' ? `Incident feed · cam ${scene.id.slice(-1)}` : 'Standard feed'

interface SkeletonPerson {
  x: number
  y: number
  w: number
  h: number
  phase: number
  suspect: boolean
  staff?: boolean
  /** Real 17 COCO pose joints ([x, y, vis] in box units) when present. */
  kpts?: Array<[number, number, number]>
}

/** One full-frame SVG in 0–100 percent coordinates (matches the video area).
 *  Renders the real 17-joint YOLO pose when available, otherwise the
 *  gait-animated mock joints. */
function SkeletonLayer({ people }: { people: SkeletonPerson[] }) {
  return (
    <svg
      className="skeleton-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {people.map((p, i) => {
        const real = p.kpts
        const bones: Array<[number, number]> = real ? POSE17_BONES : SKELETON_BONES
        const joints: Array<[number, number]> = (real ?? poseJoints(p.phase)).map(
          ([ix, iy]) => [p.x + ix * p.w, p.y + iy * p.h] as [number, number],
        )
        const vis = (j: number) => (real ? real[j][2] > 0.3 : true)
        const color = p.staff ? '#8fa9c4' : p.suspect ? '#ff5c5c' : '#59d8ff'
        return (
          <g key={i} stroke={color} fill={color} opacity={0.75}>
            {bones.map(([a, b]) =>
              !vis(a) || !vis(b) ? null : (
                <line
                  key={`${a}-${b}`}
                  x1={joints[a][0]}
                  y1={joints[a][1]}
                  x2={joints[b][0]}
                  y2={joints[b][1]}
                  vectorEffect="non-scaling-stroke"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                />
              ),
            )}
            {joints.map(([jx, jy], j) => (vis(j) ? <circle key={j} cx={jx} cy={jy} r={0.45} /> : null))}
          </g>
        )
      })}
    </svg>
  )
}

/** Subtle filled outlines of the saved areas over the live frame. */
function AreasLayer({ areas, dim }: { areas: Area[]; dim?: boolean }) {
  return (
    <svg
      className="skeleton-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {areas.map((a) => (
        <path
          key={a.id}
          d={pointsToPath(a.points)}
          fill={a.color}
          fillOpacity={dim ? 0.14 : 0.07}
          stroke={a.color}
          strokeOpacity={dim ? 0.9 : 0.55}
          strokeWidth={dim ? 2 : 1.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

/** Area name labels pinned to each area's top-left corner (live view only). */
function AreaLabels({ areas }: { areas: Area[] }) {
  return (
    <>
      {areas.map((a) => {
        const pos = areaLabelPosition(a.points)
        return (
          <div
            key={a.id}
            className="sg-alabel"
            style={{ left: `${pos.x}%`, top: `${pos.y}%`, borderColor: a.color }}
          >
            <span className="sg-alabel-swatch" style={{ background: a.color }} />
            {a.name}
          </div>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [view, setView] = useState<'camera' | 'map'>('camera')
  const [clipIndex, setClipIndex] = useState(0)
  const [now, setNow] = useState(0) // wall-clock seconds, drives the skeleton
  const [state, setState] = useState<SceneState>(() => evaluateScene(SCENES[0], 0))
  const scene = SCENES[clipIndex]
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const latestRef = useRef<SceneState>(state)
  latestRef.current = state
  // Real YOLO detections for the current clip (tools/generate_detections.py);
  // null while loading or when the clip has no generated JSON -> scripted mock.
  const realRef = useRef<RealClip | null>(null)
  const currentSceneRef = useRef(scene)
  currentSceneRef.current = scene

  // ── markup state ────────────────────────────────────────────────
  const [markupMode, setMarkupMode] = useState(false)
  const [areas, setAreas] = useState<Area[]>(() => loadAreas())
  const [draft, setDraft] = useState<AreaPoint[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hover, setHover] = useState<AreaPoint | null>(null)
  const [drag, setDrag] = useState<{ areaId: string; index: number } | null>(null)
  const [undoStack, setUndoStack] = useState<Area[][]>([])
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Clip timeline: driven by the video's own clock once it can play, wall
  // clock in the meantime (so the overlays animate from the first frame).
  useEffect(() => {
    // Fall back to the scripted mock until the generated detections (if any)
    // are loaded; a stale response from a previous clip never applies.
    realRef.current = null
    void loadRealClip(scene.video).then((clip) => {
      if (currentSceneRef.current.id === scene.id) realRef.current = clip
    })

    let raf = 0
    // Wall-clock fallback until metadata loads: (now - start) % 25 / 25 is a
    // continuous function of the wall clock, so a StrictMode remount or a
    // clip switch lands on the same phase instead of jumping to t=0.
    const start = performance.now() / 1000 - Math.floor(performance.now() / 1000 / 25) * 25
    const tick = () => {
      const nowW = performance.now() / 1000
      const video = videoRef.current
      let t = 0
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        t = video.currentTime / video.duration
      } else {
        t = ((nowW - start) % 25) / 25
      }
      const st = realRef.current
        ? evalRealScene(scene, realRef.current, t)
        : evaluateScene(scene, t)
      setState(st)
      setNow(nowW)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__sgDebug = {
        clipId: () => scene.id,
        state: () => latestRef.current,
      }
    }
    return () => cancelAnimationFrame(raf)
  }, [scene])

  // Markup persists locally; survives reloads, no server involved.
  useEffect(() => {
    saveAreas(areas)
  }, [areas])

  // Markup mode freezes the still frame; the live view keeps autoplay. Clip
  // switches re-mount the video, so the mode must be re-applied on re-mount.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (markupMode) v.pause()
    else void v.play().catch(() => {})
  }, [markupMode, clipIndex])

  // Keyboard shortcuts while marking up (ignored while typing a name).
  useEffect(() => {
    if (!markupMode) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        setDraft([])
        setSelectedId(null)
      } else if (e.key === 'Enter' && draft.length >= 3) {
        completeDraft()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        deleteArea(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [markupMode, draft, selectedId, areas])

  // ── markup actions ──────────────────────────────────────────────

  const toPct = (e: { clientX: number; clientY: number }): AreaPoint => {
    const el = svgRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return clampToFrame({
      x: ((e.clientX - r.left) / r.width) * 100,
      y: ((e.clientY - r.top) / r.height) * 100,
    })
  }

  const pushUndo = (prev: Area[]) =>
    setUndoStack((s) => [...s.slice(UNDO_LIMIT - 1), prev])

  const completeDraft = () => {
    if (draft.length < 3) return
    pushUndo(areas)
    setAreas((prev) => [...prev, makeArea(draft, prev)])
    setDraft([])
  }

  const deleteArea = (id: string) => {
    pushUndo(areas)
    setAreas((prev) => prev.filter((a) => a.id !== id))
    setSelectedId(null)
  }

  const clearAll = () => {
    if (areas.length === 0) return
    pushUndo(areas)
    setAreas([])
    setSelectedId(null)
    setDraft([])
  }

  const undoStep = () => {
    if (draft.length > 0) {
      setDraft((d) => d.slice(0, -1))
    } else if (undoStack.length > 0) {
      const prev = undoStack[undoStack.length - 1]
      setUndoStack((s) => s.slice(0, -1))
      setAreas(prev)
      setSelectedId(null)
    }
  }

  const renameArea = (id: string, name: string) =>
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, name } : a)))

  const beginDrag = (areaId: string, index: number, e: React.PointerEvent) => {
    e.stopPropagation()
    pushUndo(areas)
    setDrag({ areaId, index })
    setSelectedId(areaId)
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // capture unsupported — dragging still works without it
    }
  }

  const onSvgPointerDown = (e: React.PointerEvent) => {
    if (drag) return
    const pt = toPct(e)
    // closing on the first vertex ends the polygon
    if (draft.length >= 3 && pointDistance(pt, draft[0]) <= CLOSE_RADIUS) {
      completeDraft()
      return
    }
    if (draft.length >= MAX_DRAFT_VERTS) return
    setSelectedId(null)
    setDraft((d) => [...d, pt])
  }

  const onSvgPointerMove = (e: React.PointerEvent) => {
    const pt = toPct(e)
    setHover(pt)
    if (drag) {
      const d = drag
      setAreas((prev) =>
        prev.map((a) =>
          a.id !== d.areaId
            ? a
            : { ...a, points: a.points.map((p, i) => (i === d.index ? pt : p)) },
        ),
      )
    }
  }

  const onSvgPointerUp = () => {
    setDrag(null)
    try {
      svgRef.current?.releasePointerCapture(0)
    } catch {
      // nothing captured
    }
  }

  // Where is each scripted person right now, for the "in <area>" label.
  const personArea = (p: { x: number; y: number; w: number; h: number }): Area | undefined =>
    areas.find((a) =>
      pointInPolygon({ x: p.x + p.w / 2, y: p.y + p.h / 2 }, a.points),
    )

  const skeletonPeople: SkeletonPerson[] = state.people.map((p) => ({
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    phase: now * Math.PI * 2 * p.gait * 0.7,
    suspect: p.suspect,
    staff: p.staff,
    kpts: p.kpts,
  }))

  const lastDraft = draft.length > 0 ? draft[draft.length - 1] : null
  const editing = draft.length > 0

  return (
    <div className="sg-app">
      <style>{`
        * { box-sizing: border-box; }
        html, body, #root { height: 100%; margin: 0; }
        .sg-app {
          height: 100vh; display: flex; flex-direction: column; overflow: hidden;
          background: #0a0e14; color: #c8d6e5;
          font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
        }

        /* ── top bar ─────────────────────────────────────────────── */
        .sg-topbar {
          display: flex; align-items: center; gap: 10px;
          padding: 10px 16px; background: #0e141d; border-bottom: 1px solid #1d2736;
        }
        .sg-logo { font-size: 13px; font-weight: 700; letter-spacing: 2px; color: #e8f0fe; }
        .sg-logo span { color: #46c8f5; }
        .sg-tabs { display: flex; gap: 4px; margin-left: 8px; }
        .sg-tabs button {
          font: inherit; font-size: 11px; font-weight: 700; letter-spacing: 1px;
          cursor: pointer; color: #7c90a8; background: #111927;
          border: 1px solid #22304a; border-radius: 4px; padding: 5px 12px;
        }
        .sg-tabs button:hover { background: #17233a; }
        .sg-tabs button.active { color: #46c8f5; border-color: #46c8f5; background: #0f2233; }
        .sg-badge {
          font-size: 10px; font-weight: 600; letter-spacing: 0.5px;
          padding: 3px 8px; border-radius: 3px;
        }
        .sg-badge-cam { color: #9db3c8; background: #131b28; border: 1px solid #22304a; }
        .sg-badge-theft { color: #ff7b7b; background: #2a1215; border: 1px solid #5a2326; }
        .sg-badge-clean { color: #4ade80; background: #0f2417; border: 1px solid #1f4630; }
        .sg-badge-markup { color: #fbbf24; background: #241c0d; border: 1px solid #4d3d1a; }
        .sg-note { margin-left: auto; font-size: 10px; letter-spacing: 0.5px; color: #4d5f75; }

        /* ── layout ──────────────────────────────────────────────── */
        .sg-main { flex: 1; display: flex; min-height: 0; }
        .sg-cam { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }

        .sg-camhead { display: flex; align-items: center; gap: 10px; font-size: 12px; }
        .sg-live {
          display: flex; align-items: center; gap: 6px; font-weight: 700;
          letter-spacing: 1.5px; color: #ff5c5c;
        }
        .sg-live.paused { color: #fbbf24; }
        .sg-livewrap .dot {
          width: 8px; height: 8px; border-radius: 50%; background: #ff4d4d;
          animation: sg-pulse 1.3s ease-in-out infinite;
        }
        .sg-live.paused .dot { background: #fbbf24; animation: none; }
        @keyframes sg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        .sg-camhead .cam { color: #d7e3f2; font-weight: 600; letter-spacing: 0.5px; }
        .sg-camhead .ts { color: #4d5f75; font-size: 11px; margin-left: 4px; }
        .sg-camhead .right { margin-left: auto; color: #4d5f75; font-size: 10px; letter-spacing: 0.5px; }

        /* ── video stage ─────────────────────────────────────────── */
        .sg-stage {
          position: relative; flex: 1; min-height: 0; background: #000;
          border: 1px solid #1d2736; border-radius: 6px; overflow: hidden;
        }
        .sg-stage video {
          position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: cover; background: #05070b;
        }
        .sg-vignette {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%);
        }
        .sg-markup-dim { position: absolute; inset: 0; background: rgba(0,0,0,0.25); }
        .sg-overlay { position: absolute; inset: 0; pointer-events: none; }
        .skeleton-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
        .sg-editsvg {
          position: absolute; inset: 0; width: 100%; height: 100%;
          cursor: crosshair; touch-action: none;
        }

        .sg-pbox { position: absolute; border: 1.5px solid #59d8ff; border-radius: 2px; }
        .sg-pbox.suspect { border-color: #ff5c5c; box-shadow: 0 0 10px rgba(255, 70, 70, 0.55); }
        .sg-pbox.staff { border-color: #8fa9c4; }
        .sg-plabel {
          position: absolute; top: -19px; left: 0; white-space: nowrap;
          font-size: 10px; letter-spacing: 0.5px; color: #fff;
          background: rgba(6, 10, 16, 0.85); padding: 2px 6px; border-radius: 2px;
        }
        .sg-plabel .conf { color: #8fc7e8; }
        .sg-plabel .area { color: #fbbf24; }
        .sg-suspflag {
          position: absolute; top: -38px; left: 0; white-space: nowrap;
          font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #fff;
          background: #e03131; padding: 2px 6px; border-radius: 2px;
          animation: sg-pulse 0.9s ease-in-out infinite;
        }
        .sg-riskbar {
          position: absolute; left: 0; right: 0; bottom: -1px; height: 4px;
          background: rgba(255, 255, 255, 0.18);
        }
        .sg-riskbar > div { height: 100%; width: 0%; }

        .sg-cashier {
          position: absolute; border: 1px dashed #6b93b8; border-radius: 2px;
          background: rgba(107, 147, 184, 0.08);
        }
        .sg-cashier .sg-plabel { color: #9db3c8; }

        .sg-alabel {
          position: absolute; transform: translate(4px, 4px); white-space: nowrap;
          display: flex; align-items: center; gap: 5px;
          font-size: 10px; letter-spacing: 0.5px; color: #d7e3f2;
          background: rgba(6, 10, 16, 0.8); padding: 2px 6px;
          border: 1px solid; border-radius: 2px;
        }
        .sg-alabel-swatch { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }

        /* ── controls ────────────────────────────────────────────── */
        .sg-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .sg-controls .lbl { font-size: 10px; letter-spacing: 1px; color: #4d5f75; }
        .sg-controls .sep { width: 1px; height: 18px; background: #1d2736; margin: 0 4px; }
        .sg-controls button {
          font: inherit; font-size: 11px; letter-spacing: 0.3px; cursor: pointer;
          color: #9db3c8; background: #111927; border: 1px solid #22304a;
          border-radius: 4px; padding: 5px 11px;
        }
        .sg-controls button:hover { background: #17233a; }
        .sg-controls button.active { color: #46c8f5; border-color: #46c8f5; background: #0f2233; }
        .sg-controls button.active-markup { color: #fbbf24; border-color: #fbbf24; background: #241c0d; }
        .sg-controls button:disabled { opacity: 0.35; cursor: default; background: #0e1520; }
        .sg-editorhint { font-size: 10px; letter-spacing: 0.3px; color: #3c4c61; }

        /* ── side panel ──────────────────────────────────────────── */
        .sg-side {
          width: 272px; flex-shrink: 0; background: #0d131c;
          border-left: 1px solid #1d2736; padding: 14px; overflow-y: auto;
        }
        .sg-side h3 {
          margin: 0 0 8px; font-size: 10px; font-weight: 700;
          letter-spacing: 1.5px; text-transform: uppercase; color: #4d5f75;
        }
        .sg-sec-head { display: flex; align-items: baseline; justify-content: space-between; }
        .sg-sec-head h3 { margin: 0 0 8px; }
        .sg-clearall {
          font: inherit; font-size: 10px; letter-spacing: 0.5px; cursor: pointer;
          color: #7c90a8; background: none; border: 1px solid #22304a;
          border-radius: 3px; padding: 2px 7px; margin-bottom: 8px;
        }
        .sg-clearall:hover { color: #ff7b7b; border-color: #5a2326; }
        .sg-clearall:disabled { opacity: 0.35; cursor: default; }
        .sg-sec { margin-bottom: 18px; }
        .sg-row {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 11px; padding: 5px 0; border-bottom: 1px solid #151e2b;
        }
        .sg-row .k { color: #7c90a8; }
        .sg-row .v { font-weight: 600; color: #d7e3f2; }
        .sg-v-ok { color: #4ade80; }
        .sg-v-warn { color: #fbbf24; }
        .sg-v-alert { color: #ff5c5c; animation: sg-pulse 0.9s ease-in-out infinite; }

        .sg-person { margin-bottom: 10px; }
        .sg-person .top { display: flex; justify-content: space-between; font-size: 11px; }
        .sg-person .id { font-weight: 700; color: #d7e3f2; }
        .sg-meter { height: 5px; border-radius: 3px; background: #182233; margin-top: 4px; overflow: hidden; }
        .sg-meter > div { height: 100%; border-radius: 3px; }
        .sg-progress { height: 5px; border-radius: 3px; background: #182233; overflow: hidden; }
        .sg-progress > div { height: 100%; background: #46c8f5; }
        .sg-t { font-size: 10px; color: #4d5f75; margin-top: 4px; }
        .sg-hint { font-size: 10px; line-height: 1.6; color: #3c4c61; margin: 0; }
        .sg-hint code { color: #6b8399; }

        /* ── areas list ──────────────────────────────────────────── */
        .sg-area {
          padding: 6px 8px; margin-bottom: 6px;
          background: #101826; border: 1px solid #1d2736; border-radius: 4px;
        }
        .sg-area.sel { border-color: #46c8f5; }
        .sg-area-row { display: flex; align-items: center; gap: 6px; }
        .sg-swatch { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
        .sg-area-name {
          flex: 1; min-width: 0; font: inherit; font-size: 11px; color: #d7e3f2;
          background: #0c1220; border: 1px solid transparent; border-radius: 3px; padding: 2px 5px;
        }
        .sg-area-name:focus { outline: none; border-color: #46c8f5; }
        .sg-area-pts { font-size: 9px; color: #4d5f75; }
        .sg-area-actions { display: flex; gap: 6px; margin-top: 5px; }
        .sg-area-actions button {
          font: inherit; font-size: 10px; letter-spacing: 0.3px; cursor: pointer;
          color: #7c90a8; background: #0c1220; border: 1px solid #22304a;
          border-radius: 3px; padding: 2px 8px;
        }
        .sg-area-actions button:hover { background: #17233a; }
        .sg-area-actions button.danger:hover { color: #ff7b7b; border-color: #5a2326; }
      `}</style>

      {/* top bar */}
      <div className="sg-topbar">
        <div className="sg-logo">
          STORE<span>GUARD</span>
        </div>
        <span className="sg-tabs">
          <button className={view === 'camera' ? 'active' : ''} onClick={() => setView('camera')}>
            CAMERA
          </button>
          <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
            STORE MAP
          </button>
        </span>
        <span className="sg-badge sg-badge-cam">{scene.label}</span>
        <span className={'sg-badge ' + (scene.demo === 'theft' ? 'sg-badge-theft' : 'sg-badge-clean')}>
          {scene.demo === 'theft' ? 'INCIDENT FEED' : 'STANDARD FEED'}
        </span>
        {markupMode && <span className="sg-badge sg-badge-markup">MARKUP MODE · PAUSED</span>}
        <div className="sg-note">StoreGuard · Loss Prevention Analytics</div>
      </div>

      <div className="sg-main">
        {view === 'map' ? (
          <StoreMapView />
        ) : (
        <>
        {/* camera view */}
        <div className="sg-cam">
          <div className="sg-camhead">
            <span className={'sg-live' + (markupMode ? ' paused' : '')}>
              <span className="sg-livewrap"><span className="dot" /></span>
              {markupMode ? 'STILL' : 'LIVE'}
            </span>
            <span className="cam">{scene.label}</span>
            <span className="ts">
              feed {clipIndex + 1}/{SCENES.length} · {(state.t * 100).toFixed(0)}%
              {state.source ? ` · ${state.source}` : ''}
            </span>
            <span className="right">POSR: A-12 · LOSS PREVENTION</span>
          </div>

          <div className="sg-stage">
            <video
              key={scene.id}
              ref={videoRef}
              src={scene.video}
              autoPlay
              loop
              muted
              playsInline
            />
            <div className="sg-vignette" />

            {markupMode ? (
              <>
                <div className="sg-markup-dim" />
                <svg
                  ref={svgRef}
                  className="sg-editsvg"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  xmlns="http://www.w3.org/2000/svg"
                  onPointerDown={onSvgPointerDown}
                  onPointerMove={onSvgPointerMove}
                  onPointerUp={onSvgPointerUp}
                  onPointerLeave={() => {
                    setDrag(null)
                    setHover(null)
                  }}
                  onDoubleClick={completeDraft}
                >
                  {areas.map((a) => {
                    const sel = a.id === selectedId
                    return (
                      <g key={a.id}>
                        <path
                          d={pointsToPath(a.points)}
                          fill={a.color}
                          fillOpacity={sel ? 0.16 : 0.09}
                          stroke={a.color}
                          strokeWidth={sel ? 2.2 : 1.5}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: 'pointer' }}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            setSelectedId(a.id)
                          }}
                        />
                        {sel &&
                          a.points.map((pt, i) => (
                            <circle
                              key={i}
                              cx={pt.x}
                              cy={pt.y}
                              r={1.3}
                              fill="#0a0e14"
                              stroke="#e8f0fe"
                              strokeWidth={1.4}
                              vectorEffect="non-scaling-stroke"
                              style={{ cursor: 'move' }}
                              onPointerDown={(e) => beginDrag(a.id, i, e)}
                            />
                          ))}
                      </g>
                    )
                  })}

                  {editing && (
                    <g>
                      <path
                        d={pointsToPath(draft)}
                        fill="#46c8f5"
                        fillOpacity={0.1}
                        stroke="#7dd3fc"
                        strokeWidth={1.6}
                        strokeDasharray="7 4"
                        vectorEffect="non-scaling-stroke"
                      />
                      {draft.map((p, i) => (
                        <circle
                          key={i}
                          cx={p.x}
                          cy={p.y}
                          r={i === 0 ? 2.4 : 1}
                          fill={i === 0 ? 'rgba(125,211,252,0.4)' : '#7dd3fc'}
                          stroke={i === 0 ? '#e8f0fe' : 'none'}
                          strokeWidth={1.2}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {hover && (
                        <line
                          x1={lastDraft!.x}
                          y1={lastDraft!.y}
                          x2={hover.x}
                          y2={hover.y}
                          stroke="#7dd3fc"
                          strokeWidth={1}
                          strokeDasharray="3 3"
                          vectorEffect="non-scaling-stroke"
                          opacity={0.8}
                        />
                      )}
                    </g>
                  )}
                </svg>
              </>
            ) : (
              <div className="sg-overlay">
                <SkeletonLayer people={skeletonPeople} />
                <AreasLayer areas={areas} />
                <AreaLabels areas={areas} />

                {state.people.map((p) => {
                  const inArea = personArea(p)
                  return (
                    <div
                      key={p.id}
                      className={'sg-pbox' + (p.suspect ? ' suspect' : '')}
                      style={{
                        left: `${p.x}%`,
                        top: `${p.y}%`,
                        width: `${p.w}%`,
                        height: `${p.h}%`,
                      }}
                    >
                      <div className="sg-plabel">
                        {p.id}
                        {p.staff ? <span className="conf"> · STAFF</span> : ''}{' '}
                        <span className="conf">· conf {p.conf.toFixed(2)}</span>
                        {inArea && (
                          <span className="area"> · in “{inArea.name}”</span>
                        )}
                      </div>
                      {p.suspect && <div className="sg-suspflag">SUSPECT</div>}
                      <div className="sg-riskbar">
                        <div
                          style={{
                            width: `${p.risk}%`,
                            background: riskColor(p.risk),
                          }}
                        />
                      </div>
                    </div>
                  )
                })}

                {scene.cashier && (
                  <div
                    className="sg-cashier"
                    style={{
                      left: `${scene.cashier.x}%`,
                      top: `${scene.cashier.y}%`,
                      width: `${scene.cashier.w}%`,
                      height: `${scene.cashier.h}%`,
                    }}
                  >
                    <div className="sg-plabel">CASHIER — excluded from risk</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sg-controls">
            <span className="lbl">CLIP</span>
            {SCENES.map((s, i) => (
              <button
                key={s.id}
                className={i === clipIndex ? 'active' : ''}
                onClick={() => setClipIndex(i)}
                disabled={markupMode}
              >
                {clipTitle(s)}
              </button>
            ))}
            <span className="sep" />
            <span className="lbl">MODE</span>
            <button
              className={markupMode ? 'active-markup' : ''}
              onClick={() => setMarkupMode((m) => !m)}
            >
              {markupMode ? 'MARKUP: ON' : 'MARKUP: OFF'}
            </button>
            {markupMode && (
              <>
                <span className="sep" />
                <button className="active" disabled={!editing} onClick={completeDraft}>
                  FINISH ({draft.length} PTS)
                </button>
                <button onClick={undoStep}>UNDO</button>
                {editing && (
                  <button onClick={() => setDraft([])}>CANCEL DRAFT</button>
                )}
                {selectedId && <button onClick={() => deleteArea(selectedId)}>DELETE SELECTED</button>}
                <span className="sg-editorhint">
                  click adds a vertex · click the first one or FINISH closes · drag handles
                  edit · Del deletes · Esc cancels
                </span>
              </>
            )}
          </div>
        </div>

        {/* side panel */}
        <div className="sg-side">
          <div className="sg-sec">
            <div className="sg-sec-head">
              <h3>Areas</h3>
              <button className="sg-clearall" onClick={clearAll} disabled={areas.length === 0}>
                clear all
              </button>
            </div>
            {areas.length === 0 ? (
              <p className="sg-hint">
                No areas marked. Turn on <code>MARKUP</code> (feed pauses on a still
                frame), click around a shelf or display and close the polygon.
              </p>
            ) : (
              areas.map((a) => (
                <div
                  key={a.id}
                  className={'sg-area' + (markupMode && selectedId === a.id ? ' sel' : '')}
                >
                  <div className="sg-area-row">
                    <span className="sg-swatch" style={{ background: a.color }} />
                    <input
                      className="sg-area-name"
                      value={a.name}
                      placeholder="name this area"
                      onChange={(e) => renameArea(a.id, e.target.value)}
                    />
                    <span className="sg-area-pts">{a.points.length} pts</span>
                  </div>
                  <div className="sg-area-actions">
                    {markupMode && (
                      <button onClick={() => setSelectedId(a.id)}>select</button>
                    )}
                    <button className="danger" onClick={() => deleteArea(a.id)}>
                      delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="sg-sec">
            <h3>Status</h3>
            <div className="sg-row">
              <span className="k">Camera</span>
              <span className="v sg-v-ok">online</span>
            </div>
            <div className="sg-row">
              <span className="k">Detection</span>
              <span className="v sg-v-ok">running</span>
            </div>
            <div className="sg-row">
              <span className="k">People detected</span>
              <span className="v">{state.detected}</span>
            </div>
            <div className="sg-row">
              <span className="k">Suspects</span>
              <span className={'v ' + (state.suspects > 0 ? 'sg-v-alert' : 'sg-v-ok')}>
                {state.suspects}
              </span>
            </div>
            <div className="sg-row">
              <span className="k">Cashier</span>
              <span className="v">marked · excluded</span>
            </div>
            <div className="sg-row">
              <span className="k">Risk threshold</span>
              <span className="v sg-v-warn">{SUSPECT_THRESHOLD}%</span>
            </div>
            <div className="sg-row">
              <span className="k">Marked areas</span>
              <span className="v">{areas.length}</span>
            </div>
          </div>

          <div className="sg-sec">
            <h3>Person risk</h3>
            {state.people.map((p) => (
              <div className="sg-person" key={p.id}>
                <div className="top">
                  <span className="id">
                    {p.id}
                    {p.suspect && <span className="sg-v-alert"> · SUSPECT</span>}
                  </span>
                  <span style={{ color: riskColor(p.risk), fontWeight: 600 }}>
                    {p.risk.toFixed(0)}%
                  </span>
                </div>
                <div className="sg-meter">
                  <div
                    style={{ width: `${p.risk}%`, background: riskColor(p.risk) }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="sg-sec">
            <h3>Clip timeline</h3>
            <div className="sg-progress">
              <div style={{ width: `${state.t * 100}%` }} />
            </div>
            <div className="sg-t">position: {(state.t * 100).toFixed(1)}% of feed</div>
          </div>

          <p className="sg-hint">
            StoreGuard tracks people in view, estimates stealing likelihood in real
            time and excludes staff from risk scoring. Areas you mark with <code>MARKUP</code>{' '}
            are remembered for this camera and used to attribute detections to shelving.
          </p>
        </div>
        </>
        )}
      </div>
    </div>
  )
}
