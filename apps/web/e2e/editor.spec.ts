import { expect, test } from '@playwright/test'

async function drawLocalRectangle(page: import('@playwright/test').Page) {
  const canvas = page.locator('.maplibregl-canvas')
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

test('user locks a local domain before selecting inlet cells', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await expect(page.getByText(/MODEL [a-f0-9]{8}/)).toBeVisible()
  await expect(page.locator('.model-map')).toHaveAttribute('data-dem-ready', 'true')
  await expect(page.getByRole('button', { name: '新建入口' })).toBeDisabled()
  await expect(page.getByText('步骤 01 未完成')).toBeVisible()

  const buildingLayer = page.locator('.layer-row').filter({ hasText: '建筑覆盖率' })
  const manningLayer = page.locator('.layer-row').filter({ hasText: '曼宁糙率' })
  await expect(buildingLayer.locator('input')).toBeDisabled()
  await expect(manningLayer.locator('input')).toBeDisabled()

  await drawLocalRectangle(page)
  await expect(page.getByRole('button', { name: '新建入口' })).toBeEnabled()
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

test('local-domain COG frames stream into the live playback console', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await drawLocalRectangle(page)
  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  await expect(page.getByText('连续', { exact: true })).toBeVisible()
  await page.locator('.scenario-rail label').filter({ hasText: '模拟时长' }).locator('input').fill('20')
  await page.locator('.scenario-rail label').filter({ hasText: '输出步长' }).locator('input').fill('10')
  await page.getByRole('button', { name: /运行模拟/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '确认并运行' }).click()

  await expect(page.getByRole('region', { name: '模拟结果播放' })).toBeVisible()
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3', {
    timeout: 150_000,
  })
  await expect(page.getByText('已完成')).toBeVisible()
  await page.reload()
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3')
  await page.getByRole('button', { name: /水位/ }).click()
  await expect(page.getByText('水位 STAGE')).toBeVisible()
  const resultCanvas = page.locator('.result-map-canvas canvas')
  const resultBox = await resultCanvas.boundingBox()
  if (!resultBox) throw new Error('result map canvas has no bounds')
  await resultCanvas.click({
    position: { x: resultBox.width * 0.5, y: resultBox.height * 0.5 },
  })
  await expect(page.getByText(/FRAME SAMPLE/)).toBeVisible()
  await page.getByRole('button', { name: /三联/ }).click()
  await expect(page.locator('.result-map-canvas')).toHaveCount(3)
  await expect(page.getByText('流速 SPEED')).toBeVisible()
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
