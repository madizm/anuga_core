import { useEffect, useRef, useState } from 'react'
import { useTerrainStore, type TerrainExaggeration, type TerrainScope } from './terrainStore'

export function TerrainControl({
  scope,
  temporarilyFlat = false,
  error,
  flowIsTwoDimensional = false,
  waterError,
  onRetry,
  onWaterRetry,
}: {
  scope: TerrainScope
  temporarilyFlat?: boolean
  error?: string | null
  flowIsTwoDimensional?: boolean
  waterError?: string | null
  onRetry?: () => void
  onWaterRetry?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const preferredEnabled = useTerrainStore((state) => (
    scope === 'model' ? state.modelEnabled : state.resultEnabled
  ))
  const exaggeration = useTerrainStore((state) => state.exaggeration)
  const hillshade = useTerrainStore((state) => state.hillshade)
  const setEnabled = useTerrainStore((state) => state.setEnabled)
  const setExaggeration = useTerrainStore((state) => state.setExaggeration)
  const setHillshade = useTerrainStore((state) => state.setHillshade)
  const enabled = preferredEnabled && !temporarilyFlat && !error

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="terrain-control" ref={root}>
      <div className="terrain-control-buttons">
        <button
          className={enabled ? 'terrain-mode active' : 'terrain-mode'}
          aria-pressed={enabled}
          aria-label={enabled ? '切换到二维地图' : '切换到三维地形'}
          onClick={() => setEnabled(scope, !preferredEnabled)}
        >
          <b>{enabled ? '3D' : '2D'}</b>
          <span>{temporarilyFlat && preferredEnabled ? '编辑中' : enabled ? '地形' : '平面'}</span>
        </button>
        <button
          className={open ? 'terrain-settings active' : 'terrain-settings'}
          aria-expanded={open}
          aria-label="地形显示设置"
          onClick={() => setOpen((value) => !value)}
        >⌄</button>
      </div>
      {flowIsTwoDimensional && enabled && (
        <span className="terrain-flow-warning">水面效果为二维投影</span>
      )}
      {error && <span className="terrain-error-badge">地形失败 · 已回退二维</span>}
      {waterError && <span className="terrain-error-badge water-error-badge">水波失败 · 已回退</span>}
      {open && (
        <section className="terrain-popover" aria-label="地形显示设置">
          <header><span>TERRAIN VIEW</span><strong>地形显示</strong></header>
          <div className="terrain-setting">
            <label>垂直比例</label>
            <div className="terrain-ratios">
              {([1, 1.5, 2] as TerrainExaggeration[]).map((ratio) => (
                <button
                  key={ratio}
                  className={exaggeration === ratio ? 'active' : ''}
                  onClick={() => setExaggeration(ratio)}
                >{ratio.toFixed(1)}×</button>
              ))}
            </div>
          </div>
          <label className="terrain-shade-toggle">
            <span><strong>地形阴影</strong><small>增强山脊与沟谷</small></span>
            <input
              type="checkbox"
              checked={hillshade}
              onChange={(event) => setHillshade(event.target.checked)}
            />
            <i />
          </label>
          {temporarilyFlat && preferredEnabled && (
            <p className="terrain-notice">编辑期间暂时使用二维正交视图</p>
          )}
          {flowIsTwoDimensional && enabled && (
            <p className="terrain-notice warning">流向与水波为二维投影，仅供方向参考</p>
          )}
          {error && (
            <div className="terrain-failure">
              <p>{error}，已切换到二维模式</p>
              <button onClick={onRetry}>重试地形加载</button>
            </div>
          )}
          {waterError && (
            <div className="terrain-failure water-failure">
              <p>{waterError}，已回退为仅显示流向粒子</p>
              <button onClick={onWaterRetry}>重试水波效果</button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
