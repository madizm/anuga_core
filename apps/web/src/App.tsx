import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LineString, Point, Polygon } from 'geojson'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api/client'
import type {
  FrictionScenario,
  HydraulicFeature,
  HydraulicMeshPreview,
  Rainfall,
  DemProduct,
  SavedScenario,
  ScenarioPayload,
  SimulationArea,
  ValidationResult,
  ResultQuantity,
} from './api/types'
import { InletPanel } from './inlets/InletPanel'
import { ResultWorkspace } from './jobs/ResultWorkspace'
import { JobHistory } from './jobs/JobHistory'
import { ScenarioHistory } from './scenarios/ScenarioHistory'
import { isFourNeighbourConnected, useInletStore } from './inlets/inletStore'
import {
  HydraulicFeaturePanel, type CrossSectionSelection,
} from './hydraulics/HydraulicFeaturePanel'
import { createHydraulicFeature, type HydraulicDrawMode } from './hydraulics/hydraulicFeatures'
import { LayerPanel } from './map/LayerPanel'
import { ModelMap } from './map/ModelMap'
import { DISABLED_RAINFALL, hasEffectiveRainfall, rainfallIntervals, rainfallValidationError } from './rainfall/rainfall'
import { PreviewCompatibilityDialog, PreviewPanel } from './preview/PreviewPanel'
import { PreviewController } from './preview/PreviewController'
import { buildDensePreviewGrid } from './preview/previewGrid'
import type { GridField, GridViewport } from './map/gridTiles'
import { GridTileStore } from './map/gridTiles'
import type { GridRange } from './map/simulationGrid'
import { detectPreviewCapabilities } from './preview/previewCapabilities'
import { previewCompatibility } from './preview/previewScenario'
import type { PreviewMode, PreviewStatus } from './preview/types'

