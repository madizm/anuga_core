import { expect, test } from '@playwright/test'

async function drawLocalRectangle(page: import('@playwright/test').Page) {
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-dem-ready',
    'true',
    { timeout: 20_000 },
  )
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  await page.getByRole('button', { name: /矩形/ }).click()
  await page.mouse.move(box.x + box.width * 0.46, box.y + box.height * 0.46)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width * 0.54,
    box.y + box.height * 0.54,
    { steps: 4 },
  )
  await page.mouse.up()
  await expect(page.getByText('局部计算域已锁定')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-grid-ready',
    'true',
  )
}

async function selectCenterCell(page: import('@playwright/test').Page) {
  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  const readout = page.locator('.selection-readout strong').first()
  for (const [x, y] of [[0.5, 0.5], [0.47, 0.5], [0.53, 0.5], [0.5, 0.47], [0.5, 0.53]]) {
    await canvas.click({ position: { x: box.width * x, y: box.height * y } })
    if (Number(await readout.textContent()) > 0) break
  }
  await expect(readout).not.toHaveText('0')
  await expect(page.getByText('连续', { exact: true })).toBeVisible()
}

test('user locks a local domain before selecting inlet cells', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  const demSelector = page.getByLabel('DEM 产品')
  await expect(demSelector).toBeEnabled()
  await expect(page.getByText(/网格 10 m · 原始信息 30 m · 双线性/)).toBeVisible()
  await expect(page.getByRole('button', { name: '切换到三维地形' })).toBeVisible()
  await expect(page.locator('.model-map')).toHaveAttribute('data-dem-ready', 'true')
  await expect(page.getByRole('button', { name: '新建入口' })).toBeDisabled()
  await expect(page.getByText('步骤 01 未完成')).toBeVisible()

  const buildingLayer = page.locator('.layer-row').filter({ hasText: '建筑覆盖率' })
  const manningLayer = page.locator('.layer-row').filter({ hasText: '曼宁糙率' })
  await expect(buildingLayer.locator('input')).toBeDisabled()
  await expect(manningLayer.locator('input')).toBeDisabled()

  await drawLocalRectangle(page)
  await expect(page.getByRole('button', { name: '新建入口' })).toBeEnabled()
  await expect(demSelector).toBeDisabled()
  await expect(page.getByText('已锁定', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '使用其他 DEM 新建' })).toBeVisible()
  await expect(buildingLayer.locator('input')).toBeEnabled()
  await buildingLayer.locator('input').check()
  await expect(page.getByLabel('建筑覆盖率图例')).toBeVisible()
  await expect(manningLayer.locator('input')).toBeEnabled()
  await manningLayer.locator('input').check()
  await expect(page.getByLabel('曼宁糙率图例')).toBeVisible()
  await expect(page.getByLabel('DEM 高程图例')).toBeHidden()
  await expect(page.locator('.area-control')).toContainText(/cells/)
  await expect(page.locator('.area-control')).toContainText(/triangles/)

  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  await expect(page.locator('.selection-readout strong').first()).not.toHaveText('0')
  await expect(page.getByText('连续', { exact: true })).toBeVisible()
  await expect(page.locator('.hydraulic-stats')).toContainText('Manning')
  expect(errors).toEqual([])
})

