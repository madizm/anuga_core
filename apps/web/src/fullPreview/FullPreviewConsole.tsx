import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

const PRESETS = [50, 80, 100]

export function FullPreviewConsole() {
  const navigate = useNavigate()
  const [rainfall, setRainfall] = useState(() => {
    const value = Number(
      new URLSearchParams(window.location.search).get('rainfallMm')
    )
    return Number.isFinite(value) && value > 0 ? value : 80
  })
  const [confirming, setConfirming] = useState(false)
  const config = useQuery({
    queryKey: ['full-preview-config'], queryFn: api.fullPreviewConfig,
  })
  const history = useQuery({
    queryKey: ['full-previews'], queryFn: () => api.fullPreviews(30),
    refetchInterval: (query) => query.state.data?.some((item) => (
      !['COMPLETED', 'FAILED'].includes(item.status)
    )) ? 2_000 : false,
  })
  const create = useMutation({
    mutationFn: () => api.createFullPreview(rainfall),
    onSuccess: (job) => navigate(`/previews/${job.id}`),
  })
  const coefficient = config.data?.assumptionsProfile.runoffCoefficient ?? 1
  const effective = rainfall * coefficient

  return (
    <main className="full-preview-console">
      <header className="full-preview-header">
        <div className="brand-block">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><span className="eyebrow">REGIONAL TERRAIN STORAGE OPERATIONS</span><h1>鲅鱼圈 <b>全域雨洪快览</b></h1></div>
        </div>
        <nav className="workspace-modes" aria-label="工作模式">
          <button onClick={() => navigate('/workbench/local')}>局部水动力</button>
          <button className="active">全域雨洪快览</button>
        </nav>
        <div className="authority-stamp">NON-AUTHORITATIVE <small>非权威地形蓄水预览</small></div>
      </header>

      <section className="full-preview-body">
        <aside className="full-preview-inputs">
          <span className="section-index">01 / RAINFALL INPUT</span>
          <h2>24 小时累计降雨</h2>
          <p>单一均匀累计雨量，经固定损失配置换算为有效降雨。</p>
          <div className="rainfall-presets">
            {PRESETS.map((value) => (
              <button key={value} className={rainfall === value ? 'active' : ''} onClick={() => setRainfall(value)}>{value}<small>mm</small></button>
            ))}
          </div>
          <label className="regional-rain-input">
            <span>自定义累计降雨</span>
            <div><input type="number" min={0.1} max={500} value={rainfall} onChange={(event) => setRainfall(Number(event.target.value))} /><em>MM / 24H</em></div>
          </label>

          <div className="assumption-card">
            <span className="section-index">02 / MODEL ASSUMPTIONS</span>
            <h3>{config.data?.assumptionsProfile.name ?? '载入配置…'}</h3>
            <dl>
              <div><dt>有效降雨</dt><dd>{effective.toFixed(1)} mm</dd></div>
              <div><dt>径流系数</dt><dd>{coefficient.toFixed(2)}</dd></div>
              <div><dt>空间分布</dt><dd>全域均匀</dd></div>
              <div><dt>排水系统</dt><dd>未纳入</dd></div>
              <div><dt>DEM</dt><dd>5 m · {config.data?.datasetVersion ?? '—'}</dd></div>
              <div><dt>预处理缓存</dt><dd className={config.data?.cacheStatus === 'READY' ? 'ready' : 'missing'}>{config.data?.cacheStatus ?? '检查中'}</dd></div>
            </dl>
          </div>
          {!config.data?.available && config.isSuccess && (
            <div className="regional-warning">全域缓存或固定范围尚未配置，当前不能提交生产任务。</div>
          )}
          <button className="regional-submit" disabled={!config.data?.available || rainfall <= 0 || rainfall > 500} onClick={() => setConfirming(true)}>生成全域快览 <span>→</span></button>
          {create.error && <div className="regional-warning">{create.error.message}</div>}
        </aside>

        <section className="regional-overview">
          <div className="regional-orbit" aria-hidden="true"><i /><i /><i /><b>BYQ</b></div>
          <span className="eyebrow">FIXED REGIONAL DOMAIN</span>
          <h2>一次参数，识别全域<br /><b>潜在积水洼地</b></h2>
          <p>服务器 CPU 使用预处理的洼地层级计算有限雨量蓄水、溢流和合并，发布一张潜在最大水深 COG。</p>
          <div className="regional-capabilities"><span>NO VELOCITY</span><span>NO ANIMATION</span><span>MASS CONSERVING</span></div>
        </section>

        <aside className="full-preview-history">
          <span className="section-index">RECENT PREVIEWS</span>
          <h2>快览任务</h2>
          <div className="regional-history-list">
            {history.data?.map((job) => (
              <button key={job.id} onClick={() => navigate(`/previews/${job.id}`)}>
                <i className={job.status.toLowerCase()} />
                <span><strong>{job.rainfallDepthMm} mm / 24 h</strong><small>{new Date(job.createdAt).toLocaleString()}</small></span>
                <em>{job.status === 'COMPLETED' && job.result ? `${(job.result.wetAreaM2 / 1e6).toFixed(2)} km²` : statusLabel(job.status)}</em>
              </button>
            ))}
            {!history.data?.length && <p className="regional-empty">尚无全域快览任务</p>}
          </div>
        </aside>
      </section>

      <footer className="regional-disclaimer">地形蓄水 / 溢流快览 · 不包含动量、流速、管网、桥涵和动态潮位 · 不得用于工程决策</footer>

      {confirming && (
        <div className="modal-backdrop">
          <section className="regional-confirm" role="dialog" aria-modal="true">
            <span className="section-index">RUN CHECK</span><h2>确认全域快览</h2>
            <div className="regional-confirm-rain"><strong>{rainfall}</strong><em>MM / 24H</em><span>有效降雨 {effective.toFixed(1)} mm</span></div>
            <ul><li>范围 <b>{config.data?.domainId}</b></li><li>预览配置 <b>{config.data?.assumptionsProfile.id}</b></li><li>输出 <b>潜在最大水深 COG</b></li><li>缓存 <b>{config.data?.cacheStatus}</b></li></ul>
            <p>结果为非权威地形蓄水/溢流预览，不能代替 ANUGA 正式水动力模拟。</p>
            <footer><button className="secondary-button" onClick={() => setConfirming(false)}>返回修改</button><button className="regional-submit" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? '提交中…' : '确认并提交'}</button></footer>
          </section>
        </div>
      )}
    </main>
  )
}

function statusLabel(status: string) {
  return ({ QUEUED: '排队中', PREPARING: '准备地形', SOLVING: '求解中', PUBLISHING: '发布中', FAILED: '失败' } as Record<string, string>)[status] ?? status
}
