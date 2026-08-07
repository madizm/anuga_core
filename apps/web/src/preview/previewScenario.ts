import type { HydraulicFeature, Rainfall, ScenarioPayload } from '../api/types'

export function rainfallRateMps(rainfall: Rainfall, timeSeconds: number): number {
  if (!rainfall.enabled || rainfall.points.length === 0) return 0
  const minutes = Math.max(0, timeSeconds) / 60
  let intensity = rainfall.points[0].intensityMmPerHour
  for (const point of rainfall.points) {
    if (point.timeMinutes > minutes) break
    intensity = point.intensityMmPerHour
  }
  return intensity / 1000 / 3600
}

export interface PreviewCompatibility {
  supported: boolean
  ignoredFeatures: HydraulicFeature[]
  messages: string[]
}

/** Phase 4 deliberately exposes unsupported structures instead of ignoring them silently. */
export function previewCompatibility(scenario: ScenarioPayload): PreviewCompatibility {
  const ignoredFeatures = scenario.hydraulicFeatures.filter((feature) => feature.enabled)
  return {
    supported: ignoredFeatures.length === 0,
    ignoredFeatures,
    messages: ignoredFeatures.map((feature) => `${feature.name}（${featureLabel(feature.type)}）`),
  }
}

function featureLabel(type: HydraulicFeature['type']) {
  return {
    levee: '堤防',
    simpleChannel: '简化河道',
    engineeringChannel: '断面河道',
    culvert: '涵洞',
    bridge: '桥梁',
    drainageOutlet: '排水口',
    breach: '溃口',
  }[type]
}
