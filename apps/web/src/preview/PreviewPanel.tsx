import type { ResultQuantity } from '../api/types'
import type { PreviewCapabilities, PreviewStatus } from './types'

const RATES = [30, 60, 180, 600]
const QUANTITIES: Array<[ResultQuantity, string]> = [
  ['depth', '水深'], ['stage', '水位'], ['speed', '流速'],
]

export function PreviewPanel({
  status,
  capabilities,
  quantity,
  flowEnabled,
  onStart,
  onPause,
  onReset,
  onClose,
  onRate,
  onQuantity,
  onFlow,
  onFormal,
}: {
  status: PreviewStatus | null
  capabilities: PreviewCapabilities
  quantity: ResultQuantity
  flowEnabled: boolean
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onClose: () => void
  onRate: (rate: number) => void
  onQuantity: (quantity: ResultQuantity) => void
  onFlow: (enabled: boolean) => void
  onFormal: () => void
}) {
  const active = status && status.phase !== 'idle'
  const running = status?.phase === 'running'
  const stale = status?.phase === 'stale'
  const diagnostic = status?.snapshot?.diagnostics
  return (
    <section className={`preview-panel ${active ? 'active' : ''}`} aria-label="快速预览控制">
      <div className="preview-panel-heading">
        <div>
          <span className="eyebrow preview-eyebrow">LOCAL GPU PREVIEW · NON-AUTHORITATIVE</span>
          <strong>{status?.phase === 'completed' ? '预览已完成' : stale ? '场景已修改，预览失效' : '快速预览'}</strong>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭快速预览">×</button>
      </div>
      {!capabilities.supported && (
        <div className="preview-warning" role="status">
          <b>当前设备不可用</b><span>{capabilities.reason ?? '需要 WebGL2 浮点计算纹理'}</span>
        </div>
      )}
      {status?.error && <div className="preview-warning error" role="alert"><b>预览暂停</b><span>{status.error}</span></div>}
      <div className="preview-time">
        <div><span>SIMULATION TIME</span><strong>T+{Math.round(status?.timeSeconds ?? 0)}s</strong><small>/ {status?.durationSeconds ?? 0}s</small></div>
        <i className={running ? 'running' : ''} />
        <em>{running ? '计算中' : stale ? '需要重启' : status?.phase === 'paused' ? '已暂停' : status?.phase === 'completed' ? '完成' : '待机'}</em>
      </div>
      <div className="preview-controls">
        <button className="preview-play" disabled={!capabilities.supported || stale} onClick={running ? onPause : onStart}>
          <span>{running ? 'Ⅱ' : '▶'}</span>{running ? '暂停' : status?.phase === 'completed' ? '重新开始' : '开始预览'}
        </button>
        <button className="preview-reset" disabled={!active} onClick={onReset}>重置</button>
      </div>
      <div className="preview-rate" role="group" aria-label="预览速度">
        <span>SIM SPEED</span>
        {RATES.map((rate) => <button key={rate} className={status?.playbackRate === rate ? 'active' : ''} onClick={() => onRate(rate)}>{rate}×</button>)}
      </div>
      <div className="preview-quantity" role="group" aria-label="预览显示量">
        {QUANTITIES.map(([value, label]) => <button key={value} className={quantity === value ? 'active' : ''} onClick={() => onQuantity(value)}>{label}<small>{value.toUpperCase()}</small></button>)}
        <button className={flowEnabled ? 'active' : ''} onClick={() => onFlow(!flowEnabled)}>流向<small>{flowEnabled ? 'ON' : 'OFF'}</small></button>
      </div>
      <div className="preview-vitals">
        <div><span>MAX DEPTH</span><strong>{diagnostic ? diagnostic.maximumDepthM.toFixed(2) : '—'}<em> m</em></strong></div>
        <div><span>MAX SPEED</span><strong>{diagnostic ? diagnostic.maximumSpeedMps.toFixed(2) : '—'}<em> m/s</em></strong></div>
        <div><span>DOMAIN WATER</span><strong>{diagnostic ? diagnostic.waterVolumeM3.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}<em> m³</em></strong></div>
      </div>
      <div className="preview-meta">
        <span>DT {diagnostic ? diagnostic.timeStepSeconds.toFixed(3) : '—'}s</span>
        <span>CELLS {status?.snapshot?.field.width && status.snapshot.field.height ? status.snapshot.field.width * status.snapshot.field.height : '—'}</span>
        <span>GPU {capabilities.maxTextureSize || '—'}</span>
      </div>
      <div className="preview-note">预览只用于方案草绘，不写入 Job、COG 或正式报告。</div>
      <button className="preview-formal" onClick={onFormal}>提交 ANUGA 正式模拟 <span>→</span></button>
    </section>
  )
}

export function PreviewCompatibilityDialog({
  names,
  onContinue,
  onCancel,
  onFormal,
}: {
  names: string[]
  onContinue: () => void
  onCancel: () => void
  onFormal: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="preview-compatibility" role="dialog" aria-modal="true" aria-labelledby="preview-compatibility-title">
        <header><div><span className="eyebrow preview-eyebrow">PREVIEW COMPATIBILITY</span><h2 id="preview-compatibility-title">部分水工要素未纳入预览</h2></div><button className="icon-button" onClick={onCancel} aria-label="关闭预览提示">×</button></header>
        <div className="preview-warning"><b>预览将使用基础栅格水动力</b><span>以下要素只会在 ANUGA 正式模拟中生效：</span></div>
        <ul>{names.map((name) => <li key={name}><i />{name}</li>)}</ul>
        <p>继续后结果仍可用于观察水流趋势，但不能用于判断这些结构的工程影响。</p>
        <footer><button className="secondary-button" onClick={onCancel}>返回编辑</button><button className="secondary-button" onClick={onFormal}>直接正式模拟</button><button className="run-button" onClick={onContinue}>继续预览</button></footer>
      </section>
    </div>
  )
}