export default function App() {
  const inlets = useInletStore((state) => state.inlets)
  const queryClient = useQueryClient()
  const [name, setName] = useState('鲅鱼圈多入口推演')
  const [duration, setDuration] = useState(21_600)
  const [yieldstep, setYieldstep] = useState(300)
  const [friction, setFriction] = useState<FrictionScenario>('middle')
  const [rainfall, setRainfall] = useState<Rainfall>(DISABLED_RAINFALL)
  const [hydraulicFeatures, setHydraulicFeatures] = useState<HydraulicFeature[]>([])
  const [featureDrawMode, setFeatureDrawMode] = useState<HydraulicDrawMode | null>(null)
  const [hydraulicMeshPreview, setHydraulicMeshPreview] = useState<HydraulicMeshPreview | null>(null)
  const [crossSectionSelection, setCrossSectionSelection] = useState<CrossSectionSelection | null>(null)
  useEffect(() => setHydraulicMeshPreview(null), [hydraulicFeatures])
  const [demProductId, setDemProductId] = useState('')
  const [saved, setSaved] = useState<SavedScenario | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [showCheck, setShowCheck] = useState(false)
  const [jobId, setJobId] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get('job')
  ))
  const [message, setMessage] = useState<string | null>(null)
  const [area, setArea] = useState<SimulationArea | null>(null)
  const [areaDrawMode, setAreaDrawMode] = useState<'rectangle' | 'polygon' | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const previewControllerRef = useRef<PreviewController | null>(null)
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(null)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('animated')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewQuantity, setPreviewQuantity] = useState<ResultQuantity>('depth')
  const [previewFlowEnabled, setPreviewFlowEnabled] = useState(true)
  const [previewCompatibilityNames, setPreviewCompatibilityNames] = useState<string[] | null>(null)
  const [previewApproximationNames, setPreviewApproximationNames] = useState<string[]>([])
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null)
  const previewCapabilities = useMemo(() => detectPreviewCapabilities(), [])
  const closePreview = useCallback(() => {
    previewControllerRef.current?.dispose()
    previewControllerRef.current = null
    setPreviewStatus(null)
    setPreviewFingerprint(null)
    setPreviewCompatibilityNames(null)
    setPreviewApproximationNames([])
  }, [])
  useEffect(() => closePreview, [closePreview])
  const clearAllSelections = useInletStore((state) => state.clearAllSelections)
  const replaceInlets = useInletStore((state) => state.replaceInlets)
  const demProducts = useQuery({
    queryKey: ['dem-products'], queryFn: api.demProducts,
  })
  useEffect(() => {
    if (!demProductId && demProducts.data?.defaultDemProductId) {
      setDemProductId(demProducts.data.defaultDemProductId)
    }
  }, [demProductId, demProducts.data])
  const demProduct = demProducts.data?.products.find(
    (item) => item.id === demProductId,
  )
  const history = useQuery({
    queryKey: ['scenarios'],
    queryFn: api.scenarios,
    enabled: historyOpen,
  })
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs(),
    enabled: jobsOpen,
    refetchInterval: (query) => query.state.data?.some((job) => (
      job.status === 'QUEUED' || job.status === 'PREPARING' || job.status === 'RUNNING'
    )) ? 2_000 : false,
  })
  const grid = useQuery({
    queryKey: ['simulation-area-grid', demProductId, area?.areaHash],
    queryFn: async () => {
      const manifest = await api.simulationAreaGridManifest(
        area!.gridManifestUrl,
      )
      const resource = new GridTileStore(manifest, api.simulationAreaGridTile)
      return { resource }
    },
    enabled: Boolean(area),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  })
  const [displayViewport, setDisplayViewport] = useState<GridViewport | null>(null)
  const gridRequestRef = useRef(0)
  useEffect(() => {
    gridRequestRef.current += 1
    setDisplayViewport(grid.data?.resource.emptyViewport() ?? null)
  }, [grid.data])
  const requestGridViewport = useCallback(async (
    range: GridRange, fields: readonly GridField[],
  ) => {
    const resource = grid.data?.resource
    if (!resource) return
    const request = ++gridRequestRef.current
    try {
      const loaded = await resource.loadViewport(
        range.rowStart, range.rowStop,
        range.columnStart, range.columnStop, fields,
      )
      if (request === gridRequestRef.current) setDisplayViewport(loaded)
    } catch (error) {
      if (request === gridRequestRef.current) {
        setMessage((error as Error).message || '无法加载局部网格 tile')
      }
    }
  }, [grid.data])

  const areaMutation = useMutation({
    mutationFn: (geometry: Polygon) => api.resolveSimulationArea(
      demProductId, geometry,
    ),
    onSuccess: (resolved) => {
      setArea(resolved)
      setAreaDrawMode(null)
      setMessage(`局部计算域已生成：${resolved.cellCount.toLocaleString()} cells`)
    },
    onError: (error) => {
      setAreaDrawMode(null)
      setMessage(error.message)
    },
  })

  const handleAreaDrawn = useCallback((geometry: Polygon) => {
    setAreaDrawMode(null)
    areaMutation.mutate(geometry)
  }, [areaMutation])

  const beginAreaDrawing = (mode: 'rectangle' | 'polygon') => {
    closePreview()
    if (!demProduct) {
      setMessage('DEM 产品目录尚未就绪')
      return
    }
    const hasSelections = inlets.some((inlet) => inlet.cellIds.length > 0)
    if (hasSelections && !window.confirm('重新选择模拟区域将清空全部入口网格，是否继续？')) return
    if (hasSelections) clearAllSelections()
    setHydraulicFeatures([])
    setFeatureDrawMode(null)
    setArea(null)
    setSaved(null)
    setValidation(null)
    setAreaDrawMode(mode)
  }

  const startDemVariant = () => {
    closePreview()
    if (!area) return
    if (!window.confirm('将保留非空间参数，但清空模拟区域和全部入口位置。是否继续？')) return
    clearAllSelections()
    setHydraulicFeatures([])
    setFeatureDrawMode(null)
    setArea(null)
    setSaved(null)
    setValidation(null)
    setShowCheck(false)
    setAreaDrawMode(null)
    setName((value) => `${value} · DEM 副本`)
    setMessage('已创建未绑定 DEM 的场景副本，请选择 DEM 后重新绘制区域')
  }

  const payload = (): ScenarioPayload => ({
    demProductId,
    simulationAreaId: area?.areaHash ?? '',
    name,
    durationSeconds: duration,
    yieldstepSeconds: yieldstep,
    frictionScenario: friction,
    inlets,
    rainfall,
    hydraulicFeatures,
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = saved
        ? await api.updateScenario(saved.id, payload())
        : await api.createScenario(payload())
      setSaved(result)
      setMessage('场景已保存')
      void queryClient.invalidateQueries({ queryKey: ['scenarios'] })
      return result
    },
    onError: (error) => setMessage(error.message),
  })

  const loadScenarioMutation = useMutation({
    mutationFn: async (scenarioId: string) => {
      const scenario = await api.scenario(scenarioId)
      const simulationArea = await api.simulationArea(
        scenario.demProductId, scenario.simulationAreaId,
      )
      return { scenario, simulationArea }
    },
    onSuccess: ({ scenario, simulationArea }) => {
      closePreview()
      setDemProductId(scenario.demProductId)
      setName(scenario.name)
      setDuration(scenario.durationSeconds)
      setYieldstep(scenario.yieldstepSeconds)
      setFriction(scenario.frictionScenario)
      setRainfall(scenario.rainfall ?? DISABLED_RAINFALL)
      setHydraulicFeatures(scenario.hydraulicFeatures ?? [])
      replaceInlets(scenario.inlets)
      setArea(simulationArea)
      setSaved(scenario)
      setValidation(null)
      setShowCheck(false)
      setHistoryOpen(false)
      setMessage(`已打开场景：${scenario.name}`)
    },
    onError: (error) => setMessage(error.message),
  })

  const currentPayload = payload()
  const savedPayload = saved && {
    demProductId: saved.demProductId,
    simulationAreaId: saved.simulationAreaId,
    name: saved.name,
    durationSeconds: saved.durationSeconds,
    yieldstepSeconds: saved.yieldstepSeconds,
    frictionScenario: saved.frictionScenario,
    inlets: saved.inlets,
    rainfall: saved.rainfall ?? DISABLED_RAINFALL,
    hydraulicFeatures: saved.hydraulicFeatures ?? [],
  }
  const isDirty = !saved || JSON.stringify(currentPayload) !== JSON.stringify(savedPayload)

  const openHistoricalScenario = (scenarioId: string) => {
    if (isDirty && (saved || area) && !window.confirm('当前修改尚未保存，打开历史场景将丢失这些修改。是否继续？')) return
    loadScenarioMutation.mutate(scenarioId)
  }

  const validateAndOpen = async () => {
    try {
      const current = await saveMutation.mutateAsync()
      const result = await api.validateScenario(current.id)
      setValidation(result)
      setShowCheck(true)
    } catch (error) {
      setMessage((error as Error).message)
    }
  }

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!saved || !validation) throw new Error('请先完成运行前检查')
      return api.createJob(saved.id, validation.warnings.length > 0)
    },
    onSuccess: (job) => {
      closePreview()
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
      setJobId(job.id)
      window.history.replaceState(null, '', `?job=${job.id}`)
      setShowCheck(false)
      setMessage(`任务 ${job.id.slice(0, 8)} 已进入队列`)
    },
    onError: (error) => setMessage(error.message),
  })

  const enabled = inlets.filter((inlet) => inlet.enabled)
  const selectedCells = enabled.reduce((total, inlet) => total + inlet.cellIds.length, 0)
  const totalDischarge = enabled.reduce((total, inlet) => total + inlet.dischargeM3s, 0)
  const inletsReady = enabled.length > 0 && enabled.every(
    (inlet) => inlet.cellIds.length > 0 && isFourNeighbourConnected(inlet.cellIds) && inlet.dischargeM3s > 0,
  )
  const rainfallReady = hasEffectiveRainfall(rainfall, duration)
  const rainfallValid = rainfallValidationError(rainfall, duration) === null
  const localReady = Boolean(area) && rainfallValid && (inletsReady || rainfallReady)
  const currentPayloadFingerprint = JSON.stringify(currentPayload)

  const launchPreview = async (ignoreCompatibility = false) => {
    if (!grid.data || !displayViewport || displayViewport.cellCount === 0 || !demProduct || !localReady) {
      setMessage('请先完成计算区域和水源配置')
      return
    }
    if (!previewCapabilities.supported) {
      setMessage(previewCapabilities.reason ?? '当前设备不支持快速预览')
      return
    }
    if (previewMode === 'static' && !previewCapabilities.staticSupported) {
      setMessage(previewCapabilities.staticReason ?? '当前设备不支持 1M Cell 静态快照预览')
      return
    }
    const compatibility = previewCompatibility(currentPayload)
    if (!ignoreCompatibility && !compatibility.supported) {
      setPreviewCompatibilityNames(compatibility.messages)
      return
    }
    closePreview()
    setPreviewLoading(true)
    try {
      const manningField: GridField = currentPayload.frictionScenario === 'low'
        ? 'manningLow'
        : currentPayload.frictionScenario === 'middle' ? 'manningMiddle' : 'manningHigh'
      const previewGrid = await grid.data.resource.loadAll([
        'elevation', manningField,
      ])
      const denseGrid = buildDensePreviewGrid(previewGrid, currentPayload, demProduct.cellSizeM, {
        mode: previewMode,
        maxTextureSize: previewCapabilities.maxTextureSize,
      })
      const controller = new PreviewController({
        grid: denseGrid,
        scenario: currentPayload,
        mode: previewMode,
      })
      previewControllerRef.current = controller
      controller.subscribe(setPreviewStatus)
      setPreviewFingerprint(currentPayloadFingerprint)
      setPreviewCompatibilityNames(null)
      setPreviewApproximationNames(compatibility.approximationMessages)
      controller.start()
    } catch (error) {
      closePreview()
      setMessage((error as Error).message || '快速预览初始化失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  useEffect(() => {
    const controller = previewControllerRef.current
    if (
      controller && previewFingerprint
      && previewFingerprint !== currentPayloadFingerprint
    ) controller.invalidate()
  }, [currentPayloadFingerprint, previewFingerprint])

  const handleFeatureDrawn = useCallback((geometry: LineString | Polygon | Point) => {
    if (!featureDrawMode || !area) return
    try {
      const feature = createHydraulicFeature(
        featureDrawMode, geometry, area, hydraulicFeatures,
      )
      setHydraulicFeatures((items) => [...items, feature])
      setFeatureDrawMode(null)
      setMessage(`已添加：${feature.name}`)
    } catch (error) {
      setMessage((error as Error).message)
    }
  }, [area, featureDrawMode, hydraulicFeatures])

  if (jobId) {
    return <ResultWorkspace jobId={jobId} onClose={() => {
      setJobId(null)
      window.history.replaceState(null, '', window.location.pathname)
    }} />
  }

  return (
    <div className="app-frame">
      <header className="command-header">
        <div className="brand-block">
          <div className="brand-mark"><span /><span /><span /></div>
          <div>
            <span className="eyebrow">ANUGA / HYDRODYNAMIC OPERATIONS</span>
            <h1>鲅鱼圈 <b>洪水模拟调度台</b></h1>
          </div>
        </div>
        <div className="scenario-name">
          <span>SCENARIO</span>
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="场景名称" />
          <i className={saved && !isDirty ? 'saved' : ''}>{saved ? isDirty ? '有修改' : '已保存' : '草稿'}</i>
        </div>
        <div className="header-actions">
          <button className="history-trigger" onClick={() => { setJobsOpen(false); setHistoryOpen(true) }}>
            <span>◫</span> 历史场景
          </button>
          <button className="history-trigger jobs-trigger" onClick={() => { setHistoryOpen(false); setJobsOpen(true) }}>
            <span>▤</span> 运行记录
          </button>
          <button className="secondary-button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? '保存中' : '保存场景'}
          </button>
          <select
            className="preview-mode-select"
            aria-label="预览模式"
            value={previewMode}
            onChange={(event) => setPreviewMode(event.target.value as PreviewMode)}
          >
            <option value="animated">动态预览 · 262K</option>
            <option value="static" disabled={!previewCapabilities.staticSupported}>静态快照 · 1M</option>
          </select>
          <button
            className="preview-button"
            disabled={!localReady || !displayViewport || displayViewport.cellCount === 0 || previewLoading || !previewCapabilities.supported}
            onClick={() => { void launchPreview() }}
          ><span>◇</span> {previewLoading ? '装载预演数据' : previewStatus ? '重新预览' : '快速预览'}</button>
          <button className="run-button" disabled={!localReady} onClick={validateAndOpen}>
            <span>▶</span> 运行模拟
          </button>
        </div>
      </header>

      <main className="workspace">
        <LayerPanel
          frictionScenario={friction}
          areaReady={Boolean(area)}
          areaCellCount={area?.cellCount ?? 0}
          cellSizeM={demProduct?.cellSizeM}
        />
        <section className="map-stage">
          {grid.isError ? (
            <div className="map-error">无法加载局部计算网格</div>
          ) : (
            <ModelMap
              key={demProductId}
              gridViewport={displayViewport ?? undefined}
              gridResource={grid.data?.resource}
              onGridViewportRequested={requestGridViewport}
              demTilejsonUrl={demProduct?.demTilejsonUrl}
              terrainTilejsonUrl={demProduct?.terrainTilejsonUrl}
              cellSizeM={demProduct?.cellSizeM}
              frictionScenario={friction}
              areaDrawMode={areaDrawMode}
              onAreaDrawn={handleAreaDrawn}
              hydraulicFeatures={hydraulicFeatures}
              hydraulicMeshPreview={hydraulicMeshPreview}
              crossSectionSelection={crossSectionSelection}
              featureDrawMode={featureDrawMode}
              onFeatureDrawn={handleFeatureDrawn}
              previewSnapshot={previewStatus?.snapshot ?? null}
              previewQuantity={previewQuantity}
              previewFlowEnabled={previewFlowEnabled}
              previewMode={previewStatus?.mode ?? previewMode}
            />
          )}
          <AreaControl
            area={area}
            drawMode={areaDrawMode}
            resolving={areaMutation.isPending}
            demReady={Boolean(demProduct)}
            onDraw={beginAreaDrawing}
          />
          <HydraulicFeaturePanel
            areaReady={Boolean(area)}
            demProductId={demProductId}
            areaHash={area?.areaHash ?? null}
            areaMeanElevationM={area?.elevationM.mean ?? 0}
            features={hydraulicFeatures}
            drawMode={featureDrawMode}
            onDrawModeChange={(mode) => {
              setAreaDrawMode(null)
              setFeatureDrawMode(mode)
            }}
            onChange={(features) => {
              setHydraulicFeatures(features)
              setHydraulicMeshPreview(null)
            }}
            onMeshPreview={setHydraulicMeshPreview}
            onCrossSectionSelectionChange={setCrossSectionSelection}
          />
          {previewStatus && (
            <PreviewPanel
              status={previewStatus}
              mode={previewStatus.mode}
              capabilities={previewCapabilities}
              quantity={previewQuantity}
              flowEnabled={previewFlowEnabled}
              approximationNames={previewApproximationNames}
              onStart={() => previewControllerRef.current?.start()}
              onPause={() => previewControllerRef.current?.pause()}
              onReset={() => previewControllerRef.current?.reset()}
              onClose={closePreview}
              onRate={(rate) => previewControllerRef.current?.setPlaybackRate(rate)}
              onQuantity={setPreviewQuantity}
              onFlow={setPreviewFlowEnabled}
              onFormal={() => { closePreview(); void validateAndOpen() }}
            />
          )}
          {area && grid.isLoading && <div className="loading-grid"><span />正在装载局部 {demProduct?.cellSizeM ?? '—'} m 网格</div>}
        </section>
        <InletPanel
          demProductId={demProductId}
          cellSizeM={demProduct?.cellSizeM ?? 30}
          areaHash={area?.areaHash ?? null}
          frictionScenario={friction}
          rainfall={rainfall}
          durationSeconds={duration}
          onRainfallChange={setRainfall}
        />
      </main>

      <footer className="scenario-rail">
        <div className="rail-title">
          <span>SCENARIO PARAMETERS</span>
          <strong>推演控制</strong>
        </div>
        <label className="dem-product-field">
          <span>DEM 产品 {area && <em>已锁定</em>}</span>
          <select
            aria-label="DEM 产品"
            value={demProductId}
            disabled={Boolean(area) || areaMutation.isPending || demProducts.isLoading}
            onChange={(event) => setDemProductId(event.target.value)}
          >
            {(demProducts.data?.products ?? []).filter((item) => item.status === 'active').map((item) => (
              <option value={item.id} key={item.id}>{item.name}</option>
            ))}
          </select>
          {demProduct && <div className="dem-product-meta">
            <small>网格 {demProduct.cellSizeM} m · 原始信息 {demProduct.sourceResolutionM} m · {demProduct.resamplingMethod === 'bilinear' ? '双线性' : '原始'}</small>
            {area && <button type="button" onClick={startDemVariant}>使用其他 DEM 新建</button>}
          </div>}
        </label>
        <label><span>模拟时长</span><div><input type="number" min="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><em>s</em></div></label>
        <label><span>输出步长</span><div><input type="number" min="1" value={yieldstep} onChange={(event) => setYieldstep(Number(event.target.value))} /><em>s</em></div></label>
        <label><span>曼宁场景</span><select value={friction} onChange={(event) => setFriction(event.target.value as FrictionScenario)}><option value="low">LOW · 低</option><option value="middle">MID · 中</option><option value="high">HIGH · 高</option></select></label>
        <div className="rail-metric"><span>启用入口</span><strong>{enabled.length}</strong><em>inlets</em></div>
        <div className="rail-metric"><span>选中网格</span><strong>{selectedCells}</strong><em>cells</em></div>
        <div className="rail-metric accent"><span>总流量</span><strong>{totalDischarge.toLocaleString()}</strong><em>m³/s</em></div>
        <div className="model-version"><i /> DEM {demProduct?.cellSizeM ?? '—'} M<small>{demProduct?.resourceQueue ?? 'loading'}</small></div>
      </footer>

      {message && <button className="toast" onClick={() => setMessage(null)}>{message}<span>×</span></button>}
      {jobsOpen && (
        <JobHistory
          jobs={jobs.data ?? []}
          loading={jobs.isLoading || jobs.isFetching}
          error={jobs.error?.message ?? null}
          onClose={() => setJobsOpen(false)}
          onOpen={(id) => {
            setJobsOpen(false)
            setJobId(id)
            window.history.replaceState(null, '', `?job=${id}`)
          }}
          onRefresh={() => void jobs.refetch()}
        />
      )}
      {historyOpen && (
        <ScenarioHistory
          scenarios={history.data ?? []}
          currentId={saved && !isDirty ? saved.id : null}
          loading={history.isLoading || history.isFetching}
          loadingId={loadScenarioMutation.isPending ? loadScenarioMutation.variables ?? null : null}
          error={history.error?.message ?? null}
          onClose={() => setHistoryOpen(false)}
          onOpen={openHistoricalScenario}
          onRefresh={() => void history.refetch()}
        />
      )}
      {previewCompatibilityNames && (
        <PreviewCompatibilityDialog
          names={previewCompatibilityNames}
          onContinue={() => launchPreview(true)}
          onCancel={() => setPreviewCompatibilityNames(null)}
          onFormal={() => { setPreviewCompatibilityNames(null); void validateAndOpen() }}
        />
      )}
      {showCheck && validation && (
        <RunCheck
          validation={validation}
          demProduct={demProduct}
          rainfall={rainfall}
          durationSeconds={duration}
          onClose={() => setShowCheck(false)}
          onRun={() => runMutation.mutate()}
          running={runMutation.isPending}
        />
      )}
    </div>
  )
}

