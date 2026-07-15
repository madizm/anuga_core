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
