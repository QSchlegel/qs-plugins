#!/usr/bin/env node
// Static server for session-viz.com. Three files, no dependencies — a static
// host would also do, but this keeps the whole site deployable as one Railway
// service alongside the API.
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'

const ROOT = new URL('.', import.meta.url).pathname
const PORT = Number(process.env.PORT || 8080)
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' }

http.createServer(async (req, res) => {
  const raw = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  // normalize + prefix check: a path that escapes ROOT is refused, not served.
  const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^(\.\.[/\\])+/, '')
  const file = join(ROOT, rel)
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden') }
  try {
    const s = await stat(file)
    if (!s.isFile()) throw new Error('not a file')
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': extname(file) === '.html' ? 'public,max-age=60' : 'public,max-age=86400',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('404')
  }
}).listen(PORT, () => console.log(`web listening on :${PORT}`))
