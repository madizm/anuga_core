import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { FrictionScenario, SavedScenario, ScenarioPayload, ValidationResult } from './api/types'
import { InletPanel } from './inlets/InletPanel'
import { ResultWorkspace } from './jobs/ResultWorkspace'
import { isFourNeighbourConnected, useInletStore } from './inlets/inletStore'
import { LayerPanel } from './map/LayerPanel'
import { ModelMap } from './map/ModelMap'

export default function App() {
  const inlets = useInletStore((state) => state.inlets)
  const [name, setName] = useState('鲅鱼圈多入口推演')
  const [duration, setDuration] = useState(21_600)
  const [yieldstep, setYieldstep] = useState(300)
  const [friction, setFriction] = useState<FrictionScenario>('middle')
  const [saved, setSaved] = useState<SavedScenario | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [showCheck, setShowCheck] = useState(false)
  const [jobId, setJobId] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get('job')
  ))
  const [message, setMessage] = useState<string | null>(null)
  const model = useQuery({ queryKey: ['model'], queryFn: api.model })
  const grid = useQuery({ queryKey: ['model-grid'], queryFn: api.grid })

  const payload = (): ScenarioPayload => ({
    name,
    durationSeconds: duration,
    yieldstepSeconds: yieldstep,
    frictionScenario: friction,
    inlets,
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = saved
        ? await api.updateScenario(saved.id, payload())
        : await api.createScenario(payload())
      setSaved(result)
      setMessage('场景已保存')
      return result
    },
    onError: (error) => setMessage(error.message),
  })

  const validateAndOpen = async () => {
    try {
      const current = await saveMutation.mutateAsync()
      const result = await api.validateScenario(current.id)
      setValidation(result)
      setShowCheck(true)
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!saved || !validation) throw new Error('请先完成运行前检查')
      return api.createJob(saved.id, validation.warnings.length > 0)
    },
    onSuccess: (job) => {
      setJobId(job.id)
      window.history.replaceState(null, '', `?job=${job.id}`)
      setShowCheck(false)
      setMessage(`任务 ${job.id.slice(0, 8)} 已进入队列`)
    },
    onError: (error) => setMessage(error.message),
  })

  const enabled = inlets.filter((inlet) => inlet.enabled)
  const selectedCells = enabled.reduce((total, inlet) => total + inlet.cellIds.length, 0)
  const totalDischarge = enabled.reduce((total, inlet) => total + inlet.dischargeM3s, 0)
  const localReady = enabled.length > 0 && enabled.every(
    (inlet) => inlet.cellIds.length > 0 && isFourNeighbourConnected(inlet.cellIds) && inlet.dischargeM3s > 0,
  )

  if (jobId) {
    return <ResultWorkspace jobId={jobId} onClose={() => {
      setJobId(null)
      window.history.replaceState(null, '', window.location.pathname)
    }} />
  }

  return (
    <div className="app-frame">
      <header className="command-header">
        <div className="brand-block">
          <div className="brand-mark"><span /><span /><span /></div>
          <div>
            <span className="eyebrow">ANUGA / HYDRODYNAMIC OPERATIONS</span>
            <h1>鲅鱼圈 <b>洪水模拟调度台</b></h1>
          </div>
        </div>
        <div className="scenario-name">
          <span>SCENARIO</span>
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="场景名称" />
          <i className={saved ? 'saved' : ''}>{saved ? '已保存' : '草稿'}</i>
        </div>
        <div className="header-actions">
          <button className="secondary-button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? '保存中' : '保存场景'}
          </button>
          <button className="run-button" disabled={!localReady} onClick={validateAndOpen}>
            <span>▶</span> 运行模拟
          </button>
        </div>
      </header>

      <main className="workspace">
        <LayerPanel />
        <section className="map-stage">
          {grid.isError ? (
            <div className="map-error">无法加载固定模型网格</div>
          ) : (
            <ModelMap grid={grid.data} />
          )}
          {grid.isLoading && <div className="loading-grid"><span />正在装载 30 m 固定网格</div>}
        </section>
        <InletPanel frictionScenario={friction} />
      </main>

      <footer className="scenario-rail">
        <div className="rail-title">
          <span>SCENARIO PARAMETERS</span>
          <strong>推演控制</strong>
        </div>
        <label><span>模拟时长</span><div><input type="number" min="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><em>s</em></div></label>
        <label><span>输出步长</span><div><input type="number" min="1" value={yieldstep} onChange={(event) => setYieldstep(Number(event.target.value))} /><em>s</em></div></label>
        <label><span>曼宁场景</span><select value={friction} onChange={(event) => setFriction(event.target.value as FrictionScenario)}><option value="low">LOW · 低</option><option value="middle">MID · 中</option><option value="high">HIGH · 高</option></select></label>
        <div className="rail-metric"><span>启用入口</span><strong>{enabled.length}</strong><em>inlets</em></div>
        <div className="rail-metric"><span>选中网格</span><strong>{selectedCells}</strong><em>cells</em></div>
        <div className="rail-metric accent"><span>总流量</span><strong>{totalDischarge.toLocaleString()}</strong><em>m³/s</em></div>
        <div className="model-version"><i /> MODEL {model.data?.version ?? '--------'}<small>{model.data?.boundaryCondition ?? 'loading'}</small></div>
      </footer>

      {message && <button className="toast" onClick={() => setMessage(null)}>{message}<span>×</span></button>}
      {showCheck && validation && (
        <RunCheck
          validation={validation}
          onClose={() => setShowCheck(false)}
          onRun={() => runMutation.mutate()}
          running={runMutation.isPending}
        />
      )}
    </div>
  )
}

