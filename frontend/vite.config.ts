import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the built site works from any path (GitHub Pages project sites).
  base: './',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Traefik forwards the original Host header (<port>-<project>.replbox.lan)
    // unchanged, and Vite rejects hosts it doesn't recognise by default.
    allowedHosts: ['.replbox.lan'],
    // Only this port is previewed, so the API is reached through it.
    proxy: { '/api': 'http://localhost:8000' },
  },
})
