import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

// The API, without listening on a port, so tests can start it on any free one (see app.test.ts).
export function createApp() {
  const app = express()

  // No database is attached by default. If you add a Postgres service named "postgres"
  // from the project's Services dialog, Replbox puts its connection string in
  // POSTGRES_URL (dev: /secrets/.env, loaded by `pnpm dev`; published apps: the
  // deployment secrets). The app also runs without a database.
  const pool = process.env.POSTGRES_URL ? new pg.Pool({ connectionString: process.env.POSTGRES_URL }) : null

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/api/hello', async (_req, res) => {
    const time = pool ? (await pool.query('select now() as now')).rows[0].now : new Date().toISOString()
    res.json({
      message: 'Hello from your Replbox Express API!',
      time,
      database: pool ? 'connected' : 'not configured (POSTGRES_URL is not set)',
    })
  })

  // Real-detection feed: tells the frontend whether generated YOLO detection
  // JSON exists for a clip so it can fall back to the scripted mock without
  // triggering a 404 in the browser. Probes both the dev (public/) and
  // production (dist/) locations. Run tools/generate_detections.py to create
  // these files with a real YOLO model.
  app.get('/api/detections', (req, res) => {
    // The clip path can be a full URL path (/cameras/vid_crime_1.mp4); only
    // the file name matters, which also keeps the lookup traversal-safe.
    const filename = String(req.query.video ?? '').split(/[\\/]/).pop() ?? ''
    const stem = filename.replace(/\.[^./\\]+$/, '')
    if (!/^[A-Za-z0-9_-]+$/.test(stem)) {
      res.json({ exists: false, url: null })
      return
    }
    const file = `${stem}.json`
    const candidates = [
      path.resolve(import.meta.dirname, `../../frontend/public/detections/${file}`),
      path.resolve(import.meta.dirname, `../../frontend/dist/detections/${file}`),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        res.json({ exists: true, url: `/detections/${file}` })
        return
      }
    }
    res.json({ exists: false, url: null })
  })

  // A published app serves the built frontend from the same server. Keep this
  // after the API routes so the single-page fallback never swallows them.
  const staticDir = path.resolve(import.meta.dirname, '../../frontend/dist')
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir))
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  return app
}
