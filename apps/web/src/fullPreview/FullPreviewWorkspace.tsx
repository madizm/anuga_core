import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { FullPreviewPoint } from '../api/types'
import { FullPreviewMap } from './FullPreviewMap'
import { useFullPreviewJob } from './useFullPreviewJob'

const THRESHOLDS = [0.05, 0.15, 0.30, 0.50, 1.00]

export function FullPreviewWorkspace({
  previewId, onClose,
}: {
  previewId: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { job, connected, error } = useFullPreviewJob(previewId)
  const [threshold, setThreshold] = useState(0.05)
  const [point, setPoint] = useState<FullPreviewPoint | null>(null)
  const [compareId, setCompareId] = useState('')
  const history = useQuery({
    queryKey: ['full-previews'], queryFn: () => api.fullPreviews(100),
  })
  const compareJob = history.data?.find((item) => (
    item.id === compareId
    && item.compatibilityVersion === job?.compatibilityVersion
  )) ?? null
  const compatibleJobs = history.data?.filter((item) => (
    item.id !== job?.id
    && item.status === 'COMPLETED'
    && item.compatibilityVersion === job?.compatibilityVersion
  )) ?? []
  const pointQuery = useMutation({
    mutationFn: ({ longitude, latitude }: { longitude: number; latitude: number }) => (
      api.fullPreviewPoint(previewId, longitude, latitude)
    ),
    onSuccess: setPoint,
  })
  const download = useMutation({
    mutationFn: () => api.fullPreviewDownload(previewId),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
  })
  const status = useMemo(() => statusLabel(job?.status), [job?.status])

  if (!job) {
    return <div className="regional-loading"><i /><span>{error ?? '载入全域快览任务…'}</span></div>
  }

  const result = job.status === 'COMPLETED' ? job.result : null
  return (
    <main className="full-preview-workspace">
      <header className="regional-result-header">
        <button className="back-to-editor" onClick={onClose}>← 返回快览台</button>
        <div className="job-identity"><span>PREVIEW</span><strong>{job.id.slice(0, 8).toUpperCase()}</strong></div>
        <div className="job-identity rain-job"><span>RAIN</span><strong>{job.rainfallDepthMm} MM / 24 H</strong></div>
        <div className="authority-stamp compact">NON-AUTHORITATIVE</div>
        <div className={`connection ${connected || ['COMPLETED', 'FAILED'].includes(job.status) ? 'online' : ''}`}><i />{status}</div>
      </header>

      {result ? (
        <div className="regional-result-body">
          <FullPreviewMap
            job={job}
            threshold={threshold}
            point={point}
            compareJob={compareJob}
            onPoint={(longitude, latitude) => pointQuery.mutate({ longitude, latitude })}
          />
          <aside className="impact-panel">
            <span className="section-index">IMPACT SUMMARY</span>
            <h2>潜在积水统计</h2>
            <div className="impact-hero"><span>MAX DEPTH</span><strong>{result.maximumDepthM.toFixed(2)}<em> m</em></strong></div>
            <dl className="preview-assumptions"><div><dt>有效降雨</dt><dd>{job.effectiveRainfallDepthMm.toFixed(1)} mm</dd></div><div><dt>径流系数</dt><dd>{job.runoffCoefficient.toFixed(2)}</dd></div><div><dt>固定假设</dt><dd>{job.assumptionsProfileId}</dd></div><div><dt>兼容版本</dt><dd>{job.compatibilityVersion.slice(0, 8)}</dd></div></dl>
            <div className="threshold-selector" role="radiogroup" aria-label="最小显示水深">
              {THRESHOLDS.map((value) => (
                <button key={value} className={threshold === value ? 'active' : ''} onClick={() => setThreshold(value)}>
                  <span>≥ {value.toFixed(2)} m</span>
                  <strong>{formatArea(result.thresholdAreasM2[value.toFixed(2)] ?? 0)}</strong>
                </button>
              ))}
            </div>
            <div className="water-balance"><span>WATER BALANCE</span><dl><div><dt>输入</dt><dd>{formatVolume(result.inputVolumeM3)}</dd></div><div><dt>蓄存</dt><dd>{formatVolume(result.retainedVolumeM3)}</dd></div><div><dt>出流</dt><dd>{formatVolume(result.outflowVolumeM3)}</dd></div><div><dt>误差</dt><dd>{result.massBalanceErrorM3.toExponential(2)} m³</dd></div></dl></div>
            <label className="compare-select"><span>场景叠加比较</span><select value={compareId} onChange={(event) => setCompareId(event.target.value)}><option value="">关闭比较</option>{compatibleJobs.map((item) => <option key={item.id} value={item.id}>{item.rainfallDepthMm} mm · {item.id.slice(0, 8)} · {item.compatibilityVersion.slice(0, 8)}</option>)}</select><small>仅列出同数据集、范围、缓存及假设版本的结果。主场景显示蓝色，比较场景显示青绿色叠加。</small></label>
            <div className="result-actions"><button onClick={() => download.mutate()}>下载 COG</button><button onClick={() => navigate(`/workbench/regional-preview?rainfallMm=${job.rainfallDepthMm}`)}>基于此值再次运行</button></div>
            <p className="impact-note">非权威地形蓄水快览，不用于工程决策；不包含流速、洪峰传播、排水管网和动态潮位。</p>
          </aside>
        </div>
      ) : (
        <section className="regional-job-running">
          <div className="regional-progress-orbit"><i /><i /><b>{phaseCode(job.status)}</b></div>
          <span className="section-index">FILL–SPILL PREVIEW</span>
          <h1>{status}</h1>
          <p>{phaseDescription(job.status)}</p>
          <dl><div><dt>累计降雨</dt><dd>{job.rainfallDepthMm} mm</dd></div><div><dt>有效降雨</dt><dd>{job.effectiveRainfallDepthMm.toFixed(1)} mm</dd></div><div><dt>径流系数</dt><dd>{job.runoffCoefficient.toFixed(2)}</dd></div><div><dt>固定假设</dt><dd>{job.assumptionsProfileId}</dd></div><div><dt>预处理缓存</dt><dd>{job.cacheHit == null ? '等待确认' : job.cacheHit ? '已命中' : '未命中'}</dd></div><div><dt>任务 ID</dt><dd>{job.id}</dd></div></dl>
          {job.status === 'FAILED' && <div className="regional-warning">{job.errorCode}: {job.errorMessage}</div>}
        </section>
      )}
      <footer className="regional-disclaimer">NON-AUTHORITATIVE · TERRAIN STORAGE PREVIEW · NOT FOR ENGINEERING DECISIONS</footer>
    </main>
  )
}

function statusLabel(status?: string) {
  return ({ QUEUED: '等待高资源计算节点', PREPARING: '加载全域地形与洼地层级', SOLVING: '计算蓄水、溢流与合并', PUBLISHING: '生成并校验最大水深 COG', COMPLETED: '快览结果已发布', FAILED: '快览任务失败' } as Record<string, string>)[status ?? ''] ?? '读取状态'
}
function phaseDescription(status: string) {
  return ({ QUEUED: '任务已经进入全域预览串行队列。', PREPARING: '正在读取版本化预处理缓存。', SOLVING: '正在洼地节点上执行有限水量求解。', PUBLISHING: '结果尚未原子发布，地图不会展示半成品。', FAILED: '请检查固定范围、缓存版本和 Worker 日志。' } as Record<string, string>)[status] ?? ''
}
function phaseCode(status: string) { return ({ QUEUED: 'Q', PREPARING: '01', SOLVING: '02', PUBLISHING: '03', FAILED: '!' } as Record<string, string>)[status] ?? '✓' }
function formatArea(area: number) { return area >= 1e6 ? `${(area / 1e6).toFixed(2)} km²` : `${area.toLocaleString()} m²` }
function formatVolume(volume: number) { return `${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³` }