test('user draws a levee and drainage outlet before previewing the mesh', async ({ page }) => {
  await page.goto('/')
  await drawLocalRectangle(page)
  await page.getByRole('button', { name: /地形与工程/ }).click()
  await page.getByRole('button', { name: '绘制堤防' }).click()

  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  await canvas.click({ position: { x: box.width * 0.47, y: box.height * 0.48 } })
  await canvas.dblclick({ position: { x: box.width * 0.53, y: box.height * 0.48 } })

  await expect(page.getByText('堤防 1', { exact: true })).toBeVisible()
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-hydraulic-source-count',
    '1',
  )
  await expect(page.locator('.selection-readout strong').first()).toHaveText('0')
  await page.getByText('堤防 1', { exact: true }).click()
  await expect(page.getByRole('img', { name: '堤防地面与堤顶纵断面' })).toBeVisible()
  await expect(page.getByText(/纵断面 · \d+ m/)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: '排水口' }).click()
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  await expect(page.getByText('排水口 1', { exact: true })).toBeVisible()
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-hydraulic-source-count',
    '2',
  )
  await page.getByText('排水口 1', { exact: true }).click()
  await expect(page.getByLabel('最大排水能力 m³/s', { exact: true })).toHaveValue('0.5')
  await expect(page.getByText(/将收水范围内的积水排出计算域/)).toBeVisible()
  await expect(page.locator('.drainage-formula')).toContainText('Qmax')
  const capacityHelp = page.getByRole('button', { name: '最大排水能力 m³/s参数说明' })
  await capacityHelp.hover()
  await expect(page.getByRole('tooltip')).toContainText('达到满负荷水深')
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toBeHidden()
  await capacityHelp.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
  await capacityHelp.dispatchEvent('click')
  await expect(page.getByRole('tooltip')).toBeVisible()
  await capacityHelp.dispatchEvent('click')
  await expect(page.getByRole('tooltip')).toBeHidden()
  const panelBounds = await page.locator('.hydraulic-panel-body').boundingBox()
  const railBounds = await page.locator('.scenario-rail').boundingBox()
  if (!panelBounds || !railBounds) throw new Error('panel layout has no bounds')
  expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(railBounds.y)

  const previewResponse = page.waitForResponse((response) => (
    response.url().includes('/hydraulic-mesh-preview')
    && response.request().method() === 'POST'
    && response.status() === 200
  ))
  await page.getByRole('button', { name: '预览最终计算网格' }).click()
  await previewResponse
  await expect(page.locator('.mesh-preview-summary')).toContainText('triangles', {
    timeout: 20_000,
  })
  await page.getByLabel('入口名称').locator('..').getByText('启用').click()
  await page.getByRole('tab', { name: /降雨/ }).click()
  await page.locator('.rainfall-switch').getByText('启用').click()

  const savedResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/scenarios')
    && response.request().method() === 'POST'
    && response.status() === 201
  ))
  await page.getByRole('button', { name: '保存场景' }).click()
  const request = (await savedResponse).request().postDataJSON()
  expect(request.hydraulicFeatures).toHaveLength(2)
  expect(request.hydraulicFeatures[0]).toMatchObject({
    type: 'levee', crestMode: 'relative', heightAboveGroundM: 2,
  })
  expect(request.hydraulicFeatures[1]).toMatchObject({
    type: 'drainageOutlet', capacityM3s: 0.5,
    fullCapacityDepthM: 0.3, blockage: 0,
  })
})

test('editor keeps inlet controls gated until an area is locked', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 844 })
  await page.goto('/')
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-grid-ready',
    'false',
  )
  await expect(page.getByRole('button', { name: '新建入口' })).toBeDisabled()
  await expect(page.getByText('推演控制')).toBeVisible()
  await expect(page.getByText('请先选择模拟区域')).toBeVisible()
})

test('user can configure and save a rainfall-only scenario', async ({ page }) => {
  await page.goto('/')
  await drawLocalRectangle(page)
  await page.getByLabel('入口名称').locator('..').getByText('启用').click()
  await page.getByRole('tab', { name: /降雨/ }).click()
  await expect(page.getByText('降雨未参与计算')).toBeVisible()
  await page.locator('.rainfall-switch').getByText('启用').click()
  await expect(page.getByLabel('节点 1 时间（分钟）')).toHaveValue('0')
  await expect(page.getByLabel('节点 1 雨强')).toHaveValue('50')
  await expect(page.getByRole('img', { name: '阶梯雨型预览' })).toBeVisible()
  await expect(page.getByRole('button', { name: /运行模拟/ })).toBeEnabled()
  await page.locator('.scenario-rail label').filter({ hasText: '模拟时长' }).locator('input').fill('20')
  await page.locator('.scenario-rail label').filter({ hasText: '输出步长' }).locator('input').fill('10')

  const savedResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/scenarios')
    && response.request().method() === 'POST'
    && response.status() === 201
  ))
  await page.getByRole('button', { name: '保存场景' }).click()
  const request = (await savedResponse).request().postDataJSON()
  expect(request.rainfall).toEqual({
    enabled: true,
    points: [{ timeMinutes: 0, intensityMmPerHour: 50 }],
  })
  await page.getByRole('button', { name: /运行模拟/ }).click()
  const check = page.getByRole('dialog', { name: '运行前检查' })
  await expect(check.getByText('累计降雨')).toBeVisible()
  await expect(check.getByText(/完整雨型 · 1 节点 · 峰值 50 mm\/h/)).toBeVisible()
  await check.getByRole('button', { name: '确认并运行' }).click()
  await expect(page.getByRole('region', { name: '模拟结果播放' })).toBeVisible()
  await expect(page.locator('.rain-job')).toContainText('0.3 MM · 50 MM/H · 1 PT')
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3', {
    timeout: 150_000,
  })
  await expect(page.getByText('已完成')).toBeVisible()
})

