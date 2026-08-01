/**
 * Shared tunables for the water ripple layer. The layer reads this object on
 * every render, so the development debug panel can mutate it live.
 */
export interface WaterRippleParams {
  /** Peak opacity of the additive specular highlight. */
  specularStrength: number
  /** Broad brightening where ripples tilt toward the sun. */
  sheenStrength: number
  /** Extra high-frequency sparkle on fast water. */
  sparkleStrength: number
  /** Overall normal perturbation scale. */
  amplitude: number
  /** Wavelength of the large wave train, in grid cells. */
  waveLengthLarge: number
  /** Wavelength of the fine wave train, in grid cells. */
  waveLengthSmall: number
  /** Ripple pattern advection speed as a fraction of the water velocity. */
  advectScale: number
  /** Sun azimuth in degrees clockwise from north (matches hillshade 325). */
  sunAzimuth: number
  /** Sun elevation in degrees above the horizon. */
  sunElevation: number
  /** Depth range over which the wet edge fades in, metres. */
  featherDepthM: number
  /** Depth at which ripples reach full amplitude, metres. */
  fullAmplitudeDepthM: number
}

export const waterRippleParams: WaterRippleParams = {
  specularStrength: 0.25,
  sheenStrength: 0.1,
  sparkleStrength: 0.15,
  amplitude: 1,
  waveLengthLarge: 14,
  waveLengthSmall: 4,
  advectScale: 0.6,
  sunAzimuth: 325,
  sunElevation: 50,
  featherDepthM: 0.05,
  fullAmplitudeDepthM: 0.5,
}

interface SliderSpec {
  key: keyof WaterRippleParams
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderSpec[] = [
  { key: 'specularStrength', label: '高光强度', min: 0, max: 0.6, step: 0.01 },
  { key: 'sheenStrength', label: '漫射增亮', min: 0, max: 0.4, step: 0.01 },
  { key: 'sparkleStrength', label: '细闪强度', min: 0, max: 0.5, step: 0.01 },
  { key: 'amplitude', label: '波纹振幅', min: 0, max: 3, step: 0.05 },
  { key: 'waveLengthLarge', label: '大波波长(格)', min: 4, max: 40, step: 1 },
  { key: 'waveLengthSmall', label: '细波波长(格)', min: 1.5, max: 10, step: 0.5 },
  { key: 'advectScale', label: '平流速度比', min: 0, max: 2, step: 0.05 },
  { key: 'sunAzimuth', label: '太阳方位°', min: 0, max: 360, step: 1 },
  { key: 'sunElevation', label: '太阳高度°', min: 5, max: 85, step: 1 },
  { key: 'featherDepthM', label: '边界羽化(m)', min: 0.005, max: 0.2, step: 0.005 },
  { key: 'fullAmplitudeDepthM', label: '满幅水深(m)', min: 0.1, max: 2, step: 0.05 },
]

/**
 * Mounts a live tuning panel for the ripple shader. Development builds only;
 * safe to call multiple times (mounts once).
 */
export function installWaterRippleDebugPanel() {
  if (!import.meta.env.DEV) return
  if (document.querySelector('.water-ripple-debug')) return
  const panel = document.createElement('aside')
  panel.className = 'water-ripple-debug'
  const header = document.createElement('header')
  header.textContent = 'WATER RIPPLE · 调参'
  panel.appendChild(header)
  for (const spec of SLIDERS) {
    const row = document.createElement('label')
    const name = document.createElement('span')
    const value = document.createElement('output')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.step = String(spec.step)
    input.value = String(waterRippleParams[spec.key])
    value.textContent = input.value
    input.addEventListener('input', () => {
      waterRippleParams[spec.key] = Number(input.value)
      value.textContent = input.value
    })
    name.textContent = spec.label
    row.append(name, input, value)
    panel.appendChild(row)
  }
  document.body.appendChild(panel)
}
