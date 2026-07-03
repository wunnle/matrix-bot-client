import { useEffect, useState } from 'react'
import { isDebugEnabled } from '../lib/debug'

/** Measure a CSS length by probing a throwaway fixed-position element. */
function probe(height: string): number {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:${height}`
  document.body.appendChild(el)
  const h = el.offsetHeight
  el.remove()
  return h
}

/**
 * On-device viewport diagnostics, toggled by tapping the version label in
 * the sidebar. Shows the raw numbers behind the keyboard/chin layout math
 * so device-specific issues can be read off a screenshot.
 */
export default function DebugOverlay() {
  const [enabled, setEnabled] = useState(isDebugEnabled)
  const [lines, setLines] = useState<string[]>([])
  const [top, setTop] = useState(70)

  useEffect(() => {
    const onToggle = () => setEnabled(isDebugEnabled())
    window.addEventListener('construct-debug', onToggle)
    return () => window.removeEventListener('construct-debug', onToggle)
  }, [])

  useEffect(() => {
    if (!enabled) return

    const measure = () => {
      const vv = window.visualViewport
      const rootStyle = document.documentElement.style
      const layoutRect = document.querySelector('.layout')?.getBoundingClientRect()
      const active = document.activeElement
      const fmt = (n: number | undefined) => (n === undefined ? '-' : String(Math.round(n)))
      // Overlay is position:fixed (layout viewport); when the keyboard makes
      // iOS scroll the visual viewport, follow it so the box stays readable.
      setTop(Math.round(vv?.offsetTop ?? 0) + 70)
      setLines([
        `v${__CONSTRUCT_VERSION__}  ${window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'}`,
        `inner ${window.innerWidth}x${window.innerHeight}  outer ${window.outerWidth}x${window.outerHeight}  screen ${screen.width}x${screen.height}`,
        `vv h=${fmt(vv?.height)} top=${fmt(vv?.offsetTop)} scale=${vv ? vv.scale.toFixed(2) : '-'}`,
        `--vv-height ${rootStyle.getPropertyValue('--vv-height') || '(unset)'}  --vv-top ${rootStyle.getPropertyValue('--vv-top') || '(unset)'}`,
        `layout top=${fmt(layoutRect?.top)} bottom=${fmt(layoutRect?.bottom)} h=${fmt(layoutRect?.height)}`,
        `100dvh=${probe('100dvh')} 100svh=${probe('100svh')} safe-b=${probe('env(safe-area-inset-bottom)')}`,
        `active <${active ? active.tagName.toLowerCase() : 'none'}>`,
      ])
    }

    const first = setTimeout(measure, 0)
    const id = setInterval(measure, 500)
    const vv = window.visualViewport
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    return () => {
      clearTimeout(first)
      clearInterval(id)
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
    }
  }, [enabled])

  if (!enabled || lines.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        top,
        left: 8,
        zIndex: 9999,
        pointerEvents: 'none',
        background: 'rgba(0,0,0,0.75)',
        color: '#4ade80',
        font: '11px/1.5 ui-monospace, monospace',
        padding: '6px 8px',
        borderRadius: 6,
        whiteSpace: 'pre',
      }}
    >
      {lines.join('\n')}
    </div>
  )
}
