import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { FullPreviewJob } from '../api/types'

export function useFullPreviewJob(previewId: string) {
  const [job, setJob] = useState<FullPreviewJob | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.fullPreview(previewId).then((value) => {
      if (active) setJob(value)
    }).catch((reason: Error) => {
      if (active) setError(reason.message)
    })
    const events = new EventSource(`/api/full-previews/${previewId}/events`)
    const receive = (event: MessageEvent) => {
      if (!active) return
      setConnected(true)
      setJob(JSON.parse(event.data) as FullPreviewJob)
    }
    events.addEventListener('preview.status', receive as EventListener)
    events.addEventListener('preview.completed', receive as EventListener)
    events.addEventListener('preview.failed', receive as EventListener)
    events.onerror = () => {
      if (active) setConnected(false)
    }
    return () => {
      active = false
      events.close()
    }
  }, [previewId])

  return { job, connected, error }
}