function RunCheck({ validation, onClose, onRun, running }: {
  validation: ValidationResult
  onClose: () => void
  onRun: () => void
  running: boolean
}) {
  const summary = validation.summary
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="run-check" role="dialog" aria-modal="true" aria-labelledby="run-check-title">
        <header>
          <div><span className="eyebrow">PRE-FLIGHT CHECK</span><h2 id="run-check-title">运行前检查</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className={validation.valid ? 'check-banner valid' : 'check-banner invalid'}>
          <strong>{validation.valid ? '配置可以运行' : '配置存在错误'}</strong>
          <span>{validation.valid ? '固定模型与入口参数校验已通过' : '请关闭窗口并修正标记项'}</span>
        </div>
        {summary && (
          <div className="check-metrics">
            <div><span>入口</span><strong>{summary.enabledInletCount}</strong></div>
            <div><span>总流量</span><strong>{summary.totalDischargeM3s}<em> m³/s</em></strong></div>
            <div><span>输入水量</span><strong>{summary.totalInputVolumeM3.toLocaleString()}<em> m³</em></strong></div>
            <div><span>输出帧</span><strong>{summary.frameCount}</strong></div>
          </div>
        )}
        <ul className="check-list">
          <li className="pass"><b>✓</b><span>外边界</span><strong>固定透射边界</strong></li>
          <li className="pass"><b>✓</b><span>模型版本</span><strong>{summary?.fixedModelVersion}</strong></li>
          {validation.warnings.map((warning) => <li className="warning" key={warning.code}><b>!</b><span>警告</span><strong>{warning.message}</strong></li>)}
          {validation.errors.map((error) => <li className="failure" key={error.code}><b>×</b><span>错误</span><strong>{error.message}</strong></li>)}
        </ul>
        <p className="confirmation-note">提交后将创建不可变任务快照。场景的后续修改不会影响该任务。</p>
        <footer><button className="secondary-button" onClick={onClose}>返回编辑</button><button className="run-button" disabled={!validation.valid || running} onClick={onRun}>{running ? '提交中…' : validation.warnings.length ? '确认警告并运行' : '确认并运行'}</button></footer>
      </section>
    </div>
  )
}
