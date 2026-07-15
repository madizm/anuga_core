import type { FeatureCollection } from 'geojson'
import type {
  ModelMetadata,
  SavedScenario,
  ScenarioPayload,
  SelectionStats,
  SimulationFrame,
  SimulationJob,
  FramePointValue,
  ValidationResult,
} from './types'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options?.headers,
    },
  })
  const body = await response.json()
  if (!response.ok) {
    const detail = body.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : detail?.errors?.[0]?.message ?? `请求失败 (${response.status})`,
    )
  }
  return body as T
}

export const api = {
  model: () => request<ModelMetadata>('/api/model'),
  grid: () => request<FeatureCollection>('/api/model/grid'),
  resolveSelection: (cellIds: string[], frictionScenario: string) =>
    request<SelectionStats>('/api/model/selection/resolve', {
      method: 'POST',
      body: JSON.stringify({ cellIds, frictionScenario }),
    }),
  createScenario: (payload: ScenarioPayload) =>
    request<SavedScenario>('/api/scenarios', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateScenario: (id: string, payload: ScenarioPayload) =>
    request<SavedScenario>(`/api/scenarios/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  validateScenario: (id: string) =>
    request<ValidationResult>(`/api/scenarios/${id}/validate`, {
      method: 'POST',
    }),
  createJob: (scenarioId: string, confirmWarnings: boolean) =>
    request<SimulationJob>(`/api/scenarios/${scenarioId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ confirmWarnings }),
    }),
  job: (id: string) => request<SimulationJob>(`/api/jobs/${id}`),
  frames: (id: string) => request<SimulationFrame[]>(`/api/jobs/${id}/frames`),
  framePoint: (jobId: string, frameIndex: number, longitude: number, latitude: number) =>
    request<FramePointValue>(
      `/api/jobs/${jobId}/frames/${frameIndex}/point?longitude=${longitude}&latitude=${latitude}`,
    ),
}
