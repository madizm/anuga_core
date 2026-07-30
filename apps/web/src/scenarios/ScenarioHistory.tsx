import { useEffect } from 'react'
import type { SavedScenario } from '../api/types'

interface ScenarioHistoryProps {
  scenarios: SavedScenario[]
  currentId: string | null
  loading: boolean
  loadingId: string | null
  error: string | null
  onClose: () => void
  onOpen: (id: string) => void
  onRefresh: () => void
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formattedDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormatter.format(date)
}

export function ScenarioHistory({
  scenarios,
  currentId,
  loading,
  loadingId,
  error,
  onClose,
  onOpen,
  onRefresh,
}: ScenarioHistoryProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="scenario-history" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header>
          <div>
            <span className="eyebrow">SCENARIO ARCHIVE</span>
            <h2 id="history-title">历史场景</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭历史场景">×</button>
        </header>
        <div className="history-summary">
          <span>已保存记录</span>
          <strong>{scenarios.length.toString().padStart(2, '0')}</strong>
          <button onClick={onRefresh} disabled={loading}>↻ 刷新</button>
        </div>
        <div className="history-list" aria-live="polite">
          {loading && scenarios.length === 0 && <div className="history-state"><i />正在读取场景档案</div>}
          {error && <div className="history-state error"><strong>读取失败</strong><span>{error}</span><button onClick={onRefresh}>重试</button></div>}
          {!loading && !error && scenarios.length === 0 && (
            <div className="history-state empty"><b>00</b><strong>暂无历史场景</strong><span>完成区域与入口配置后，点击“保存场景”建立第一条记录。</span></div>
          )}
          {scenarios.map((scenario, index) => {
            const active = scenario.id === currentId
            const enabledInlets = scenario.inlets.filter((inlet) => inlet.enabled)
            return (
              <article className={active ? 'history-card active' : 'history-card'} key={scenario.id}>
                <div className="history-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="history-card-main">
                  <div className="history-card-title">
                    <strong>{scenario.name}</strong>
                    {active && <em>当前</em>}
                  </div>
                  <span>{formattedDate(scenario.updatedAt)} 更新 · {enabledInlets.length} 入口</span>
                  <div className="history-tags">
                    <i>{Math.round(scenario.durationSeconds / 60)} MIN</i>
                    <i>ΔT {scenario.yieldstepSeconds} S</i>
                    <i>MANNING {scenario.frictionScenario.toUpperCase()}</i>
                  </div>
                  <small title={scenario.simulationAreaId}>AREA / {scenario.simulationAreaId.slice(0, 12)}</small>
                </div>
                <button
                  className="history-open"
                  disabled={loadingId !== null || active}
                  onClick={() => onOpen(scenario.id)}
                >{loadingId === scenario.id ? '装载中…' : active ? '已打开' : '打开场景'}</button>
              </article>
            )
          })}
        </div>
        <footer><span>场景按最后更新时间排序</span><kbd>ESC</kbd><span>关闭</span></footer>
      </aside>
    </div>
  )
}
