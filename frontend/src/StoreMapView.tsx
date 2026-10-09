import { useEffect, useMemo, useRef, useState } from 'react'
import { pointInPolygon, pointsToPath, type AreaPoint } from './mock/markup'
import {
  DEFAULT_ZONES,
  MAP_H,
  MAP_W,
  clampToMap,
  demoThefts,
  defaultZoneName,
  loadTheftPoints,
  loadUserZones,
  mergeZones,
  newPointId,
  newZoneId,
  nextZoneColor,
  rankHotspots,
  saveTheftPoints,
  saveUserZones,
  zoneCentroid,
  type MapZone,
  type TheftPoint,
} from './mock/storemap'

// ---------------------------------------------------------------------------
// Store map view: pre-drawn top-down store layout (mirrors CAM 1 in
// vid_crime_1.mp4), theft heatmap with manual mock markers, hotspots
// ranking, and a drag-a-box custom-zone editor. Everything local:
// thefts in sg-theft-points-v1, custom zones in sg-storemap-zones-v1.
// ---------------------------------------------------------------------------

const MIN_BOX = 1.5 // minimum drawn rectangle size (map units) to keep a zone

export default function StoreMapView() {
  const [heat, setHeat] = useState(true)
  const [draw, setDraw] = useState(false)
  const [userZones, setUserZones] = useState<MapZone[]>(() => loadUserZones())
  const [thefts, setThefts] = useState<TheftPoint[]>(() => loadTheftPoints())
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hover, setHover] = useState<AreaPoint | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const zones = useMemo(() => mergeZones(userZones), [userZones])
  const hotspots = useMemo(() => rankHotspots(thefts, zones), [thefts, zones])
  const maxCount = Math.max(1, ...hotspots.rows.map((r) => r.count))

  // Local persistence, same convention as the camera markup.
  useEffect(() => {
    saveTheftPoints(thefts)
  }, [thefts])
  useEffect(() => {
    saveUserZones(userZones)
  }, [userZones])

  // Screen point → map units (0–MAP_W × 0–MAP_H), or null off the plan.
  const toMap = (e: { clientX: number; clientY: number }): AreaPoint | null => {
    const svg = svgRef.current
    if (!svg) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    if (pt.x < 0 || pt.x > MAP_W || pt.y < 0 || pt.y > MAP_H) return null
    return clampToMap({ x: pt.x, y: pt.y })
  }

  // ── theft markers ─────────────────────────────────────────────────

  const addTheft = (e: React.MouseEvent) => {
    const p = toMap(e)
    if (!p) return
    setThefts((t) => [...t, { ...p, id: newPointId() }])
  }

  const removeTheft = (id: string) => setThefts((t) => t.filter((p) => p.id !== id))

  // ── custom zone editor ────────────────────────────────────────────

  const beginBox = (e: React.PointerEvent) => {
    const p = toMap(e)
    if (!p) return
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // capture unsupported — dragging still works without it
    }
  }

  const moveBox = (e: React.PointerEvent) => {
    const p = toMap(e)
    if (!p) return
    setHover(p)
    if (draft) setDraft((d) => (d ? { ...d, x1: p.x, y1: p.y } : d))
  }

  const finishBox = () => {
    if (draft) {
      const x0 = Math.min(draft.x0, draft.x1)
      const x1 = Math.max(draft.x0, draft.x1)
      const y0 = Math.min(draft.y0, draft.y1)
      const y1 = Math.max(draft.y0, draft.y1)
      if (x1 - x0 >= MIN_BOX && y1 - y0 >= MIN_BOX) {
        const z: MapZone = {
          id: newZoneId(),
          name: defaultZoneName(userZones),
          color: nextZoneColor(zones),
          points: [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ].map(clampToMap),
        }
        setUserZones((uz) => [...uz, z])
      }
    }
    setDraft(null)
  }

  const renameZone = (id: string, name: string) =>
    setUserZones((uz) => uz.map((z) => (z.id === id ? { ...z, name } : z)))

  const deleteZone = (id: string) => setUserZones((uz) => uz.filter((z) => z.id !== id))

  const theftZoneName = (p: AreaPoint) => zones.find((z) => pointInPolygon(p, z.points))?.name ?? '—'

  return (
    <div className="sg-mapview">
      <style>{`
        .sg-mapview { flex: 1; display: flex; min-height: 0; }
        .sg-mapcol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
        .sg-maphost {
          flex: 1; min-height: 0; position: relative; background: #060a10;
          border: 1px solid #1d2736; border-radius: 6px; overflow: hidden;
        }
        .sg-mapsvg {
          position: absolute; inset: 0; width: 100%; height: 100%;
          touch-action: none; display: block;
        }
        .sg-mapsvg.heat { cursor: crosshair; }
        .sg-mapsvg.edit { cursor: crosshair; }
        .sg-maptxt { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
        .sg-maphint {
          position: absolute; left: 10px; bottom: 8px;
          font-size: 10px; letter-spacing: 0.4px; color: #4d5f75;
          font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
          pointer-events: none;
        }
        .sg-caption {
          font-size: 10px; letter-spacing: 0.3px; color: #6b8399;
          background: #0d131c; border: 1px solid #1d2736; border-radius: 4px;
          padding: 4px 8px; max-width: 640px; line-height: 1.5;
        }
        .sg-caption b { color: #9db3c8; }
        .sg-topzone {
          display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;
          font-size: 11px; color: #d7e3f2;
        }
        .sg-topzone .flag {
          font-size: 9px; font-weight: 700; letter-spacing: 1px; color: #fff;
          background: #e03131; border-radius: 3px; padding: 2px 6px;
        }
        .sg-topzone .name { font-weight: 700; letter-spacing: 0.5px; }
        .sg-hot { margin-bottom: 7px; }
        .sg-hot .top { display: flex; justify-content: space-between; font-size: 10px; color: #9db3c8; }
        .sg-hot .top .n { font-weight: 700; color: #d7e3f2; }
        .sg-hot .bar { height: 5px; border-radius: 3px; background: #182233; margin-top: 3px; overflow: hidden; }
        .sg-hot .bar > div { height: 100%; border-radius: 3px; }
        .sg-theft {
          display: flex; align-items: center; gap: 6px; font-size: 10px;
          padding: 4px 0; border-bottom: 1px solid #151e2b; color: #9db3c8;
        }
        .sg-theft .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff512f; flex-shrink: 0; }
        .sg-theft .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sg-theft button {
          font: inherit; font-size: 10px; cursor: pointer; color: #7c90a8;
          background: none; border: 1px solid #22304a; border-radius: 3px; padding: 1px 6px;
        }
        .sg-theft button:hover { color: #ff7b7b; border-color: #5a2326; }
        .sg-zone {
          display: flex; align-items: center; gap: 6px; padding: 4px 0;
          border-bottom: 1px solid #151e2b;
        }
        .sg-zone input {
          flex: 1; min-width: 0; font: inherit; font-size: 11px; color: #d7e3f2;
          background: #0c1220; border: 1px solid transparent; border-radius: 3px; padding: 2px 5px;
        }
        .sg-zone input:focus { outline: none; border-color: #46c8f5; }
        .sg-zone button {
          font: inherit; font-size: 10px; cursor: pointer; color: #7c90a8;
          background: none; border: 1px solid #22304a; border-radius: 3px; padding: 1px 6px;
        }
        .sg-zone button:hover { color: #ff7b7b; border-color: #5a2326; }
        .sg-count { font-size: 10px; color: #4d5f75; }
      `}</style>

      <div className="sg-mapcol">
        {/* header row */}
        <div className="sg-camhead">
          <span style={{ fontWeight: 700, letterSpacing: '1.5px', color: '#46c8f5' }}>STORE MAP</span>
          <span className="cam">top-down · Store A (CAM 1 layout)</span>
          <span className="right">{DEFAULT_ZONES.length} default zones · {userZones.length} custom</span>
        </div>

        {/* the plan */}
        <div className="sg-maphost">
          <svg
            ref={svgRef}
            className={'sg-mapsvg' + (heat ? ' heat' : '') + (draw ? ' edit' : '')}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            preserveAspectRatio="xMidYMid meet"
            xmlns="http://www.w3.org/2000/svg"
            onClick={draw ? undefined : heat ? addTheft : undefined}
            onPointerDown={draw ? beginBox : undefined}
            onPointerMove={draw ? moveBox : undefined}
            onPointerUp={draw ? finishBox : undefined}
            onPointerLeave={
              draw
                ? () => {
                    setDraft(null)
                    setHover(null)
                  }
                : undefined
            }
          >
            <defs>
              <radialGradient id="sgheat">
                <stop offset="0" stopColor="#ff512f" stopOpacity="0.95" />
                <stop offset="0.35" stopColor="#ff8a00" stopOpacity="0.55" />
                <stop offset="1" stopColor="#ff8a00" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* floor */}
            <rect x="2" y="2" width={MAP_W - 4} height={MAP_H - 4} fill="#0b1119" />

            {/* faint grid, 10 units */}
            <g stroke="#141d2c" strokeWidth="0.3">
              {Array.from({ length: 9 }, (_, i) => (i + 1) * 10).map((x) => (
                <line key={`v${x}`} x1={x} y1="2" x2={x} y2={MAP_H - 2} />
              ))}
              {Array.from({ length: 5 }, (_, i) => (i + 1) * 10).map((y) => (
                <line key={`h${y}`} x1="2" y1={y} x2={MAP_W - 2} y2={y} />
              ))}
            </g>

            {/* perimeter walls, gap for the back-wall entrance */}
            <g stroke="#3b4a61" strokeWidth="1.6" fill="none">
              <line x1="2" y1="2" x2="11" y2="2" />
              <line x1="25" y1="2" x2="98" y2="2" />
              <line x1="2" y1="2" x2="2" y2={MAP_H - 2} />
              <line x1="98" y1="2" x2="98" y2={MAP_H - 2} />
              <line x1="2" y1={MAP_H - 2} x2="98" y2={MAP_H - 2} />
            </g>

            {/* entrance: door leaf + swing, just inside the top-wall gap */}
            <g>
              <line x1="11" y1="2" x2="25" y2="2" stroke="#34d399" strokeWidth="1.4" strokeDasharray="3 2" />
              <path d="M25 2 A14 14 0 0 1 11 16" fill="none" stroke="#34d399" strokeWidth="0.8" strokeDasharray="2 2" opacity="0.55" />
              <text className="sg-maptxt" x="18" y="0.9" textAnchor="middle" fontSize="2.4" fill="#34d399" letterSpacing="0.5">
                ENTRANCE
              </text>
                  </g>

            {/* zones */}
            <g>
              {zones.map((z) => {
                const c = zoneCentroid(z.points)
                return (
                  <g key={z.id}>
                    <path
                      d={pointsToPath(z.points)}
                      fill={z.color}
                      fillOpacity={0.13}
                      stroke={z.color}
                      strokeOpacity="0.85"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      className="sg-maptxt"
                      x={c.x}
                      y={c.y + 0.8}
                      textAnchor="middle"
                      fontSize="2.1"
                      fill={z.color}
                      fillOpacity="0.95"
                      letterSpacing="0.3"
                      pointerEvents="none"
                    >
                      {z.name.toUpperCase()}
                    </text>
                  </g>
                )
              })}
            </g>

            {/* camera position, where this map was drawn from */}
            <g pointerEvents="none">
              <circle cx="94" cy="55" r="1.7" fill="#0a0e14" stroke="#e8f0fe" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <circle cx="94" cy="55" r="0.55" fill="#e8f0fe" />
              <text className="sg-maptxt" x="94" y="51.6" textAnchor="middle" fontSize="2" fill="#9db3c8" letterSpacing="0.4">
                CAM 1
              </text>
            </g>

            {/* heat blobs: additive via screen blend (no extra deps) */}
            {heat && (
              <g pointerEvents="none" style={{ mixBlendMode: 'screen' }}>
                {thefts.map((p) => (
                  <circle key={`g${p.id}`} cx={p.x} cy={p.y} r="6" fill="url(#sgheat)" />
                ))}
                {thefts.map((p) => (
                  <circle key={`c${p.id}`} cx={p.x} cy={p.y} r="1.3" fill="#fff" opacity="0.55" />
                ))}
              </g>
            )}

            {/* theft markers */}
            <g>
              {thefts.map((p, i) => (
                <circle
                  key={p.id}
                  cx={p.x}
                  cy={p.y}
                  r="1.35"
                  fill="#ff3b30"
                  stroke="#ffd9d2"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents={heat ? 'auto' : 'none'}
                  style={heat ? { cursor: 'pointer' } : undefined}
                  onClick={(e) => {
                    if (!heat) return
                    e.stopPropagation()
                    removeTheft(p.id)
                  }}
                >
                  <title>{`theft #${i + 1} · ${theftZoneName(p)}`}</title>
                </circle>
              ))}
            </g>

            {/* hover ghost in heat mode */}
            {heat && !draw && hover && (
              <circle cx={hover.x} cy={hover.y} r="6" fill="none" stroke="#ff9b6a" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity="0.5" pointerEvents="none" />
            )}

            {/* custom-zone drag box */}
            {draw && draft && (
              <rect
                x={Math.min(draft.x0, draft.x1)}
                y={Math.min(draft.y0, draft.y1)}
                width={Math.abs(draft.x1 - draft.x0)}
                height={Math.abs(draft.y1 - draft.y0)}
                fill="#46c8f5"
                fillOpacity="0.12"
                stroke="#7dd3fc"
                strokeWidth="1.2"
                strokeDasharray="5 3"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
          </svg>

          <div className="sg-maphint">
            {draw
              ? 'EDIT ZONES: drag a box to add a zone (≥ 1.5 units) · it lands under "Custom zones"'
              : heat
                ? 'HEATMAP: click the plan to drop a theft · click a marker to remove it'
                : 'map view'}
          </div>
        </div>

        <div className="sg-caption">
          <b>heatmarkers:</b> theft incidents are detected automatically by StoreGuard, with manual
          marking available as a fallback &nbsp;·&nbsp; the plan reflects the CAM 1 store layout; add
          your own zones in <b>EDIT ZONES</b>.
        </div>

        {/* controls */}
        <div className="sg-controls">
          <span className="lbl">MODE</span>
          <button className={heat ? 'active' : ''} onClick={() => setHeat((h) => !h)}>
            {heat ? 'HEATMAP: ON' : 'HEATMAP: OFF'}
          </button>
          <button className={draw ? 'active-markup' : ''} onClick={() => setDraw((d) => !d)}>
            {draw ? 'EDIT ZONES: ON' : 'EDIT ZONES: OFF'}
          </button>
          <span className="sep" />
          <span className="lbl">DATA</span>
          <button onClick={() => setThefts(demoThefts())}>LOAD LAST 30 DAYS</button>
          <button onClick={() => setThefts([])} disabled={thefts.length === 0}>
            CLEAR THEFTS ({thefts.length})
          </button>
        </div>
      </div>

      {/* side panel */}
      <div className="sg-side">
        <div className="sg-sec">
          <h3>Hotspots</h3>
          {hotspots.total === 0 ? (
            <p className="sg-hint">
              No theft markers yet. Turn on <code>HEATMAP</code> and click the plan, or load the
              last 30 days of detections with <code>LOAD LAST 30 DAYS</code>.
            </p>
          ) : (
            <>
              <div className="sg-topzone">
                <span className="flag">TOP TARGETED</span>
                <span className="name" style={{ color: hotspots.rows[0].color }}>
                  {hotspots.rows[0].name}
                </span>
              </div>
              {hotspots.rows.map((r) => (
                <div key={r.id} className="sg-hot">
                  <div className="top">
                    <span>
                      {r.builtIn ? '' : '· '}
                      {r.name}
                    </span>
                    <span className="n">
                      {r.count}
                      {r.count > 0 && <span style={{ color: '#4d5f75', fontWeight: 400 }}> / {hotspots.total}</span>}
                    </span>
                  </div>
                  <div className="bar">
                    <div
                      style={{
                        width: `${(r.count / maxCount) * 100}%`,
                        background: r.color,
                        opacity: r.count === 0 ? 0.25 : 0.9,
                      }}
                    />
                  </div>
                </div>
              ))}
              {hotspots.unzoned > 0 && (
                <div className="sg-row" style={{ marginTop: 4 }}>
                  <span className="k">outside any zone</span>
                  <span className="v">{hotspots.unzoned}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sg-sec">
          <div className="sg-sec-head">
            <h3>Theft markers</h3>
            <button className="sg-clearall" onClick={() => setThefts([])} disabled={thefts.length === 0}>
              clear all
            </button>
          </div>
          {thefts.length === 0 ? (
            <p className="sg-hint">
              No theft incidents yet for this store.
            </p>
          ) : (
            thefts.map((p, i) => (
              <div className="sg-theft" key={p.id}>
                <span className="dot" />
                <span className="who">
                  #{i + 1} · {theftZoneName(p)}
                </span>
                <button onClick={() => removeTheft(p.id)}>remove</button>
              </div>
            ))
          )}
        </div>

        <div className="sg-sec">
          <div className="sg-sec-head">
            <h3>Custom zones</h3>
            <span className="sg-count">
              {userZones.length} ({DEFAULT_ZONES.length} defaults)
            </span>
          </div>
          {userZones.length === 0 ? (
            <p className="sg-hint">
              The pre-drawn defaults are fixed. Turn on <code>EDIT ZONES</code> and drag a box on the
              plan to add yours.
            </p>
          ) : (
            userZones.map((z) => (
              <div className="sg-zone" key={z.id}>
                <span className="sg-swatch" style={{ background: z.color }} />
                <input value={z.name} onChange={(e) => renameZone(z.id, e.target.value)} />
                <button onClick={() => deleteZone(z.id)}>delete</button>
              </div>
            ))
          )}
        </div>

        <p className="sg-hint">
          The plan reflects the current layout of the store (shelf wall left · display centre ·
          checkout right · service counter back-right · promo stand · entrance back wall);
          adjust it in <code>EDIT ZONES</code>.
        </p>
      </div>
    </div>
  )
}
