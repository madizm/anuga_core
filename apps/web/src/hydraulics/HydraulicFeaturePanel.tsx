import { useEffect, useState } from 'react'
import type { HydraulicFeature, HydraulicMeshPreview, LeveeFeature } from '../api/types'
import { api } from '../api/client'
import type { HydraulicDrawMode } from './hydraulicFeatures'

interface Props {
  areaReady: boolean
  demProductId: string
  areaHash: string | null
  areaMeanElevationM: number
  features: HydraulicFeature[]
  drawMode: HydraulicDrawMode | null
  onDrawModeChange: (mode: HydraulicDrawMode | null) => void
  onChange: (features: HydraulicFeature[]) => void
  onMeshPreview: (preview: HydraulicMeshPreview | null) => void
}

const TYPE_LABEL: Record<HydraulicFeature['type'], string> = {
  levee: '堤防',
  simpleChannel: '简化河道',
  engineeringChannel: '断面河道',
  culvert: '涵洞',
  bridge: '桥梁 / 闸孔',
  breach: '堤防缺口',
}

export function HydraulicFeaturePanel({
  areaReady,
  demProductId,
  areaHash,
  areaMeanElevationM,
  features,
  drawMode,
  onDrawModeChange,
  onChange,
  onMeshPreview,
}: Props) {
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewSummary, setPreviewSummary] = useState<string | null>(null)
  const selected = features.find((feature) => feature.id === selectedId) ?? null
  const replace = (feature: HydraulicFeature) => onChange(
    features.map((item) => item.id === feature.id ? feature : item),
  )
  const patch = (values: Partial<HydraulicFeature>) => {
    if (!selected) return
    replace({ ...selected, ...values } as HydraulicFeature)
  }
  const begin = (mode: HydraulicDrawMode) => {
    onDrawModeChange(drawMode === mode ? null : mode)
    setOpen(true)
  }

  return (
    <section className={open ? 'hydraulic-panel open' : 'hydraulic-panel'}>
      <button className="hydraulic-panel-trigger" onClick={() => setOpen(!open)}>
        <span>⌁</span><strong>地形与工程</strong><em>{features.length}</em>
      </button>
      {open && <div className="hydraulic-panel-body">
        <header>
          <div><span className="eyebrow">HYDRAULIC FEATURES</span><h2>河道与结构物</h2></div>
          <button className="icon-button" onClick={() => { setOpen(false); onDrawModeChange(null) }}>×</button>
        </header>
        {!areaReady && <p className="hydraulic-gate">请先锁定局部计算域，再绘制水力要素。</p>}
        <div className="hydraulic-tool-groups">
          <ToolGroup title="V1 · 堤防">
            <DrawButton label="绘制堤防" mode="levee" active={drawMode} disabled={!areaReady} onClick={begin} />
          </ToolGroup>
          <ToolGroup title="V2 · 简化河道">
            <DrawButton label="绘制河道面" mode="simpleChannel" active={drawMode} disabled={!areaReady} onClick={begin} />
          </ToolGroup>
          <ToolGroup title="V3 · 工程模型">
            <DrawButton label="断面河道" mode="engineeringChannel" active={drawMode} disabled={!areaReady} onClick={begin} />
            <DrawButton label="涵洞" mode="culvert" active={drawMode} disabled={!areaReady} onClick={begin} />
            <DrawButton label="桥梁 / 闸孔" mode="bridge" active={drawMode} disabled={!areaReady} onClick={begin} />
            <DrawButton label="堤防缺口" mode="breach" active={drawMode} disabled={!areaReady || !features.some((item) => item.type === 'levee')} onClick={begin} />
          </ToolGroup>
        </div>
        <button
          className="mesh-preview-button"
          disabled={!areaHash || previewing || !features.some((feature) => (
            feature.enabled && (feature.type === 'levee'
              || feature.type === 'simpleChannel'
              || feature.type === 'engineeringChannel')
          ))}
          onClick={async () => {
            if (!areaHash) return
            setPreviewing(true)
            setPreviewSummary(null)
            try {
              const preview = await api.hydraulicMeshPreview(
                demProductId, areaHash, features,
              )
              onMeshPreview(preview)
              setPreviewSummary(`${preview.triangleCount.toLocaleString()} triangles${preview.decimated ? ' · 显示已抽稀' : ''}`)
            } catch (error) {
              setPreviewSummary((error as Error).message)
              onMeshPreview(null)
            } finally {
              setPreviewing(false)
            }
          }}
        >{previewing ? '正在生成计算网格…' : '预览最终计算网格'}</button>
        {previewSummary && <p className="mesh-preview-summary">{previewSummary}</p>}
        {drawMode && <p className="draw-hint">{drawMode === 'simpleChannel'
          ? '逐点绘制河道范围，双击完成'
          : drawMode === 'culvert' || drawMode === 'bridge'
            ? '依次点击上、下游端点'
            : drawMode === 'breach' ? '点击堤防线上的缺口中心'
              : '逐点绘制中心线，双击完成'}</p>}
        <div className="hydraulic-feature-list">
          {features.map((feature) => <button
            key={feature.id}
            className={selected?.id === feature.id ? 'active' : ''}
            onClick={() => setSelectedId(feature.id)}
          >
            <i data-type={feature.type} />
            <span><strong>{feature.name}</strong><small>{TYPE_LABEL[feature.type]}</small></span>
            <em>{feature.enabled ? 'ON' : 'OFF'}</em>
          </button>)}
          {!features.length && <p>尚未绘制水力要素</p>}
        </div>
        {selected && <div className="hydraulic-editor">
          <div className="hydraulic-editor-title">
            <strong>{TYPE_LABEL[selected.type]}</strong>
            <button onClick={() => {
              onChange(features.filter((feature) => (
                feature.id !== selected.id
                && !(selected.type === 'levee' && feature.type === 'breach'
                  && feature.leveeId === selected.id)
              )))
              setSelectedId(null)
            }}>删除</button>
          </div>
          <label><span>名称</span><input value={selected.name} onChange={(event) => patch({ name: event.target.value })} /></label>
          <label className="switch-row"><span>参与计算</span><input type="checkbox" checked={selected.enabled} onChange={(event) => {
            const enabled = event.target.checked
            if (selected.type === 'levee' && !enabled) {
              onChange(features.map((feature) => (
                feature.id === selected.id || (feature.type === 'breach'
                  && feature.leveeId === selected.id)
                  ? { ...feature, enabled: false } : feature
              )))
            } else patch({ enabled })
          }} /></label>
          {selected.type === 'levee' && <LeveeEditor feature={selected} areaMean={areaMeanElevationM} demProductId={demProductId} areaHash={areaHash} onChange={replace} />}
          {selected.type === 'simpleChannel' && <>
            <label><span>河床模式</span><select value={selected.elevationMode} onChange={(event) => replace({ ...selected, elevationMode: event.target.value as 'lowerBy' | 'absolute', depthM: 2, elevationM: areaMeanElevationM - 2 })}><option value="lowerBy">相对降低</option><option value="absolute">绝对高程</option></select></label>
            <NumberField label={selected.elevationMode === 'lowerBy' ? '下切深度 m' : '河床高程 m'} value={selected.elevationMode === 'lowerBy' ? selected.depthM ?? 2 : selected.elevationM ?? areaMeanElevationM - 2} min={selected.elevationMode === 'lowerBy' ? 0.01 : undefined} onChange={(value) => replace(selected.elevationMode === 'lowerBy' ? { ...selected, depthM: value } : { ...selected, elevationM: value })} />
            <NumberField label="Manning n" value={selected.manningN} min={0.001} step={0.001} onChange={(value) => replace({ ...selected, manningN: value })} />
            <NumberField label="最大三角面积 m²" value={selected.maxTriangleAreaM2} min={1} onChange={(value) => replace({ ...selected, maxTriangleAreaM2: value })} />
          </>}
          {selected.type === 'engineeringChannel' && <EngineeringChannelEditor feature={selected} onChange={replace} />}
          {selected.type === 'culvert' && <>
            <label><span>断面</span><select value={selected.shape} onChange={(event) => replace({ ...selected, shape: event.target.value as 'box' | 'pipe', widthM: 2, heightM: 2, diameterM: 2 })}><option value="box">箱涵</option><option value="pipe">圆管</option></select></label>
            {selected.shape === 'box' ? <><NumberField label="宽度 m" value={selected.widthM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} /><NumberField label="高度 m" value={selected.heightM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, heightM: value })} /></> : <NumberField label="直径 m" value={selected.diameterM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, diameterM: value })} />}
            <NumberField label="并联孔数" value={selected.barrels} min={1} step={1} onChange={(value) => replace({ ...selected, barrels: Math.round(value) })} />
            <NumberField label="堵塞率" value={selected.blockage} min={0} max={0.99} step={0.05} onChange={(value) => replace({ ...selected, blockage: value })} />
            <NumberField label="局部损失系数" value={selected.losses} min={0} step={0.1} onChange={(value) => replace({ ...selected, losses: value })} />
            <NumberField label="Manning n" value={selected.manningN} min={0.001} step={0.001} onChange={(value) => replace({ ...selected, manningN: value })} />
          </>}
          {selected.type === 'bridge' && <>
            <NumberField label="底宽 m" value={selected.widthM} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} />
            <NumberField label="净高 m" value={selected.heightM} min={0.1} onChange={(value) => replace({ ...selected, heightM: value })} />
            <NumberField label="左边坡" value={selected.leftSideSlope} min={0} step={0.1} onChange={(value) => replace({ ...selected, leftSideSlope: value })} />
            <NumberField label="右边坡" value={selected.rightSideSlope} min={0} step={0.1} onChange={(value) => replace({ ...selected, rightSideSlope: value })} />
            <NumberField label="堵塞率" value={selected.blockage} min={0} max={0.99} step={0.05} onChange={(value) => replace({ ...selected, blockage: value })} />
            <NumberField label="损失系数" value={selected.losses} min={0} step={0.1} onChange={(value) => replace({ ...selected, losses: value })} />
          </>}
          {selected.type === 'breach' && <>
            <label><span>所属堤防</span><select value={selected.leveeId} onChange={(event) => replace({ ...selected, leveeId: event.target.value })}>{features.filter((item) => item.type === 'levee').map((levee) => <option key={levee.id} value={levee.id}>{levee.name}</option>)}</select></label>
            <NumberField label="缺口宽度 m" value={selected.widthM} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} />
            <NumberField label="缺口高程 m" value={selected.crestElevationM} onChange={(value) => replace({ ...selected, crestElevationM: value })} />
          </>}
        </div>}
      </div>}
    </section>
  )
}

