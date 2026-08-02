import { useEffect, useState } from 'react'
import type { HydraulicFeature, HydraulicMeshPreview, LeveeFeature } from '../api/types'
import { api } from '../api/client'
import { lineLengthM, type HydraulicDrawMode } from './hydraulicFeatures'
import { ParameterHelp } from './ParameterHelp'

export interface CrossSectionSelection {
  featureId: string
  sectionIndex: number
}

interface Props {
  areaReady: boolean
  demProductId: string
  areaHash: string | null
  areaMeanElevationM: number
  features: HydraulicFeature[]
  drawMode: HydraulicDrawMode | null
  onDrawModeChange: (mode: HydraulicDrawMode | null) => void
  onChange: (features: HydraulicFeature[]) => void
  onCrossSectionSelectionChange: (selection: CrossSectionSelection | null) => void
  onMeshPreview: (preview: HydraulicMeshPreview | null) => void
}

const FEATURE_DESCRIPTION: Record<HydraulicFeature['type'], string> = {
  levee: '沿绘制线建立零宽度阻水墙；水位超过堤顶后允许越流，不改变底层 DEM。',
  simpleChannel: '在绘制范围内统一修改河床高程和糙率，适合概念方案，不代表实测河道断面。',
  engineeringChannel: '沿中心线插值梯形断面并覆盖糙率、约束河岸网格；仅下切原地形，不回填低洼区域。',
  culvert: '在两个端点间按水头差守恒输水，考虑断面、糙率、损失和堵塞；允许反向过流，不会将水排出计算域。',
  bridge: '以梯形堰孔连接两端，模拟桥孔或闸孔限流及上游壅水，不显式表达桥墩和桥面。',
  drainageOutlet: '将收水范围内的积水排出计算域；排水能力随水深增加，不考虑尾水顶托和反向过流。',
  breach: '在关联堤防上按指定宽度降低堤顶；缺口从模拟开始即存在，不会随时间扩宽或下切。',
}

const HELP = {
  crestMode: '选择相对地面加高、统一绝对高程或逐节点高程。',
  heightAboveGround: '每个堤防节点相对于采样地面的加高量。',
  crestElevation: '整条堤防或缺口采用的绝对高程，单位为米。',
  crestProfile: '与绘制线节点一一对应，节点之间沿线插值。',
  qFactor: 'RiverWall 越流能力系数；越大时，同一水头差下越流量越大，通常以 1 为基准。',
  elevationMode: '相对降低按原始 DEM 下切；绝对高程将范围内河床设为指定值。',
  depth: '相对于原始 DEM 降低的垂直距离。',
  channelElevation: '河道范围内采用的统一绝对高程。',
  manning: '糙率越大，水流阻力越强，流速通常越低、上游水位可能越高。',
  triangleArea: '允许的最大三角形面积；越小越精细，但计算量越大。',
  bankHeight: '从河底到断面边界的最大垂直高度，同时影响河道编辑范围宽度。',
  chainage: '断面沿中心线距起点的里程；首断面必须为 0，末断面应接近终点。',
  sectionBed: '当前断面的绝对河底高程，断面之间沿中心线线性插值。',
  bottomWidth: '梯形断面的水平底部有效宽度。',
  sideSlope: '水平与垂直之比；2 表示水平 2 m、垂直升高 1 m，0 表示垂直边墙。',
  culvertShape: '箱涵使用矩形宽高，圆管使用直径计算过流能力。',
  culvertWidth: '单孔箱涵的内部净宽。',
  culvertHeight: '单孔箱涵的内部净高。',
  diameter: '单根圆管的内部直径。',
  barrels: '相同断面的并联涵洞数量，用于增加总过流能力。',
  blockage: '过流或排水能力的堵塞比例；0 表示无堵塞，0.5 表示堵塞 50%，必须小于 1。',
  losses: '进口、出口和收缩扩散等局部损失的无量纲合计；越大时流量越小。',
  openingHeight: '从孔底到孔顶的有效开口高度。',
  capacity: '无堵塞且达到满负荷水深时的最大排水流量。',
  intakeRadius: '以排水口为中心参与取水的地表范围，应覆盖实际收水区域。',
  fullCapacityDepth: '水深不足时按比例排水；达到该水深后使用最大有效能力。',
  levee: '缺口必须依附于一条参与计算的堤防。',
  breachWidth: '以点击位置为中心，沿堤防线降低堤顶的总长度。',
} as const

