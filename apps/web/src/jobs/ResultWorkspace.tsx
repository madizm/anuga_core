import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { FramePointValue, ResultQuantity } from '../api/types'
import { ResultMap } from './ResultMap'
import { useJobPlayback } from './useJobPlayback'

const QUANTITY_LABELS: Record<ResultQuantity, string> = {
  depth: '水深',
  stage: '水位',
  speed: '流速',
}

export function ResultWorkspace({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { job, frames, connected, error } = useJobPlayback(jobId)
  const [framePosition, setFramePosition] = useState(0)
  const [quantity, setQuantity] = useState<ResultQuantity>('depth')
  const [following, setFollowing] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [triple, setTriple] = useState(false)
  const [flowEnabled, setFlowEnabled] = useState(false)
  const [point, setPoint] = useState<FramePointValue | null>(null)
  const [displayedFrameIndex, setDisplayedFrameIndex] = useState<number | null>(null)
  const demProducts = useQuery({
    queryKey: ['dem-products'], queryFn: api.demProducts,
  })
  const demProduct = demProducts.data?.products.find(
    (item) => item.id === job?.demProductId,
  )
  const requested = frames[Math.min(framePosition, Math.max(frames.length - 1, 0))]
  const current = frames.find((frame) => frame.frameIndex === displayedFrameIndex) ?? requested
  const flowFrameIndex = requested?.frameIndex ?? null
  const flow = useQuery({
    queryKey: ['flow-field', jobId, flowFrameIndex] as const,
    queryFn: async ({ queryKey }) => {
      const frameIndex = queryKey[2]
      if (frameIndex == null) throw new Error('帧尚未发布')
      return { frameIndex, field: await api.flowField(jobId, frameIndex) }
    },
    enabled: flowEnabled && flowFrameIndex != null,
    staleTime: Infinity,
    // Keep showing the previous frame's field while the next one loads, so
    // the particle stream flows continuously instead of blinking per frame.
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    setDisplayedFrameIndex(null)
  }, [jobId])

  useEffect(() => {
    if (following && frames.length) setFramePosition(frames.length - 1)
  }, [following, frames.length])

  useEffect(() => {
    if (
      !playing
      || frames.length < 2
      || !requested
      || displayedFrameIndex !== requested.frameIndex
    ) return
    const timer = window.setTimeout(() => {
      setFramePosition((position) => {
        if (position < frames.length - 1) return position + 1
        setPlaying(false)
        return position
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [displayedFrameIndex, frames.length, playing, requested])

  const pointMutation = useMutation({
    mutationFn: ({ longitude, latitude }: { longitude: number; latitude: number }) =>
      api.framePoint(jobId, current.frameIndex, longitude, latitude),
    onSuccess: setPoint,
  })

  const progress = job?.frameCount
    ? Math.min(100, ((job.currentFrame + 1) / job.frameCount) * 100)
    : 0
  const statusLabel = useMemo(() => ({
    QUEUED: '排队中', PREPARING: '准备模型', RUNNING: '计算中', COMPLETED: '已完成', FAILED: '失败',
  }[job?.status ?? 'QUEUED']), [job?.status])
  const terminal = job?.status === 'COMPLETED' || job?.status === 'FAILED'

  return (
    <section className="result-workspace" aria-label="模拟结果播放">
      <header className="result-status">
        <button className="back-to-editor" onClick={onClose}>← 返回编辑</button>
        <div className="job-identity"><span>JOB</span><strong>{jobId.slice(0, 8).toUpperCase()}</strong></div>
        <div className="job-identity"><span>DEM</span><strong>{demProduct ? `${demProduct.cellSizeM} M` : '—'}</strong></div>
        <div className={`connection ${connected || terminal ? 'online' : ''}`}><i />{terminal ? '事件归档' : connected ? '实时连接' : '正在重连'}</div>
        <div className="progress-copy"><strong>{statusLabel}</strong><span>{job?.simulationTimeSeconds ?? 0} / {job?.scenarioSnapshot?.durationSeconds ?? '—'} s</span></div>
        <div className="job-progress"><i style={{ width: `${progress}%` }} /></div>
      </header>

      <div className="result-map-stage">
        {requested ? (
          <ResultMap
            frame={requested}
            bounds={job?.simulationAreaBounds ?? undefined}
            quantity={quantity}
            triple={triple}
            flowEnabled={flowEnabled}
            flowField={flow.data?.field}
            flowFrameIndex={flow.data?.frameIndex}
            demTilejsonUrl={demProduct?.demTilejsonUrl}
            terrainTilejsonUrl={demProduct?.terrainTilejsonUrl}
            onPoint={(longitude, latitude) => pointMutation.mutate({ longitude, latitude })}
            onFrameDisplayed={setDisplayedFrameIndex}
          />
        ) : (
          <div className="first-frame-wait"><i /><span>WAITING FOR FIRST COG</span><strong>等待首帧栅格发布</strong><small>模拟正在准备固定网格与 ANUGA Domain</small></div>
        )}
        {error && <div className="result-error">{error}</div>}
        {flowEnabled && flow.isError && <div className="result-error">{flow.error.message}</div>}
        {job?.status === 'FAILED' && <div className="result-error">{job.errorCode}: {job.errorMessage}</div>}
        {point && (
          <div className="point-readout">
            <button onClick={() => setPoint(null)}>×</button>
            <span>FRAME SAMPLE · T+{point.timeSeconds}s</span>
            <div><b>{formatValue(point.depthM)}</b><em>m</em><small>水深</small></div>
            <div><b>{formatValue(point.stageM)}</b><em>m</em><small>水位</small></div>
            <div><b>{formatValue(point.speedMps)}</b><em>m/s</em><small>流速</small></div>
          </div>
        )}
      </div>

      <footer className="playback-deck">
        <div className="quantity-switch" role="group" aria-label="结果物理量">
          {(Object.keys(QUANTITY_LABELS) as ResultQuantity[]).map((item) => (
            <button key={item} className={quantity === item && !triple ? 'active' : ''} onClick={() => { setTriple(false); setQuantity(item) }}>
              <span>{QUANTITY_LABELS[item]}</span><small>{item.toUpperCase()}</small>
            </button>
          ))}
          <button className={triple ? 'active' : ''} onClick={() => setTriple((value) => !value)}><span>三联</span><small>SYNC</small></button>
          <button
            className={flowEnabled ? 'active flow-toggle' : 'flow-toggle'}
            aria-pressed={flowEnabled}
            aria-label={flowEnabled ? '关闭流向' : '显示流向'}
            onClick={() => setFlowEnabled((value) => !value)}
          ><span>{flow.isFetching ? '载入中' : '流向'}</span><small>FLOW</small></button>
        </div>
        <button className="play-button" disabled={frames.length < 2} onClick={() => { setFollowing(false); setPlaying((value) => !value) }} aria-label={playing ? '暂停' : '播放'}>
          {playing ? 'Ⅱ' : '▶'}
        </button>
        <div className="timeline-block">
          <div className="timeline-copy"><span>T+{current?.timeSeconds ?? 0}s</span><small>{frames.length} / {job?.frameCount ?? '—'} FRAMES</small></div>
          <input
            aria-label="模拟时间轴"
            type="range"
            min={0}
            max={Math.max(frames.length - 1, 0)}
            value={Math.min(framePosition, Math.max(frames.length - 1, 0))}
            disabled={!frames.length}
            onChange={(event) => { setFollowing(false); setPlaying(false); setFramePosition(Number(event.target.value)) }}
          />
          <div className="frame-ticks"><span>0</span><span>{current ? `${current.timeSeconds}s` : 'WAIT'}</span><span>{job?.scenarioSnapshot?.durationSeconds ?? '—'}s</span></div>
        </div>
        <label className="follow-latest"><input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} /><span />跟随最新帧</label>
        <div className="frame-vitals"><span>MAX DEPTH<strong>{current?.maximumDepthM.toFixed(2) ?? '—'} m</strong></span><span>MAX SPEED<strong>{current?.maximumSpeedMps.toFixed(2) ?? '—'} m/s</strong></span><span>WET AREA<strong>{current ? current.wetAreaM2.toLocaleString() : '—'} m²</strong></span></div>
      </footer>
    </section>
  )
}

function formatValue(value: number | null) {
  return value == null ? 'DRY' : value.toFixed(2)
}
