import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createProcessSampler } from './process-usage.mjs'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { ProcessUsageReading } = await server.ssrLoadModule('/src/components/ProcessUsage.tsx')
  const React = await import('react')
  const { renderToString } = await import('react-dom/server')
  const { MemoryRouter } = await import('react-router-dom')
  assert.equal(typeof ProcessUsageReading, 'function', 'the process snapshot must have a renderable view')
  const reading = createProcessSampler()()
  const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(ProcessUsageReading, { reading, now: Date.now() })))
  assert.ok(html.includes('Host &amp; agents'))
  assert.ok(html.includes('Watchlist'))
  assert.ok(html.includes('Processes &amp; children'))
  assert.ok(html.includes('Shared process'))
  assert.ok(html.includes('peak RSS'))
  assert.ok(!html.includes('undefined') && !html.includes('NaN'))
  console.log(`✓ Usage view renders real host snapshot: ${reading.groups.length} groups, room links, child processes and shared attribution`)
} finally { await server.close() }