const TYPE_LABEL: Record<HydraulicFeature['type'], string> = {
  levee: '堤防',
  simpleChannel: '简化河道',
  engineeringChannel: '断面河道',
  culvert: '涵洞',
  bridge: '桥梁 / 闸孔',
  drainageOutlet: '排水口',
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
  onCrossSectionSelectionChange,
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
          <button className="icon-button" onClick={() => { setOpen(false); onDrawModeChange(null); onCrossSectionSelectionChange(null) }}>×</button>
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
            <DrawButton label="排水口" mode="drainageOutlet" active={drawMode} disabled={!areaReady} onClick={begin} />
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
            : drawMode === 'drainageOutlet' ? '点击设置单点排水口'
              : drawMode === 'breach' ? '点击堤防线上的缺口中心'
                : drawMode === 'engineeringChannel'
                  ? '建议从上游向下游逐点绘制中心线，双击完成；默认生成首、末断面'
                  : '逐点绘制中心线，双击完成'}</p>}
        <div className="hydraulic-feature-list">
          {features.map((feature) => <button
            key={feature.id}
            className={selected?.id === feature.id ? 'active' : ''}
            onClick={() => {
              setSelectedId(feature.id)
              onCrossSectionSelectionChange(feature.type === 'engineeringChannel'
                ? { featureId: feature.id, sectionIndex: 0 } : null)
            }}
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
              onCrossSectionSelectionChange(null)
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
          <p className="hydraulic-editor-note">{FEATURE_DESCRIPTION[selected.type]}</p>
          {selected.type === 'levee' && <LeveeEditor feature={selected} areaMean={areaMeanElevationM} demProductId={demProductId} areaHash={areaHash} onChange={replace} />}
          {selected.type === 'simpleChannel' && <>
            <label><FieldCaption label="河床模式" help={HELP.elevationMode} /><select value={selected.elevationMode} onChange={(event) => replace({ ...selected, elevationMode: event.target.value as 'lowerBy' | 'absolute', depthM: 2, elevationM: areaMeanElevationM - 2 })}><option value="lowerBy">相对降低</option><option value="absolute">绝对高程</option></select></label>
            <NumberField label={selected.elevationMode === 'lowerBy' ? '下切深度 m' : '河床高程 m'} help={selected.elevationMode === 'lowerBy' ? HELP.depth : HELP.channelElevation} value={selected.elevationMode === 'lowerBy' ? selected.depthM ?? 2 : selected.elevationM ?? areaMeanElevationM - 2} min={selected.elevationMode === 'lowerBy' ? 0.01 : undefined} onChange={(value) => replace(selected.elevationMode === 'lowerBy' ? { ...selected, depthM: value } : { ...selected, elevationM: value })} />
            <NumberField label="Manning n" help={HELP.manning} value={selected.manningN} min={0.001} step={0.001} onChange={(value) => replace({ ...selected, manningN: value })} />
            <NumberField label="最大三角面积 m²" help={HELP.triangleArea} value={selected.maxTriangleAreaM2} min={1} onChange={(value) => replace({ ...selected, maxTriangleAreaM2: value })} />
          </>}
          {selected.type === 'engineeringChannel' && <EngineeringChannelEditor
            feature={selected}
            onChange={replace}
            onActiveSectionChange={(sectionIndex) => onCrossSectionSelectionChange({
              featureId: selected.id, sectionIndex,
            })}
          />}
          {selected.type === 'culvert' && <>
            <label><FieldCaption label="断面" help={HELP.culvertShape} /><select value={selected.shape} onChange={(event) => replace({ ...selected, shape: event.target.value as 'box' | 'pipe', widthM: 2, heightM: 2, diameterM: 2 })}><option value="box">箱涵</option><option value="pipe">圆管</option></select></label>
            {selected.shape === 'box' ? <><NumberField label="宽度 m" help={HELP.culvertWidth} value={selected.widthM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} /><NumberField label="高度 m" help={HELP.culvertHeight} value={selected.heightM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, heightM: value })} /></> : <NumberField label="直径 m" help={HELP.diameter} value={selected.diameterM ?? 2} min={0.1} onChange={(value) => replace({ ...selected, diameterM: value })} />}
            <NumberField label="并联孔数" help={HELP.barrels} value={selected.barrels} min={1} step={1} onChange={(value) => replace({ ...selected, barrels: Math.round(value) })} />
            <NumberField label="堵塞率" help={HELP.blockage} value={selected.blockage} min={0} max={0.99} step={0.05} onChange={(value) => replace({ ...selected, blockage: value })} />
            <NumberField label="局部损失系数" help={HELP.losses} value={selected.losses} min={0} step={0.1} onChange={(value) => replace({ ...selected, losses: value })} />
            <NumberField label="Manning n" help={HELP.manning} value={selected.manningN} min={0.001} step={0.001} onChange={(value) => replace({ ...selected, manningN: value })} />
          </>}
          {selected.type === 'bridge' && <>
            <NumberField label="底宽 m" help={HELP.bottomWidth} value={selected.widthM} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} />
            <NumberField label="净高 m" help={HELP.openingHeight} value={selected.heightM} min={0.1} onChange={(value) => replace({ ...selected, heightM: value })} />
            <NumberField label="左边坡" help={HELP.sideSlope} value={selected.leftSideSlope} min={0} step={0.1} onChange={(value) => replace({ ...selected, leftSideSlope: value })} />
            <NumberField label="右边坡" help={HELP.sideSlope} value={selected.rightSideSlope} min={0} step={0.1} onChange={(value) => replace({ ...selected, rightSideSlope: value })} />
            <NumberField label="堵塞率" help={HELP.blockage} value={selected.blockage} min={0} max={0.99} step={0.05} onChange={(value) => replace({ ...selected, blockage: value })} />
            <NumberField label="损失系数" help={HELP.losses} value={selected.losses} min={0} step={0.1} onChange={(value) => replace({ ...selected, losses: value })} />
            <NumberField label="Manning n" help={HELP.manning} value={selected.manningN} min={0.001} step={0.001} onChange={(value) => replace({ ...selected, manningN: value })} />
          </>}
          {selected.type === 'drainageOutlet' && <>
            <NumberField label="最大排水能力 m³/s" help={HELP.capacity} value={selected.capacityM3s} min={0.001} step={0.05} onChange={(value) => replace({ ...selected, capacityM3s: value })} />
            <NumberField label="收水半径 m" help={HELP.intakeRadius} value={selected.intakeRadiusM} min={0.1} onChange={(value) => replace({ ...selected, intakeRadiusM: value })} />
            <NumberField label="满负荷水深 m" help={HELP.fullCapacityDepth} value={selected.fullCapacityDepthM} min={0.01} step={0.05} onChange={(value) => replace({ ...selected, fullCapacityDepthM: value })} />
            <NumberField label="堵塞率" help={HELP.blockage} value={selected.blockage} min={0} max={0.99} step={0.05} onChange={(value) => replace({ ...selected, blockage: value })} />
            <div className="drainage-formula"><span>有效流量</span><code>Qmax × (1 - 堵塞率) × min(水深 / 满负荷水深, 1)</code></div>
          </>}
          {selected.type === 'breach' && <>
            <label><FieldCaption label="所属堤防" help={HELP.levee} /><select value={selected.leveeId} onChange={(event) => replace({ ...selected, leveeId: event.target.value })}>{features.filter((item) => item.type === 'levee').map((levee) => <option key={levee.id} value={levee.id}>{levee.name}</option>)}</select></label>
            <NumberField label="缺口宽度 m" help={HELP.breachWidth} value={selected.widthM} min={0.1} onChange={(value) => replace({ ...selected, widthM: value })} />
            <NumberField label="缺口高程 m" help={HELP.crestElevation} value={selected.crestElevationM} onChange={(value) => replace({ ...selected, crestElevationM: value })} />
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
    <label><FieldCaption label="堤顶模式" help={HELP.crestMode} /><select value={feature.crestMode} onChange={(event) => setMode(event.target.value as LeveeFeature['crestMode'])}><option value="relative">高出地面</option><option value="absolute">统一高程</option><option value="profile">逐节点高程</option></select></label>
    {feature.crestMode === 'relative' && <NumberField label="加高值 m" help={HELP.heightAboveGround} value={feature.heightAboveGroundM ?? 2} min={0.01} onChange={(value) => onChange({ ...feature, heightAboveGroundM: value })} />}
    {feature.crestMode === 'absolute' && <NumberField label="堤顶高程 m" help={HELP.crestElevation} value={feature.crestElevationM ?? areaMean + 2} onChange={(value) => onChange({ ...feature, crestElevationM: value })} />}
    {feature.crestMode === 'profile' && <div className="levee-profile-editor">
      <span>节点堤顶高程</span>
      {(feature.crestElevationsM ?? []).map((value, index) => <NumberField key={index} label={`P${index + 1}`} help={HELP.crestProfile} value={value} onChange={(next) => onChange({ ...feature, crestElevationsM: feature.crestElevationsM?.map((item, itemIndex) => itemIndex === index ? next : item) })} />)}
    </div>}
    <NumberField label="堰流系数 Q" help={HELP.qFactor} value={feature.qFactor} min={0.01} step={0.05} onChange={(value) => onChange({ ...feature, qFactor: value })} />
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

function EngineeringChannelEditor({ feature, onChange, onActiveSectionChange }: {
  feature: Extract<HydraulicFeature, { type: 'engineeringChannel' }>
  onChange: (feature: HydraulicFeature) => void
  onActiveSectionChange: (sectionIndex: number) => void
}) {
  const updateSection = (index: number, key: 'distanceM' | 'bedElevationM' | 'bottomWidthM' | 'sideSlope', value: number) => onChange({ ...feature, crossSections: feature.crossSections.map((section, itemIndex) => itemIndex === index ? { ...section, [key]: value } : section) })
  const totalLengthM = lineLengthM(feature.geometry.coordinates)
  const sectionError = feature.crossSections.some((section, index) => (
    (index === 0 && section.distanceM !== 0)
    || section.distanceM < 0
    || section.distanceM > totalLengthM
    || (index === feature.crossSections.length - 1
      && section.distanceM < totalLengthM * 0.95)
    || (index > 0 && section.distanceM <= feature.crossSections[index - 1].distanceM)
  ))
  return <>
    <NumberField label="岸高 m" help={HELP.bankHeight} value={feature.bankHeightM} min={0.1} onChange={(value) => onChange({ ...feature, bankHeightM: value })} />
    <NumberField label="Manning n" help={HELP.manning} value={feature.manningN} min={0.001} step={0.001} onChange={(value) => onChange({ ...feature, manningN: value })} />
    <NumberField label="最大三角面积 m²" help={HELP.triangleArea} value={feature.maxTriangleAreaM2} min={1} onChange={(value) => onChange({ ...feature, maxTriangleAreaM2: value })} />
    <div className="channel-chainage-guide">
      <div><span>中心线总长</span><strong>{totalLengthM.toFixed(1)} m</strong></div>
      <p><b>0 m</b> 为绘制起点，桩号沿中心线递增；建议按上游到下游方向绘制。</p>
    </div>
    <div className="cross-section-table"><span>断面参数</span>{feature.crossSections.map((section, index) => <div
      key={index}
      className="cross-section-row"
      onFocus={() => onActiveSectionChange(index)}
      onMouseEnter={() => onActiveSectionChange(index)}
    >
      <em>{index === 0 ? '起点' : index === feature.crossSections.length - 1 ? '终点' : `#${index + 1}`}</em>
      <NumberField label="桩号" help={HELP.chainage} value={section.distanceM} min={0} max={totalLengthM} onChange={(value) => updateSection(index, 'distanceM', value)} />
      <NumberField label="河底" help={HELP.sectionBed} value={section.bedElevationM} onChange={(value) => updateSection(index, 'bedElevationM', value)} />
      <NumberField label="底宽" help={HELP.bottomWidth} value={section.bottomWidthM} min={0.1} onChange={(value) => updateSection(index, 'bottomWidthM', value)} />
      <NumberField label="边坡" help={HELP.sideSlope} value={section.sideSlope} min={0} step={0.1} onChange={(value) => updateSection(index, 'sideSlope', value)} />
      {index > 0 && index < feature.crossSections.length - 1 && <button aria-label={`删除断面 ${index + 1}`} onClick={() => onChange({ ...feature, crossSections: feature.crossSections.filter((_, itemIndex) => itemIndex !== index) })}>×</button>}
    </div>)}{sectionError && <p className="chainage-error">桩号必须从 0 开始递增且不超过总长，末断面应位于终点附近。</p>}<button onClick={() => {
      let gapIndex = 0
      for (let index = 1; index < feature.crossSections.length; index += 1) {
        const gap = feature.crossSections[index].distanceM
          - feature.crossSections[index - 1].distanceM
        const largestGap = feature.crossSections[gapIndex + 1].distanceM
          - feature.crossSections[gapIndex].distanceM
        if (gap > largestGap) gapIndex = index - 1
      }
      const before = feature.crossSections[gapIndex]
      const after = feature.crossSections[gapIndex + 1]
      const inserted = {
        distanceM: (before.distanceM + after.distanceM) / 2,
        bedElevationM: (before.bedElevationM + after.bedElevationM) / 2,
        bottomWidthM: (before.bottomWidthM + after.bottomWidthM) / 2,
        sideSlope: (before.sideSlope + after.sideSlope) / 2,
      }
      onChange({ ...feature, crossSections: [
        ...feature.crossSections.slice(0, gapIndex + 1), inserted,
        ...feature.crossSections.slice(gapIndex + 1),
      ] })
      onActiveSectionChange(gapIndex + 1)
    }}>＋在最大间距处增加断面</button></div>
  </>
}

function ToolGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><span>{title}</span><div>{children}</div></div>
}

function DrawButton({ label, mode, active, disabled, onClick }: { label: string; mode: HydraulicDrawMode; active: HydraulicDrawMode | null; disabled: boolean; onClick: (mode: HydraulicDrawMode) => void }) {
  return <button className={active === mode ? 'active' : ''} disabled={disabled} onClick={() => onClick(mode)}>{label}</button>
}

function FieldCaption({ label, help }: { label: string; help?: string }) {
  return <span className="hydraulic-field-caption">
    <span>{label}</span>
    {help && <ParameterHelp label={label} text={help} />}
  </span>
}

function NumberField({ label, help, value, min, max, step = 0.1, onChange }: { label: string; help?: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label><FieldCaption label={label} help={help} /><input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
}