test('saved scenario can be reopened from history after local edits', async ({ page }) => {
  await page.goto('/')
  await drawLocalRectangle(page)
  await selectCenterCell(page)

  const scenarioName = `历史恢复测试-${Date.now()}`
  const nameInput = page.getByLabel('场景名称')
  await nameInput.fill(scenarioName)
  const savedResponse = page.waitForResponse((response) => (
    response.url().endsWith('/api/scenarios')
    && response.request().method() === 'POST'
    && response.status() === 201
  ))
  await page.getByRole('button', { name: '保存场景' }).click()
  const savedScenario = await (await savedResponse).json()
  await expect(page.getByText('场景已保存')).toBeVisible()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  await nameInput.fill('尚未保存的名称')
  await expect(page.getByText('有修改', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /历史场景/ }).click()
  const history = page.getByRole('dialog', { name: '历史场景' })
  await expect(history.getByText(scenarioName)).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await history.locator('.history-card').filter({ hasText: scenarioName }).getByRole('button', { name: '打开场景' }).click()

  await expect(nameInput).toHaveValue(scenarioName)
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  await expect(page.getByText(`已打开场景：${scenarioName}`)).toBeVisible()

  const submitted = await page.request.post(`/api/scenarios/${savedScenario.id}/jobs`, {
    data: { confirmWarnings: false },
  })
  expect(submitted.status()).toBe(202)
  const job = await submitted.json()
  await page.getByRole('button', { name: /运行记录/ }).click()
  const jobs = page.getByRole('dialog', { name: '运行记录' })
  await expect(jobs.getByText(scenarioName)).toBeVisible()
  await expect(jobs.getByText('排队中')).toBeVisible()
  await jobs.getByRole('button', { name: '查看实时结果' }).click()
  await expect(page.getByRole('region', { name: '模拟结果播放' })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`job=${job.id}`))
})

test('local-domain COG frames stream into the live playback console', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await drawLocalRectangle(page)
  await selectCenterCell(page)
  await page.locator('.scenario-rail label').filter({ hasText: '模拟时长' }).locator('input').fill('20')
  await page.locator('.scenario-rail label').filter({ hasText: '输出步长' }).locator('input').fill('10')
  await page.getByRole('button', { name: /运行模拟/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '确认并运行' }).click()

  await expect(page.getByRole('region', { name: '模拟结果播放' })).toBeVisible()
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3', {
    timeout: 150_000,
  })
  await expect(page.getByRole('button', { name: '切换到二维地图' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('已完成')).toBeVisible()
  const completedJobId = new URL(page.url()).searchParams.get('job')
  if (!completedJobId) throw new Error('completed job URL has no job ID')
  await expect.poll(async () => {
    const response = await page.request.get(`/api/jobs/${completedJobId}/frames`)
    return (await response.json()).length
  }).toBe(3)
  const resultUrl = `${page.url()}&reload=${Date.now()}`
  await page.goto('about:blank')
  await page.waitForTimeout(1_000)
  await page.goto(resultUrl)
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3', { timeout: 20_000 })
  await page.getByRole('button', { name: /水位/ }).click()
  await expect(page.getByText('水位 STAGE')).toBeVisible()
  const resultCanvas = page.locator('.result-map-canvas .maplibregl-canvas')
  const resultBox = await resultCanvas.boundingBox()
  if (!resultBox) throw new Error('result map canvas has no bounds')
  await resultCanvas.click({
    position: { x: resultBox.width * 0.5, y: resultBox.height * 0.5 },
  })
  await expect(page.getByText(/FRAME SAMPLE/)).toBeVisible()
  await page.getByRole('button', { name: /三联/ }).click()
  await expect(page.locator('.result-map-canvas')).toHaveCount(3)
  await expect(page.locator('.terrain-control')).toHaveCount(1)
  await expect(page.getByText('流速 SPEED')).toBeVisible()
  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.locator('.flow-particle-canvas[data-flow-frame="2"]')).toHaveCount(3)
  await expect(page.getByText('DYNAMIC FLOW')).toHaveCount(3)
  await expect(page.getByText('水面效果为二维投影')).toBeVisible()
  await page.goto('about:blank')
})

