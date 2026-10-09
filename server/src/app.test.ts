import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('API', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>
  let base: string

  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  it('reports it is healthy', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('says hello without a database', async () => {
    const body = await (await fetch(`${base}/api/hello`)).json()
    expect(body.message).toContain('Hello')
    expect(body.database).toContain('not configured')
  })

  describe('detections feed', () => {
    // The route probes frontend/public/detections (and dist/ in a build); the
    // test creates a real file there temporarily.
    const dir = path.resolve(import.meta.dirname, '../../frontend/public/detections')
    const file = path.join(dir, 'unit_test_clip.json')

    afterAll(() => {
      fs.rmSync(file, { force: true })
    })

    it('reports no feed when no detections were generated for the clip', async () => {
      const res = await fetch(`${base}/api/detections?video=/cameras/nope_missing.mp4`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ exists: false, url: null })
    })

    it('reports the feed URL when the JSON exists', async () => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ source: 'test' }))
      const res = await fetch(`${base}/api/detections?video=/cameras/unit_test_clip.mp4`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ exists: true, url: '/detections/unit_test_clip.json' })
    })

    it('ignores path components (only the basename is looked up)', async () => {
      const res = await fetch(`${base}/api/detections?video=/cameras/unit_test_clip.mp4`)
      expect((await res.json()).exists).toBe(true)
      // a path that resolves to a bogus basename is not a feed either
      const res2 = await fetch(`${base}/api/detections?video=%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
      // basename "passwd" is a valid name but has no JSON -> absent, not a 500
      expect((await res2.json()).exists).toBe(false)
    })
  })
})
