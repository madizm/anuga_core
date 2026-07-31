import type { Rainfall, RainfallPoint } from '../api/types'
import {
  DEFAULT_RAINFALL_POINT,
  rainfallSummary,
  rainfallValidationError,
} from './rainfall'

export function RainfallEditor({ rainfall, durationSeconds, onChange }: {
  rainfall: Rainfall
  durationSeconds: number
  onChange: (rainfall: Rainfall) => void
}) {
  const summary = rainfallSummary(rainfall, durationSeconds)
  const error = rainfallValidationError(rainfall, durationSeconds)
  const updatePoint = (index: number, patch: Partial<RainfallPoint>) => {
    onChange({
      ...rainfall,
      points: rainfall.points.map((point, pointIndex) => (
        pointIndex === index ? { ...point, ...patch } : point
      )),
    })
  }
  const maxMinutes = Math.floor(durationSeconds / 60)
  const lastTime = rainfall.points.at(-1)?.timeMinutes ?? -10
  const nextTime = Math.min(maxMinutes, Math.max(0, lastTime + 10))

  return (
    <div className="rainfall-editor">
      <div className="editor-title-row rainfall-switch">
        <div><strong>全区域阶梯雨型</strong><small>UNIFORM · STEPWISE</small></div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={rainfall.enabled}
            onChange={(event) => onChange({
              enabled: event.target.checked,
              points: event.target.checked && rainfall.points.length === 0
                ? [DEFAULT_RAINFALL_POINT]
                : rainfall.points,
            })}
          />
          <span /> 启用
        </label>
      </div>

      {!rainfall.enabled ? (
        <div className="rainfall-off">
          <i>☂</i><strong>降雨未参与计算</strong>
          <span>开启后将以 50 mm/h 示例雨强初始化。</span>
        </div>
      ) : <>
        {rainfall.points.length === 1 && rainfall.points[0].timeMinutes === 0 && rainfall.points[0].intensityMmPerHour === 50 && (
          <div className="rainfall-default-notice">默认示例值 50 mm/h，请确认后再运行</div>
        )}
        <RainfallChart rainfall={rainfall} durationSeconds={durationSeconds} />
        <div className="rainfall-metrics">
          <div><span>累计雨量</span><strong>{summary.cumulativeDepthMm.toFixed(1)}</strong><em>mm</em></div>
          <div><span>峰值雨强</span><strong>{summary.peakIntensityMmPerHour.toLocaleString()}</strong><em>mm/h</em></div>
          <div><span>模拟时长</span><strong>{Math.round(durationSeconds / 60)}</strong><em>min</em></div>
        </div>

        <div className="rainfall-table" role="table" aria-label="阶梯雨型节点">
          <div className="rainfall-row rainfall-head" role="row">
            <span>节点</span><span>时间 / min</span><span>雨强 / mm/h</span><span />
          </div>
          {rainfall.points.map((point, index) => (
            <div className="rainfall-row" role="row" key={index}>
              <b>{String(index + 1).padStart(2, '0')}</b>
              <input
                aria-label={`节点 ${index + 1} 时间（分钟）`}
                type="number"
                step="1"
                min="0"
                max={maxMinutes}
                value={point.timeMinutes}
                onChange={(event) => updatePoint(index, { timeMinutes: Number(event.target.value) })}
              />
              <input
                aria-label={`节点 ${index + 1} 雨强`}
                type="number"
                min="0"
                value={point.intensityMmPerHour}
                onChange={(event) => updatePoint(index, { intensityMmPerHour: Number(event.target.value) })}
              />
              <button
                aria-label={`删除节点 ${index + 1}`}
                onClick={() => onChange({ ...rainfall, points: rainfall.points.filter((_, pointIndex) => pointIndex !== index) })}
              >×</button>
            </div>
          ))}
        </div>
        <button
          className="add-rainfall-point"
          disabled={nextTime <= lastTime}
          onClick={() => onChange({
            ...rainfall,
            points: [...rainfall.points, { timeMinutes: nextTime, intensityMmPerHour: 0 }],
          })}
        >＋ 添加雨强节点</button>
        {error && <div className="inline-alert error">{error}</div>}
        <p className="field-note">节点雨强从该时刻持续到下一节点；最后节点持续到模拟结束。降雨无下渗损失。</p>
      </>}
    </div>
  )
}

function RainfallChart({ rainfall, durationSeconds }: {
  rainfall: Rainfall
  durationSeconds: number
}) {
  const width = 300
  const height = 110
  const pad = 12
  const durationMinutes = Math.max(durationSeconds / 60, 1)
  const peak = Math.max(1, ...rainfall.points.map((point) => point.intensityMmPerHour))
  const x = (minutes: number) => pad + (minutes / durationMinutes) * (width - pad * 2)
  const y = (intensity: number) => height - pad - (intensity / peak) * (height - pad * 2)
  const commands: string[] = []
  rainfall.points.forEach((point, index) => {
    const nextTime = rainfall.points[index + 1]?.timeMinutes ?? durationMinutes
    if (index === 0) commands.push(`M ${x(point.timeMinutes)} ${y(point.intensityMmPerHour)}`)
    commands.push(`H ${x(nextTime)}`)
    const next = rainfall.points[index + 1]
    if (next) commands.push(`V ${y(next.intensityMmPerHour)}`)
  })
  const path = commands.join(' ')

  return (
    <figure className="rainfall-chart">
      <figcaption><span>雨强过程</span><small>STEP HYETOGRAPH</small></figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="阶梯雨型预览">
        <path className="rain-grid" d={`M ${pad} ${height - pad} H ${width - pad} M ${pad} ${pad} V ${height - pad}`} />
        {path && <path className="rain-area" d={`${path} V ${height - pad} H ${pad} Z`} />}
        {path && <path className="rain-line" d={path} />}
      </svg>
      <div><span>0 MIN</span><span>{Math.round(durationMinutes)} MIN</span></div>
    </figure>
  )
}
