import { expect, test } from '@playwright/test'

test('user selects a grid cell and reaches the run check', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await expect(page.getByText('MODEL 9bf89256')).toBeVisible()
  const canvas = page.locator('.maplibregl-canvas')
  await expect(canvas).toBeVisible()
  await expect(page.locator('.model-map')).toHaveAttribute('data-grid-ready', 'true')

  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  let selected = false
  for (const xRatio of [0.5, 0.35, 0.65, 0.25, 0.75]) {
    for (const yRatio of [0.5, 0.35, 0.65]) {
      await canvas.click({
        position: { x: box.width * xRatio, y: box.height * yRatio },
      })
      const count = Number(
        await page.locator('.selection-readout strong').first().textContent(),
      )
      if (count > 0) {
        selected = true
        break
      }
    }
    if (selected) break
  }
  expect(selected).toBe(true)
  await expect(page.getByText('连续', { exact: true })).toBeVisible()
  await expect(page.getByText(/triangles/)).toBeVisible()

  await page.getByRole('button', { name: /运行模拟/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('配置可以运行')).toBeVisible()
  await expect(page.getByText('固定透射边界')).toBeVisible()
  expect(errors).toEqual([])
})


test('editor remains usable on a narrow field tablet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-grid-ready',
    'true',
  )
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
  await expect(page.getByRole('button', { name: '新建入口' })).toBeVisible()
  await expect(page.getByText('推演控制')).toBeVisible()
})


test('published COG frames stream into the live playback console', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/')
  await expect(page.locator('.model-map')).toHaveAttribute(
    'data-grid-ready', 'true', { timeout: 15_000 },
  )
  const canvas = page.locator('.maplibregl-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('map canvas has no bounds')
  let selected = false
  for (const xRatio of [0.5, 0.35, 0.65, 0.25, 0.75]) {
    for (const yRatio of [0.5, 0.35, 0.65]) {
      await canvas.click({ position: { x: box.width * xRatio, y: box.height * yRatio } })
      if (await page.getByText('连续', { exact: true }).count()) {
        selected = true
        break
      }
    }
    if (selected) break
  }
  expect(selected).toBe(true)
  await page.locator('.scenario-rail label').filter({ hasText: '模拟时长' }).locator('input').fill('20')
  await page.locator('.scenario-rail label').filter({ hasText: '输出步长' }).locator('input').fill('10')
  await page.getByRole('button', { name: /运行模拟/ }).click()
  await page.getByRole('button', { name: '确认并运行' }).click()

  await expect(page.getByRole('region', { name: '模拟结果播放' })).toBeVisible()
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3', { timeout: 150_000 })
  await expect(page.getByText('已完成')).toBeVisible()
  await page.reload()
  await expect(page.getByText(/FRAMES/)).toContainText('3 / 3')
  await expect(page.getByText('事件归档')).toBeVisible()
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
  expect(errors).toEqual([])
})