function flowPayload() {
  const buffer = Buffer.alloc(44 + 2 * 4)
  buffer.write('BQFV', 0, 'ascii')
  buffer.writeUInt16LE(1, 4)
  buffer.writeUInt16LE(1, 6)
  buffer.writeUInt16LE(1, 8)
  buffer.writeDoubleLE(122.12, 12)
  buffer.writeDoubleLE(40.23, 20)
  buffer.writeDoubleLE(122.14, 28)
  buffer.writeDoubleLE(40.25, 36)
  buffer.writeFloatLE(1, 44)
  buffer.writeFloatLE(0.5, 48)
  return buffer
}

function flowPayloadV2() {
  const buffer = Buffer.alloc(44 + 3 * 4)
  buffer.write('BQFV', 0, 'ascii')
  buffer.writeUInt16LE(2, 4)
  buffer.writeUInt16LE(1, 6)
  buffer.writeUInt16LE(1, 8)
  buffer.writeDoubleLE(122.12, 12)
  buffer.writeDoubleLE(40.23, 20)
  buffer.writeDoubleLE(122.14, 28)
  buffer.writeDoubleLE(40.25, 36)
  buffer.writeFloatLE(0.3, 44)
  buffer.writeFloatLE(1, 48)
  buffer.writeFloatLE(0.5, 52)
  return buffer
}

function mockResultJob(jobId: string) {
  return {
    job: {
      id: jobId,
      scenarioId: 'scenario-a',
      simulationAreaId: 'a'.repeat(64),
      simulationAreaBounds: [122.1200, 40.2317, 122.1393, 40.2444],
      scenarioSnapshot: { durationSeconds: 300 },
      status: 'COMPLETED',
      currentFrame: 0,
      frameCount: 1,
      simulationTimeSeconds: 300,
      maximumDepthM: 1,
      appliedVolumeM3: 1,
      finalWaterVolumeM3: 1,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
    },
    frame: {
      jobId,
      frameIndex: 0,
      timeSeconds: 300,
      maximumDepthM: 1,
      maximumSpeedMps: 0,
      wetAreaM2: 900,
      tilejson: {
        depth: `/api/jobs/${jobId}/frames/0/tilejson/depth`,
        stage: `/api/jobs/${jobId}/frames/0/tilejson/stage`,
        speed: `/api/jobs/${jobId}/frames/0/tilejson/speed`,
      },
      createdAt: '2026-01-01T00:00:01Z',
    },
  }
}

test('dynamic water toggle mounts the ripple layer without errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const jobId = 'job-water-ripple'
  const { job, frame } = mockResultJob(jobId)
  await page.route(`**/api/jobs/${jobId}`, (route) => route.fulfill({ json: job }))
  await page.route(`**/api/jobs/${jobId}/frames`, (route) => route.fulfill({ json: [frame] }))
  await page.route(`**/api/jobs/${jobId}/events`, (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: `event: job.completed\ndata: ${JSON.stringify(job)}\n\n`,
  }))
  await page.route(`**/api/jobs/${jobId}/frames/0/flow`, (route) => route.fulfill({
    contentType: 'application/vnd.bayuquan.flow-field',
    body: flowPayloadV2(),
  }))
  await page.route(`**/api/jobs/${jobId}/frames/0/tiles/**`, (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X4W1WQAAAABJRU5ErkJggg==', 'base64'),
  }))
  await page.goto(`/?job=${jobId}`)
  await expect(page.getByText('已完成')).toBeVisible()
  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.locator('.result-map-canvas')).toHaveAttribute(
    'data-water-ripple',
    'active',
    { timeout: 10_000 },
  )
  await expect(page.locator('.flow-particle-canvas')).toHaveAttribute(
    'data-flow-mode',
    'animated',
  )
  await expect(page.getByText('DYNAMIC FLOW')).toBeVisible()

  const tuningTrigger = page.getByRole('button', { name: '水波参数调节' })
  const tuningPanel = page.getByRole('complementary', { name: '水波参数调节' })
  await expect(tuningTrigger).toBeVisible()
  await expect(tuningPanel).toBeHidden()
  await tuningTrigger.click()
  await expect(tuningPanel).toBeVisible()
  await expect(tuningPanel.getByText('高光强度')).toBeVisible()
  await tuningPanel.getByRole('button', { name: '关闭水波参数面板' }).click()
  await expect(tuningPanel).toBeHidden()

  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.locator('.result-map-canvas')).not.toHaveAttribute(
    'data-water-ripple',
    /.+/,
  )
  // Tile decode failures come from the mocked raster responses and external
  // basemap reachability, not from the ripple layer; keep everything else
  // strictly error-free so shader/GL regressions still fail the test.
  expect(errors.filter((message) => !message.includes('could not be decoded'))).toEqual([])
})

