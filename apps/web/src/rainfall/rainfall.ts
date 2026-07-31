import type { Rainfall, RainfallPoint } from '../api/types'

export const DISABLED_RAINFALL: Rainfall = { enabled: false, points: [] }
export const DEFAULT_RAINFALL_POINT: RainfallPoint = {
  timeMinutes: 0,
  intensityMmPerHour: 50,
}

export interface RainfallInterval {
  startMinutes: number
  endMinutes: number
  intensityMmPerHour: number
  depthMm: number
}

export function rainfallIntervals(
  rainfall: Rainfall,
  durationSeconds: number,
): RainfallInterval[] {
  if (!rainfall.enabled) return []
  const endMinutes = durationSeconds / 60
  return rainfall.points.map((point, index) => {
    const next = rainfall.points[index + 1]
    const intervalEnd = next?.timeMinutes ?? endMinutes
    const durationHours = Math.max(0, intervalEnd - point.timeMinutes) / 60
    return {
      startMinutes: point.timeMinutes,
      endMinutes: intervalEnd,
      intensityMmPerHour: point.intensityMmPerHour,
      depthMm: point.intensityMmPerHour * durationHours,
    }
  })
}

export function rainfallSummary(rainfall: Rainfall, durationSeconds: number) {
  const intervals = rainfallIntervals(rainfall, durationSeconds)
  return {
    cumulativeDepthMm: intervals.reduce((sum, item) => sum + item.depthMm, 0),
    peakIntensityMmPerHour: rainfall.enabled
      ? Math.max(0, ...rainfall.points.map((point) => point.intensityMmPerHour))
      : 0,
    pointCount: rainfall.enabled ? rainfall.points.length : 0,
  }
}

export function rainfallValidationError(
  rainfall: Rainfall,
  durationSeconds: number,
): string | null {
  if (!rainfall.enabled) return null
  if (!rainfall.points.length) return '至少需要一个雨型节点'
  if (rainfall.points[0].timeMinutes !== 0) return '首个节点必须从 0 分钟开始'
  let previous = -1
  for (const point of rainfall.points) {
    if (!Number.isInteger(point.timeMinutes) || point.timeMinutes < 0) {
      return '节点时间必须为非负整数分钟'
    }
    if (point.timeMinutes <= previous) return '节点时间必须严格递增'
    if (point.timeMinutes * 60 > durationSeconds) return '节点不能超过模拟时长'
    if (!Number.isFinite(point.intensityMmPerHour) || point.intensityMmPerHour < 0) {
      return '雨强必须为有限非负数'
    }
    previous = point.timeMinutes
  }
  return null
}

export function hasEffectiveRainfall(rainfall: Rainfall, durationSeconds: number) {
  return rainfallValidationError(rainfall, durationSeconds) === null
    && rainfall.enabled
    && rainfallIntervals(rainfall, durationSeconds).some(
      (item) => item.depthMm > 0,
    )
}
