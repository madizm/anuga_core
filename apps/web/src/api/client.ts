import type { LineString, Polygon } from 'geojson'
import type { FeatureCollection } from 'geojson'
import type {
  DemProductCatalog,
  ElevationProfile,
  SavedScenario,
  ScenarioPayload,
  SelectionStats,
  SimulationFrame,
  SimulationJob,
  SimulationArea,
  FramePointValue,
  FlowField,
  HydraulicFeature,
  HydraulicMeshPreview,
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

async function flowField(jobId: string, frameIndex: number): Promise<FlowField> {
  const response = await fetch(`/api/jobs/${jobId}/frames/${frameIndex}/flow`)
  if (!response.ok) {
    let detail = `无法加载流向场 (${response.status})`
    try {
      const body = await response.json() as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // Preserve the stable fallback when an intermediary returns non-JSON.
    }
    throw new Error(detail)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength < 44) throw new Error('流向场数据不完整')
  const view = new DataView(buffer)
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  const version = view.getUint16(4, true)
  const width = view.getUint16(6, true)
  const height = view.getUint16(8, true)
  if (magic !== 'BQFV' || (version !== 1 && version !== 2 && version !== 3) || width === 0 || height === 0) {
    throw new Error('流向场格式不受支持')
  }
  // v3 packs fp16 RGBA texels (2 bytes × 4 channels); v1/v2 use float32.
  const bytesPerCell = version === 3 ? 8 : (version === 2 ? 3 : 2) * 4
  const expectedBytes = 44 + width * height * bytesPerCell
  if (buffer.byteLength !== expectedBytes) throw new Error('流向场数据不完整')
  const bounds: [number, number, number, number] = [
    view.getFloat64(12, true), view.getFloat64(20, true),
    view.getFloat64(28, true), view.getFloat64(36, true),
  ]
  if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new Error('流向场范围无效')
  }
  const cellCount = width * height
  if (version === 3) {
    // Texels upload verbatim; only the particle layer needs a CPU-side
    // float32 copy of the velocity channels.
    const texels = new Uint16Array(buffer.slice(44))
    const vectors = new Float32Array(cellCount * 2)
    for (let cell = 0; cell < cellCount; cell += 1) {
      vectors[cell * 2] = decodeFloat16(texels[cell * 4])
      vectors[cell * 2 + 1] = decodeFloat16(texels[cell * 4 + 1])
    }
    return { width, height, bounds, vectors, depths: null, texels }
  }
  const packed = new Float32Array(buffer.slice(44))
  if (version === 1) {
    return { width, height, bounds, vectors: packed, depths: null, texels: null }
  }
  // v2 interleaves (depth, u, v) per cell; split the planes so consumers of
  // the legacy velocity layout keep working unchanged.
  const vectors = new Float32Array(cellCount * 2)
  const depths = new Float32Array(cellCount)
  for (let cell = 0; cell < cellCount; cell += 1) {
    depths[cell] = packed[cell * 3]
    vectors[cell * 2] = packed[cell * 3 + 1]
    vectors[cell * 2 + 1] = packed[cell * 3 + 2]
  }
  return { width, height, bounds, vectors, depths, texels: null }
}

/** Decodes one IEEE 754 binary16 value. */
export function decodeFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x03ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

export const api = {
  demProducts: () => request<DemProductCatalog>('/api/dem-products'),
  resolveSimulationArea: (productId: string, geometry: Polygon) =>
    request<SimulationArea>(`/api/dem-products/${productId}/simulation-areas/resolve`, {
      method: 'POST',
      body: JSON.stringify({ geometry }),
    }),
  simulationAreaGrid: (productId: string, areaHash: string) =>
    request<FeatureCollection>(`/api/dem-products/${productId}/simulation-areas/${areaHash}/grid`),
  simulationArea: (productId: string, areaHash: string) =>
    request<SimulationArea>(`/api/dem-products/${productId}/simulation-areas/${areaHash}`),
  elevationProfile: (productId: string, areaHash: string, geometry: LineString) =>
    request<ElevationProfile>(`/api/dem-products/${productId}/simulation-areas/${areaHash}/elevation-profile`, {
      method: 'POST',
      body: JSON.stringify({ geometry }),
    }),
  hydraulicMeshPreview: (productId: string, areaHash: string, hydraulicFeatures: HydraulicFeature[]) =>
    request<HydraulicMeshPreview>(`/api/dem-products/${productId}/simulation-areas/${areaHash}/hydraulic-mesh-preview`, {
      method: 'POST',
      body: JSON.stringify({ hydraulicFeatures }),
    }),
  resolveSelection: (productId: string, areaHash: string, cellIds: string[], frictionScenario: string) =>
    request<SelectionStats>(`/api/dem-products/${productId}/simulation-areas/${areaHash}/selection/resolve`, {
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
  flowField,
}