function LeveeEditor({ feature, areaMean, demProductId, areaHash, onChange }: {
  feature: LeveeFeature
  areaMean: number
  demProductId: string
  areaHash: string | null
  onChange: (feature: HydraulicFeature) => void
}) {
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof api.elevationProfile>> | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  useEffect(() => {
    if (!areaHash) return
    let active = true
    setProfile(null)
    setProfileError(null)
    api.elevationProfile(demProductId, areaHash, feature.geometry)
      .then((result) => { if (active) setProfile(result) })
      .catch((error: Error) => { if (active) setProfileError(error.message) })
    return () => { active = false }
  }, [areaHash, demProductId, feature.geometry])
  const setMode = (mode: LeveeFeature['crestMode']) => onChange({
    ...feature,
    crestMode: mode,
    crestElevationM: areaMean + 2,
    heightAboveGroundM: 2,
    crestElevationsM: feature.geometry.coordinates.map(() => areaMean + 2),
  })
  return <>
    <div className="levee-profile" role="img" aria-label="堤防地面与堤顶纵断面">
      <span>纵断面 · {profile ? `${profile.lengthM.toFixed(0)} m` : profileError ?? '采样中…'}</span>
      {profile && <ProfileChart profile={profile} feature={feature} />}
    </div>
    <label><span>堤顶模式</span><select value={feature.crestMode} onChange={(event) => setMode(event.target.value as LeveeFeature['crestMode'])}><option value="relative">高出地面</option><option value="absolute">统一高程</option><option value="profile">逐节点高程</option></select></label>
    {feature.crestMode === 'relative' && <NumberField label="加高值 m" value={feature.heightAboveGroundM ?? 2} min={0.01} onChange={(value) => onChange({ ...feature, heightAboveGroundM: value })} />}
    {feature.crestMode === 'absolute' && <NumberField label="堤顶高程 m" value={feature.crestElevationM ?? areaMean + 2} onChange={(value) => onChange({ ...feature, crestElevationM: value })} />}
    {feature.crestMode === 'profile' && <div className="levee-profile-editor">
      <span>节点堤顶高程</span>
      {(feature.crestElevationsM ?? []).map((value, index) => <NumberField key={index} label={`P${index + 1}`} value={value} onChange={(next) => onChange({ ...feature, crestElevationsM: feature.crestElevationsM?.map((item, itemIndex) => itemIndex === index ? next : item) })} />)}
    </div>}
    <NumberField label="堰流系数 Q" value={feature.qFactor} min={0.01} step={0.05} onChange={(value) => onChange({ ...feature, qFactor: value })} />
  </>
}

