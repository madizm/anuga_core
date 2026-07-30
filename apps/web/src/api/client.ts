import type { Polygon } from 'geojson'
import type { FeatureCollection } from 'geojson'
import type {
  ModelMetadata,
  SavedScenario,
  ScenarioPayload,
  SelectionStats,
  SimulationFrame,
  SimulationJob,
  SimulationArea,
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
  const text = await response.text()
  let body: Record<string, unknown>
  try {
    body = text ? JSON.parse(text) as Record<string, unknown> : {}
  } catch {
    if (!response.ok) throw new Error(text || `请求失败 (${response.status})`)
    throw new Error('服务器返回了无效 JSON')
  }
  if (!response.ok) {
    const detail = body.detail as string | { errors?: { message?: string }[] } | undefined
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
  resolveSimulationArea: (geometry: Polygon) =>
    request<SimulationArea>('/api/model/simulation-areas/resolve', {
      method: 'POST',
      body: JSON.stringify({ geometry }),
    }),
  simulationAreaGrid: (areaHash: string) =>
    request<FeatureCollection>(`/api/model/simulation-areas/${areaHash}/grid`),
  simulationArea: (areaHash: string) =>
    request<SimulationArea>(`/api/model/simulation-areas/${areaHash}`),
  resolveSelection: (areaHash: string, cellIds: string[], frictionScenario: string) =>
    request<SelectionStats>(`/api/model/simulation-areas/${areaHash}/selection/resolve`, {
      method: 'POST',
      body: JSON.stringify({ cellIds, frictionScenario }),
    }),
  scenarios: () => request<SavedScenario[]>('/api/scenarios'),
  scenario: (id: string) => request<SavedScenario>(`/api/scenarios/${id}`),
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
  jobs: (limit = 100) => request<SimulationJob[]>(`/api/jobs?limit=${limit}`),
  job: (id: string) => request<SimulationJob>(`/api/jobs/${id}`),
  frames: (id: string) => request<SimulationFrame[]>(`/api/jobs/${id}/frames`),
  framePoint: (jobId: string, frameIndex: number, longitude: number, latitude: number) =>
    request<FramePointValue>(
      `/api/jobs/${jobId}/frames/${frameIndex}/point?longitude=${longitude}&latitude=${latitude}`,
    ),
}
