import assert from 'node:assert/strict'
import { createServer } from 'vite'
import React from 'react'
import { renderToString } from 'react-dom/server'
const server = await createServer({ optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { UsageTabs } = await server.ssrLoadModule('/src/components/UsageTabs.tsx')
  for (const tab of ['llm', 'system']) {
    const html = renderToString(React.createElement(UsageTabs, { tab, onChange: () => {}, llm: 'LLM CONTENT', system: 'SYSTEM CONTENT' }))
    assert.ok(html.indexOf('LLM Usage') < html.indexOf('System'))
    assert.ok(html.includes('role="tablist"'))
    assert.ok(html.includes(`id="usage-tab-${tab}" role="tab" aria-selected="true"`))
    assert.ok(html.includes(tab === 'llm' ? 'LLM CONTENT' : 'SYSTEM CONTENT'))
    assert.ok(!html.includes(tab === 'llm' ? 'SYSTEM CONTENT' : 'LLM CONTENT'))
  }
  const { default: Usage } = await server.ssrLoadModule('/src/components/Usage.tsx')
  const initial = renderToString(React.createElement(Usage))
  assert.ok(initial.includes('id="usage-tab-llm" role="tab" aria-selected="true"'), 'LLM is selected on opening Usage')
  assert.ok(!initial.includes('Host &amp; agents'), 'system metrics do not precede LLM usage')
  console.log('✓ Usage tabs: LLM first and default, accessible selected state, separate content panels')
} finally { await server.close() }
