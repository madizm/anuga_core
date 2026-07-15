import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { SimulationFrame, SimulationJob } from '../api/types'

export function mergeFrames(
  existing: SimulationFrame[],
  incoming: SimulationFrame[],
): SimulationFrame[] {
  const byIndex = new Map(existing.map((frame) => [frame.frameIndex, frame]))
  for (const frame of incoming) byIndex.set(frame.frameIndex, frame)
  return [...byIndex.values()].sort((a, b) => a.frameIndex - b.frameIndex)
}

export function useJobPlayback(jobId: string | null) {
  const [job, setJob] = useState<SimulationJob | null>(null)
  const [frames, setFrames] = useState<SimulationFrame[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const catchUp = useCallback(async () => {
    if (!jobId) return
    const [nextJob, nextFrames] = await Promise.all([
      api.job(jobId),
      api.frames(jobId),
    ])
    if (!mounted.current) return
    setJob(nextJob)
    setFrames((current) => mergeFrames(current, nextFrames))
  }, [jobId])

  useEffect(() => {
    mounted.current = true
    setJob(null)
    setFrames([])
    setError(null)
    if (!jobId) return

    void catchUp().catch((reason: Error) => setError(reason.message))
    const events = new EventSource(`/api/jobs/${jobId}/events`)
    events.onopen = () => {
      setConnected(true)
      void catchUp().catch((reason: Error) => setError(reason.message))
    }
    events.onerror = () => setConnected(false)
    events.addEventListener('frame.ready', (event) => {
      const frame = JSON.parse((event as MessageEvent).data) as SimulationFrame
      setFrames((current) => mergeFrames(current, [frame]))
    })
    const receiveJob = (event: Event) => {
      const nextJob = JSON.parse((event as MessageEvent).data) as SimulationJob
      if ('id' in nextJob) setJob(nextJob)
      else void catchUp()
    }
    events.addEventListener('job.status', receiveJob)
    for (const eventName of ['job.completed', 'job.failed']) {
      events.addEventListener(eventName, (event) => {
        receiveJob(event)
        setConnected(false)
        events.close()
      })
    }
    return () => {
      mounted.current = false
      events.close()
      setConnected(false)
    }
  }, [catchUp, jobId])

  return { job, frames, connected, error, refresh: catchUp }
}
