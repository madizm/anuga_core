import { useInletStore, type SelectionMode } from '../inlets/inletStore'
import { useLayerStore } from './mapStore'

const TOOLS: { mode: SelectionMode; icon: string; label: string; hint: string }[] = [
  { mode: 'click', icon: '⌖', label: '单格', hint: '点击选择' },
  { mode: 'brush', icon: '╱', label: '画刷', hint: '拖动连续选择' },
  { mode: 'box', icon: '□', label: '框选', hint: '拖出矩形范围' },
]

export function LayerPanel() {
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
          <button className="quiet-button" onClick={locateActive}>定位入口</button>
          <button className="quiet-button" onClick={clear}>清空入口</button>
        </div>
      </section>

      <section className="tool-section layer-list">
        <h3>模型图层</h3>
        <LayerRow label="深色底图" detail="OSM · 灰阶" checked={layers.base} onChange={(visible) => layers.setLayer('base', visible)} swatch="base" />
        <LayerRow label="30 m 计算网格" detail="4,087 cells" checked={layers.grid} onChange={(visible) => layers.setLayer('grid', visible)} swatch="grid" />
        <LayerRow label="建筑覆盖率" detail="即将接入" checked={false} onChange={() => undefined} swatch="building" disabled />
        <LayerRow label="曼宁糙率" detail="low / mid / high" checked={false} onChange={() => undefined} swatch="friction" disabled />
      </section>

      <div className="model-stamp">
        <span>FIXED MODEL</span>
        <strong>BYQ · 30M</strong>
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