test('job deep link fits result tiles to its simulation area', async ({ page }) => {
  const jobId = 'job-outside-default-view'
  const areaBounds: [number, number, number, number] = [
    122.1200, 40.2317, 122.1393, 40.2444,
  ]
  const job = {
    id: jobId,
    scenarioId: 'scenario-a',
    simulationAreaId: 'a'.repeat(64),
    simulationAreaBounds: areaBounds,
    scenarioSnapshot: { durationSeconds: 300 },
    status: 'COMPLETED',
    currentFrame: 0,
    frameCount: 1,
    simulationTimeSeconds: 300,
    maximumDepthM: 1,
    appliedVolumeM3: 1,
    finalWaterVolumeM3: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
  }
  const frame = {
    jobId,
    frameIndex: 0,
    timeSeconds: 300,
    maximumDepthM: 1,
    maximumSpeedMps: 0,
    wetAreaM2: 900,
    tilejson: {
      depth: `/api/jobs/${jobId}/frames/0/tilejson/depth`,
      stage: `/api/jobs/${jobId}/frames/0/tilejson/stage`,
      speed: `/api/jobs/${jobId}/frames/0/tilejson/speed`,
    },
    createdAt: '2026-01-01T00:00:01Z',
  }
  const requestedTiles: string[] = []
  await page.route(`**/api/jobs/${jobId}`, (route) => route.fulfill({ json: job }))
  await page.route(`**/api/jobs/${jobId}/frames`, (route) => route.fulfill({ json: [frame] }))
  await page.route(`**/api/jobs/${jobId}/events`, (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: `event: job.completed\ndata: ${JSON.stringify(job)}\n\n`,
  }))
  await page.route(`**/api/jobs/${jobId}/frames/0/flow`, (route) => route.fulfill({
    contentType: 'application/vnd.bayuquan.flow-field',
    body: flowPayload(),
  }))
  await page.route(`**/api/jobs/${jobId}/frames/0/tiles/**`, (route) => {
    requestedTiles.push(route.request().url())
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X4W1WQAAAABJRU5ErkJggg==', 'base64'),
    })
  })

  await page.goto(`/?job=${jobId}`)
  await expect(page.getByText('已完成')).toBeVisible()
  await expect.poll(() => requestedTiles.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.locator('.flow-particle-canvas')).toBeVisible()
  await expect(page.locator('.flow-particle-canvas')).toHaveAttribute(
    'data-flow-frame',
    '0',
  )
  await expect(page.locator('.flow-particle-canvas')).toHaveAttribute(
    'data-flow-mode',
    'animated',
  )
  await expect.poll(() => page.locator('.flow-particle-canvas').evaluate(
    (canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      if (!context) return 0
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let visible = 0
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) visible += 1
      }
      return visible
    },
  )).toBeGreaterThan(10)
  await expect(page.getByText('DYNAMIC FLOW')).toBeVisible()
  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.getByText('DYNAMIC FLOW')).toBeHidden()
  await expect(page.locator('.flow-particle-canvas')).not.toHaveAttribute(
    'data-flow-frame',
    /.+/,
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: /动态水面/ }).click()
  await expect(page.locator('.flow-particle-canvas')).toHaveAttribute(
    'data-flow-mode',
    'static',
  )
  await expect.poll(() => requestedTiles.some((url) => {
    const match = url.match(/\/tiles\/depth\/(\d+)\/(\d+)\/(\d+)\.png/)
    if (!match) return false
    const [, zText, xText, yText] = match
    const z = Number(zText)
    const x = Number(xText)
    const y = Number(yText)
    const scale = 2 ** z
    const longitude = (x + 0.5) / scale * 360 - 180
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / scale))) * 180 / Math.PI
    return longitude >= areaBounds[0] && longitude <= areaBounds[2]
      && latitude >= areaBounds[1] && latitude <= areaBounds[3]
  })).toBe(true)
})
