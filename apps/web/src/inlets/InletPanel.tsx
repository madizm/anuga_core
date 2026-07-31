import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { isFourNeighbourConnected, useInletStore } from './inletStore'
import type { Inlet, VelocityMode } from '../api/types'

function NumericField({
  label,
  unit,
  value,
  onChange,
  min,
}: {
  label: string
  unit: string
  value: number | null | undefined
  onChange: (value: number | null) => void
  min?: number
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="number-input">
        <input
          type="number"
          min={min}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        />
        <em>{unit}</em>
      </span>
    </label>
  )
}

export function InletPanel({ demProductId, cellSizeM, areaHash, frictionScenario }: {
  demProductId: string
  cellSizeM: number
  areaHash: string | null
  frictionScenario: string
}) {
  const { inlets, activeId, addInlet, removeInlet, setActive, updateInlet, selectionError } = useInletStore()
  const active = inlets.find((item) => item.id === activeId)

  return (
    <aside className={areaHash ? 'right-panel panel' : 'right-panel panel area-unavailable'}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">INFLOW CONTROL</span>
          <h2>入口与参数</h2>
        </div>
        <button className="icon-button add" disabled={!areaHash} onClick={addInlet} aria-label="新建入口">＋</button>
      </div>

      {!areaHash && <div className="area-required">
        <b>步骤 01 未完成</b>
        <span>锁定模拟区域后才可选择入口网格</span>
      </div>}

      <div className="inlet-tabs" role="tablist" aria-label="入口列表">
        {inlets.map((inlet, index) => (
          <button
            role="tab"
            aria-selected={activeId === inlet.id}
            className={activeId === inlet.id ? 'inlet-tab active' : 'inlet-tab'}
            onClick={() => setActive(inlet.id)}
            key={inlet.id}
          >
            <i style={{ background: inlet.displayColor }} />
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{inlet.name}</strong>
            <small>{inlet.cellIds.length} 格</small>
          </button>
        ))}
      </div>

      {active ? (
        <InletEditor
          inlet={active}
          canDelete={inlets.length > 1}
          demProductId={demProductId}
          cellSizeM={cellSizeM}
          areaHash={areaHash}
          frictionScenario={frictionScenario}
          onUpdate={(patch) => updateInlet(active.id, patch)}
          onDelete={() => removeInlet(active.id)}
        />
      ) : (
        <div className="empty-state">新建一个入口以开始网格选择</div>
      )}
      {selectionError && <div className="inline-alert error">{selectionError}</div>}
    </aside>
  )
}

function InletEditor({
  demProductId,
  cellSizeM,
  inlet,
  canDelete,
  areaHash,
  frictionScenario,
  onUpdate,
  onDelete,
}: {
  demProductId: string
  cellSizeM: number
  inlet: Inlet
  canDelete: boolean
  areaHash: string | null
  frictionScenario: string
  onUpdate: (patch: Partial<Inlet>) => void
  onDelete: () => void
}) {
  const connected = isFourNeighbourConnected(inlet.cellIds)
  const area = inlet.cellIds.length * cellSizeM ** 2
  const stats = useQuery({
    queryKey: ['selection-stats', demProductId, areaHash, inlet.cellIds, frictionScenario],
    queryFn: () => api.resolveSelection(
      demProductId, areaHash!, inlet.cellIds, frictionScenario,
    ),
    enabled: Boolean(areaHash) && connected,
  })
  return (
    <div className="inlet-editor">
      <div className="editor-title-row">
        <input
          className="name-input"
          value={inlet.name}
          aria-label="入口名称"
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
        <label className="toggle">
          <input
            type="checkbox"
            checked={inlet.enabled}
            onChange={(event) => onUpdate({ enabled: event.target.checked })}
          />
          <span /> 启用
        </label>
      </div>

      <div className="selection-readout">
        <div><span>选中网格</span><strong>{inlet.cellIds.length}</strong><em>cells</em></div>
        <div><span>几何面积</span><strong>{area.toLocaleString()}</strong><em>m²</em></div>
        <div>
          <span>四邻域</span>
          <strong className={connected ? 'ok' : 'warn'}>{connected ? '连续' : '待连接'}</strong>
          <em>{connected ? 'ready' : 'check'}</em>
        </div>
      </div>
      {stats.data && (
        <div className="hydraulic-stats">
          <span><b>{stats.data.triangleCount}</b> triangles</span>
          <span><b>{stats.data.effectiveTriangleAreaM2.toLocaleString()}</b> m² 水力面积</span>
          <span><b>{stats.data.elevationM.minimum.toFixed(1)}–{stats.data.elevationM.maximum.toFixed(1)}</b> m 高程</span>
          <span><b>{stats.data.manning.minimum.toFixed(3)}–{stats.data.manning.maximum.toFixed(3)}</b> Manning</span>
        </div>
      )}

      <section className="parameter-section">
        <h3><span>01</span> 流量设定</h3>
        <NumericField
          label="恒定总流量"
          unit="m³/s"
          min={0}
          value={inlet.dischargeM3s}
          onChange={(value) => onUpdate({ dischargeM3s: value ?? 0 })}
        />
      </section>

      <section className="parameter-section">
        <h3><span>02</span> 入流速度</h3>
        <div className="segmented three">
          {(['zero', 'components', 'bearing'] as VelocityMode[]).map((mode) => (
            <button
              className={inlet.velocityMode === mode ? 'active' : ''}
              onClick={() => onUpdate({ velocityMode: mode })}
              key={mode}
            >
              {{ zero: '零速度', components: '分量', bearing: '方位角' }[mode]}
            </button>
          ))}
        </div>
        {inlet.velocityMode === 'components' && (
          <div className="field-grid">
            <NumericField label="U · 向东+" unit="m/s" value={inlet.velocityUMps ?? 0} onChange={(value) => onUpdate({ velocityUMps: value ?? 0 })} />
            <NumericField label="V · 向北+" unit="m/s" value={inlet.velocityVMps ?? 0} onChange={(value) => onUpdate({ velocityVMps: value ?? 0 })} />
          </div>
        )}
        {inlet.velocityMode === 'bearing' && (
          <div className="field-grid">
            <NumericField label="速度" unit="m/s" min={0} value={inlet.speedMps ?? 0} onChange={(value) => onUpdate({ speedMps: value ?? 0 })} />
            <NumericField label="方位角" unit="°N" value={inlet.bearingDegrees ?? 0} onChange={(value) => onUpdate({ bearingDegrees: value ?? 0 })} />
          </div>
        )}
      </section>

      <section className="parameter-section">
        <h3><span>03</span> 初始水面</h3>
        <label className="check-row">
          <input
            type="checkbox"
            checked={inlet.initialWaterLevelM !== null}
            onChange={(event) => onUpdate({ initialWaterLevelM: event.target.checked ? 0 : null })}
          />
          指定 t=0 水面高程
        </label>
        {inlet.initialWaterLevelM !== null && (
          <NumericField label="初始水位" unit="m" value={inlet.initialWaterLevelM} onChange={(value) => onUpdate({ initialWaterLevelM: value })} />
        )}
        <p className="field-note">仅设置初始状态，模拟过程中不会持续维持。</p>
      </section>

      {canDelete && <button className="delete-button" onClick={onDelete}>删除当前入口</button>}
    </div>
  )
}