function ProfileChart({ profile, feature }: {
  profile: Awaited<ReturnType<typeof api.elevationProfile>>
  feature: LeveeFeature
}) {
  const terrain = profile.samples.map((sample) => sample.elevationM)
  const crest = profile.samples.map((sample, index) => {
    if (feature.crestMode === 'relative') {
      return sample.elevationM + (feature.heightAboveGroundM ?? 0)
    }
    if (feature.crestMode === 'absolute') {
      return feature.crestElevationM ?? sample.elevationM
    }
    const values = feature.crestElevationsM ?? terrain
    const position = index / Math.max(1, profile.samples.length - 1)
      * Math.max(0, values.length - 1)
    const left = Math.floor(position)
    const right = Math.min(values.length - 1, left + 1)
    const fraction = position - left
    return values[left] * (1 - fraction) + values[right] * fraction
  })
  const minimum = Math.min(...terrain, ...crest)
  const maximum = Math.max(...terrain, ...crest)
  const points = (values: number[]) => values.map((value, index) => (
    `${index / Math.max(1, values.length - 1) * 300},${58 - (value - minimum) / Math.max(0.01, maximum - minimum) * 50}`
  )).join(' ')
  return <svg viewBox="0 0 300 62" preserveAspectRatio="none">
    <polyline className="terrain" points={points(terrain)} />
    <polyline className="crest" points={points(crest)} />
  </svg>
}