function AreaControl({ area, drawMode, resolving, demReady, onDraw }: {
  area: SimulationArea | null
  drawMode: 'rectangle' | 'polygon' | null
  resolving: boolean
  demReady: boolean
  onDraw: (mode: 'rectangle' | 'polygon') => void
}) {
  return (
    <section className={area ? 'area-control locked' : 'area-control'}>
      <div>
        <span className="eyebrow">01 / SIMULATION AREA</span>
        <strong>{resolving
          ? '正在解析 DEM…'
          : area
            ? '局部计算域已锁定'
            : drawMode
              ? drawMode === 'rectangle' ? '拖动绘制矩形区域' : '逐点绘制，双击完成'
              : '请先选择模拟区域'}</strong>
        {area && <small>
          {area.cellCount.toLocaleString()} cells · {(area.areaM2 / 1_000_000).toFixed(2)} km² · {area.triangleCount.toLocaleString()} triangles
        </small>}
      </div>
      <div className="area-actions">
        <button
          className={drawMode === 'rectangle' ? 'active' : ''}
          disabled={resolving || !demReady}
          onClick={() => onDraw('rectangle')}
        >□ 矩形</button>
        <button
          className={drawMode === 'polygon' ? 'active' : ''}
          disabled={resolving || !demReady}
          onClick={() => onDraw('polygon')}
        >⬡ 多边形</button>
      </div>
    </section>
  )
}

