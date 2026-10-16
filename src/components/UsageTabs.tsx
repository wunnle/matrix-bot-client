import type { KeyboardEvent, ReactNode } from 'react'

export type UsageTab = 'llm' | 'system'
const tabs: { id: UsageTab; label: string }[] = [
  { id: 'llm', label: 'LLM Usage' },
  { id: 'system', label: 'System' },
]
export function UsageTabs({ tab, onChange, llm, system }: {
  tab: UsageTab; onChange: (tab: UsageTab) => void; llm: ReactNode; system: ReactNode
}) {
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = (index + 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onChange(tabs[next].id)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#usage-tab-${tabs[next].id}`)?.focus()
  }
  return <>
    <div className="usage-tabs" role="tablist" aria-label="Usage category">
      {tabs.map((item, index) => <button key={item.id} type="button" id={`usage-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
        aria-controls={`usage-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => onChange(item.id)} onKeyDown={event => keyDown(event, index)}>{item.label}</button>)}
    </div>
    {tabs.map(item => <div key={item.id} id={`usage-panel-${item.id}`} role="tabpanel" aria-labelledby={`usage-tab-${item.id}`} tabIndex={0} hidden={tab !== item.id}>
      {tab === item.id ? (item.id === 'llm' ? llm : system) : null}
    </div>)}
  </>
}
