import { useEffect, useMemo, useState } from 'react'
import type { SimulationJob } from '../api/types'

interface JobHistoryProps {
  jobs: SimulationJob[]
  loading: boolean
  error: string | null
  onClose: () => void
  onOpen: (id: string) => void
  onRefresh: () => void
}

type JobFilter = 'all' | 'active' | 'completed' | 'failed'

const STATUS_LABEL: Record<SimulationJob['status'], string> = {
  QUEUED: '排队中',
  PREPARING: '准备中',
  RUNNING: '计算中',
  COMPLETED: '已完成',
  FAILED: '失败',
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function isActive(job: SimulationJob) {
  return job.status === 'QUEUED' || job.status === 'PREPARING' || job.status === 'RUNNING'
}

function progress(job: SimulationJob) {
  if (job.status === 'COMPLETED') return 100
  if (!job.frameCount || job.currentFrame < 0) return 0
  return Math.min(100, ((job.currentFrame + 1) / job.frameCount) * 100)
}

function formattedDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormatter.format(date)
}

export function JobHistory({ jobs, loading, error, onClose, onOpen, onRefresh }: JobHistoryProps) {
  const [filter, setFilter] = useState<JobFilter>('all')
  const counts = useMemo(() => ({
    all: jobs.length,
    active: jobs.filter(isActive).length,
    completed: jobs.filter((job) => job.status === 'COMPLETED').length,
    failed: jobs.filter((job) => job.status === 'FAILED').length,
  }), [jobs])
  const visibleJobs = useMemo(() => jobs.filter((job) => {
    if (filter === 'active') return isActive(job)
    if (filter === 'completed') return job.status === 'COMPLETED'
    if (filter === 'failed') return job.status === 'FAILED'
    return true
  }), [filter, jobs])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="history-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside className="scenario-history job-history" role="dialog" aria-modal="true" aria-labelledby="job-history-title">
        <header>
          <div>
            <span className="eyebrow">SIMULATION RUNS</span>
            <h2 id="job-history-title">运行记录</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭运行记录">×</button>
        </header>
        <div className="job-filters" role="group" aria-label="任务状态筛选">
          {(['all', 'active', 'completed', 'failed'] as JobFilter[]).map((item) => (
            <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>
              <span>{{ all: '全部', active: '进行中', completed: '已完成', failed: '失败' }[item]}</span>
              <strong>{counts[item]}</strong>
            </button>
          ))}
          <button className="job-refresh" onClick={onRefresh} disabled={loading} aria-label="刷新运行记录">↻</button>
        </div>
        <div className="history-list job-list" aria-live="polite">
          {loading && jobs.length === 0 && <div className="history-state"><i />正在读取任务记录</div>}
          {error && <div className="history-state error"><strong>读取失败</strong><span>{error}</span><button onClick={onRefresh}>重试</button></div>}
          {!loading && !error && jobs.length === 0 && (
            <div className="history-state empty"><b>00</b><strong>暂无运行记录</strong><span>完成场景配置并运行模拟后，任务会永久显示在这里。</span></div>
          )}
          {!loading && !error && jobs.length > 0 && visibleJobs.length === 0 && (
            <div className="history-state empty compact"><strong>当前筛选下没有任务</strong><button onClick={() => setFilter('all')}>查看全部</button></div>
          )}
          {visibleJobs.map((job) => {
            const value = progress(job)
            return (
              <article className={`job-card status-${job.status.toLowerCase()}`} key={job.id}>
                <div className="job-card-top">
                  <div className="job-status"><i /><span>{STATUS_LABEL[job.status]}</span></div>
                  <time>{formattedDate(job.createdAt)}</time>
                </div>
                <div className="job-card-title">
                  <strong>{job.scenarioSnapshot.name || '未命名场景'}</strong>
                  <small>JOB / {job.id.slice(0, 8).toUpperCase()}</small>
                </div>
                <div className="job-progress-line" aria-label={`任务进度 ${Math.round(value)}%`}><i style={{ width: `${value}%` }} /></div>
                <div className="job-card-metrics">
                  <div><span>FRAME</span><strong>{Math.max(job.currentFrame + 1, 0)} / {job.frameCount}</strong></div>
                  <div><span>SIM TIME</span><strong>{job.simulationTimeSeconds}<em> s</em></strong></div>
                  <div><span>MAX DEPTH</span><strong>{job.maximumDepthM == null ? '—' : job.maximumDepthM.toFixed(2)}<em> m</em></strong></div>
                </div>
                {job.status === 'FAILED' && <p className="job-failure" title={job.errorMessage ?? undefined}>{job.errorCode ?? 'WORKER_FAILED'} · {job.errorMessage ?? '任务执行失败'}</p>}
                <button className="job-open" onClick={() => onOpen(job.id)}>{isActive(job) ? '查看实时结果' : job.status === 'FAILED' ? '查看任务详情' : '回看结果'} <span>→</span></button>
              </article>
            )
          })}
        </div>
        <footer><span>{counts.active > 0 ? `${counts.active} 个任务正在执行，列表自动刷新` : '任务按创建时间倒序排列'}</span><kbd>ESC</kbd><span>关闭</span></footer>
      </aside>
    </div>
  )
}
