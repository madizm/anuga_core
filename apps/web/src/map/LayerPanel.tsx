import type { FrictionScenario } from '../api/types'
import { useInletStore, type SelectionMode } from '../inlets/inletStore'
import { useLayerStore } from './mapStore'

const TOOLS: { mode: SelectionMode; icon: string; label: string; hint: string }[] = [
  { mode: 'click', icon: '⌖', label: '单格', hint: '点击选择' },
  { mode: 'brush', icon: '╱', label: '画刷', hint: '拖动连续选择' },
  { mode: 'box', icon: '□', label: '框选', hint: '拖出矩形范围' },
]

export function LayerPanel({ frictionScenario, areaReady, areaCellCount }: {
  frictionScenario: FrictionScenario
  areaReady: boolean
  areaCellCount: number
}) {
  const layers = useLayerStore()
  const mode = useInletStore((state) => state.selectionMode)
  const setMode = useInletStore((state) => state.setSelectionMode)
  const clear = useInletStore((state) => state.clearActive)
  const activeId = useInletStore((state) => state.activeId)
  const inlets = useInletStore((state) => state.inlets)
  const locateActive = () => {
    const cellIds = inlets.find((inlet) => inlet.id === activeId)?.cellIds ?? []
    window.dispatchEvent(new CustomEvent('locate-inlet', { detail: cellIds }))
  }

  return (
    <aside className="left-panel panel">
      <div className="panel-heading compact">
        <div>
          <span className="eyebrow">MAP OPERATIONS</span>
          <h2>图层与选择</h2>
        </div>
      </div>

      <section className="tool-section">
        <h3>入口网格工具</h3>
        <div className="tool-grid">
          {TOOLS.map((tool) => (
            <button
              key={tool.mode}
              className={mode === tool.mode ? 'tool active' : 'tool'}
              disabled={!areaReady}
              onClick={() => setMode(tool.mode)}
              title={tool.hint}
            >
              <b>{tool.icon}</b><span>{tool.label}</span>
            </button>
          ))}
        </div>
        <div className="modifier-guide">
          <span><kbd>Shift</kbd> 增加</span>
          <span><kbd>Alt</kbd> 删除</span>
        </div>
        <div className="quiet-actions">
          <button className="quiet-button" disabled={!areaReady} onClick={locateActive}>定位入口</button>
          <button className="quiet-button" disabled={!areaReady} onClick={clear}>清空入口</button>
        </div>
      </section>

      <section className="tool-section layer-list">
        <h3>模型图层</h3>
        <LayerRow label="深色底图" detail="OSM · 灰阶" checked={layers.base} onChange={(visible) => layers.setLayer('base', visible)} swatch="base" />
        <LayerRow label="DEM 高程" detail="30 m · terrain" checked={layers.dem} onChange={(visible) => layers.setLayer('dem', visible)} swatch="dem" />
        <LayerRow label="30 m 局部网格" detail={areaReady ? `${areaCellCount.toLocaleString()} cells` : '选择区域后生成'} checked={layers.grid} disabled={!areaReady} onChange={(visible) => layers.setLayer('grid', visible)} swatch="grid" />
        <LayerRow label="建筑覆盖率" detail="0–100% · 局部区域" checked={layers.buildings} disabled={!areaReady} onChange={(visible) => layers.setLayer('buildings', visible)} swatch="building" />
        <LayerRow label="曼宁糙率" detail={`${frictionScenario} · coefficient`} checked={layers.manning} disabled={!areaReady} onChange={(visible) => layers.setLayer('manning', visible)} swatch="friction" />
      </section>

      <div className="model-stamp">
        <span>LOCAL DOMAIN</span>
        <strong>BYQ · 30 M</strong>
        <small>Transmissive boundary</small>
      </div>
    </aside>
  )
}

function LayerRow({ label, detail, checked, onChange, swatch, disabled = false }: {
  label: string
  detail: string
  checked: boolean
  onChange: (checked: boolean) => void
  swatch: string
  disabled?: boolean
}) {
  return (
    <label className={disabled ? 'layer-row disabled' : 'layer-row'}>
      <i className={`layer-swatch ${swatch}`} />
      <span><strong>{label}</strong><small>{detail}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <b className="switch" />
    </label>
  )
}