function RunCheck({ validation, demProduct, rainfall, durationSeconds, onClose, onRun, running }: {
  validation: ValidationResult
  demProduct?: DemProduct
  rainfall: Rainfall
  durationSeconds: number
  onClose: () => void
  onRun: () => void
  running: boolean
}) {
  const summary = validation.summary
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="run-check" role="dialog" aria-modal="true" aria-labelledby="run-check-title">
        <header>
          <div><span className="eyebrow">PRE-FLIGHT CHECK</span><h2 id="run-check-title">运行前检查</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className={validation.valid ? 'check-banner valid' : 'check-banner invalid'}>
          <strong>{validation.valid ? '配置可以运行' : '配置存在错误'}</strong>
          <span>{validation.valid ? '固定模型与水源参数校验已通过' : '请关闭窗口并修正标记项'}</span>
        </div>
        {summary && (
          <div className="check-metrics">
            <div><span>入口</span><strong>{summary.enabledInletCount}</strong></div>
            <div><span>总流量</span><strong>{summary.totalDischargeM3s}<em> m³/s</em></strong></div>
            <div><span>输入水量</span><strong>{summary.totalInputVolumeM3.toLocaleString()}<em> m³</em></strong></div>
            <div><span>输出帧</span><strong>{summary.frameCount}</strong></div>
            {summary.rainfallEnabled && <div><span>累计降雨</span><strong>{summary.rainfallDepthMm.toFixed(1)}<em> mm</em></strong></div>}
            {summary.hydraulicFeatureCount > 0 && <div><span>水力要素</span><strong>{summary.hydraulicFeatureCount}</strong></div>}
          </div>
        )}
        {summary?.rainfallEnabled && <details className="rainfall-check-details">
          <summary>完整雨型 · {summary.rainfallPointCount} 节点 · 峰值 {summary.peakRainfallMmPerHour.toLocaleString()} mm/h</summary>
          <div className="rainfall-check-table">
            {rainfallIntervals(rainfall, durationSeconds).map((interval, index) => (
              <span key={index}><b>{interval.startMinutes}–{interval.endMinutes} min</b><em>{interval.intensityMmPerHour} mm/h</em><small>{interval.depthMm.toFixed(2)} mm</small></span>
            ))}
          </div>
        </details>}
        <ul className="check-list">
          {demProduct && <li className="pass"><b>✓</b><span>DEM 产品</span><strong>{demProduct.name} · 网格 {demProduct.cellSizeM} m / 原始信息 {demProduct.sourceResolutionM} m</strong></li>}
          <li className="pass"><b>✓</b><span>外边界</span><strong>固定透射边界</strong></li>
          <li className="pass"><b>✓</b><span>局部计算域</span><strong>{summary?.simulationAreaId.slice(0, 12)}</strong></li>
          {summary?.customMeshRequired && <li className="pass"><b>✓</b><span>计算网格</span><strong>结构物约束 breakline 网格</strong></li>}
          {validation.warnings.map((warning) => <li className="warning" key={warning.code}><b>!</b><span>警告</span><strong>{warning.message}</strong></li>)}
          {validation.errors.map((error) => <li className="failure" key={error.code}><b>×</b><span>错误</span><strong>{error.message}</strong></li>)}
        </ul>
        <p className="confirmation-note">提交后将创建不可变任务快照。场景的后续修改不会影响该任务。</p>
        <footer><button className="secondary-button" onClick={onClose}>返回编辑</button><button className="run-button" disabled={!validation.valid || running} onClick={onRun}>{running ? '提交中…' : validation.warnings.length ? '确认警告并运行' : '确认并运行'}</button></footer>
      </section>
    </div>
  )
}