function EngineeringChannelEditor({ feature, onChange }: { feature: Extract<HydraulicFeature, { type: 'engineeringChannel' }>; onChange: (feature: HydraulicFeature) => void }) {
  const updateSection = (index: number, key: 'distanceM' | 'bedElevationM' | 'bottomWidthM' | 'sideSlope', value: number) => onChange({ ...feature, crossSections: feature.crossSections.map((section, itemIndex) => itemIndex === index ? { ...section, [key]: value } : section) })
  return <>
    <NumberField label="岸高 m" value={feature.bankHeightM} min={0.1} onChange={(value) => onChange({ ...feature, bankHeightM: value })} />
    <NumberField label="Manning n" value={feature.manningN} min={0.001} step={0.001} onChange={(value) => onChange({ ...feature, manningN: value })} />
    <NumberField label="最大三角面积 m²" value={feature.maxTriangleAreaM2} min={1} onChange={(value) => onChange({ ...feature, maxTriangleAreaM2: value })} />
    <div className="cross-section-table"><span>断面参数</span>{feature.crossSections.map((section, index) => <div key={index}>
      <NumberField label="桩号" value={section.distanceM} min={0} onChange={(value) => updateSection(index, 'distanceM', value)} />
      <NumberField label="河底" value={section.bedElevationM} onChange={(value) => updateSection(index, 'bedElevationM', value)} />
      <NumberField label="底宽" value={section.bottomWidthM} min={0.1} onChange={(value) => updateSection(index, 'bottomWidthM', value)} />
      <NumberField label="边坡" value={section.sideSlope} min={0} step={0.1} onChange={(value) => updateSection(index, 'sideSlope', value)} />
      {feature.crossSections.length > 2 && <button onClick={() => onChange({ ...feature, crossSections: feature.crossSections.filter((_, itemIndex) => itemIndex !== index) })}>×</button>}
    </div>)}<button onClick={() => {
      const last = feature.crossSections.at(-1)!
      onChange({ ...feature, crossSections: [...feature.crossSections.slice(0, -1), { ...last, distanceM: Math.max(0, last.distanceM - 1) }, last] })
    }}>＋增加断面</button></div>
  </>
}

function ToolGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><span>{title}</span><div>{children}</div></div>
}

function DrawButton({ label, mode, active, disabled, onClick }: { label: string; mode: HydraulicDrawMode; active: HydraulicDrawMode | null; disabled: boolean; onClick: (mode: HydraulicDrawMode) => void }) {
  return <button className={active === mode ? 'active' : ''} disabled={disabled} onClick={() => onClick(mode)}>{label}</button>
}

function NumberField({ label, value, min, max, step = 0.1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
}
