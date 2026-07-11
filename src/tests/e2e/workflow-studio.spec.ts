import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([])
}

async function startBlankWorkflow(page: Page) {
  await page.goto('/#build/step-1')
  await page.getByRole('radio', { name: /从空白开始/ }).click()
  await page.getByRole('button', { name: '创建空白模板' }).click()
}

async function buildOneCustomDocument(page: Page) {
  await startBlankWorkflow(page)
  await page.getByRole('checkbox', { name: /STATUS\.html/ }).check()
  await page.getByRole('button', { name: '新增自定义文档' }).click()
  await page.getByRole('button', { name: '开始搭建资料内容' }).click()
  await page.locator('.document-tab').last().click()
  await page.getByRole('button', { name: '新增信息项' }).click()

  const field = page.locator('.field-design-card')
  await expect(field).toBeVisible()
  await field.getByLabel('信息项名称').fill('下一次开始时先做什么')
  await field.getByLabel('常驻填写说明').fill('写清恢复后唯一、具体、可以直接执行的第一步。')
  await field.getByRole('radio', { name: /按步骤写/ }).check()
}

async function generateAndConfirmProtocol(page: Page) {
  await page.getByRole('button', { name: '审查入口协议' }).click()
  await expect(page.getByRole('heading', { name: '审查系统整理出的入口协议。' })).toBeVisible()
  await page.getByRole('button', { name: '生成入口协议' }).click()
  const confirmation = page.getByRole('checkbox', { name: '我已核对资料、读取顺序和完成检查。' })
  await expect(confirmation).toBeEnabled()
  await confirmation.check()
  await page.getByRole('button', { name: '确认入口协议并查看结果' }).click()
}

test('shows a readable home page and a beginner primer', async ({ page }) => {
  await page.goto('/#home')
  await expect(page.getByRole('heading', { name: /让模型始终知道/ })).toBeVisible()
  await expect(page.locator('.hero-actions').getByRole('button', { name: '工作流入门' })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始搭建' })).toBeVisible()
  await expectNoSeriousAxeViolations(page)

  await page.locator('.hero-actions').getByRole('button', { name: '工作流入门' }).click()
  await expect(page.getByRole('heading', { name: /先把要保存的判断想清楚/ })).toBeVisible()
  await expect(page.getByText('模板不是项目运行记录')).toBeVisible()
  await page.getByRole('button', { name: '开始搭建' }).click()
  await expect(page.getByRole('heading', { name: '从一套清楚的资料开始。' })).toBeVisible()
})

test('lets a novice build a blank workflow without hidden field complexity', async ({ page }) => {
  await buildOneCustomDocument(page)

  const canvas = page.locator('.canvas-step')
  await expect(canvas).not.toContainText('当前内容')
  await expect(canvas).not.toContainText('字段类型')
  await expect(canvas).not.toContainText('默认内容')
  await expect(canvas).not.toContainText('高级校验')
  await expect(canvas.getByText('导出后怎么呈现')).toBeVisible()
  await expect(canvas.getByText('下面的内容只是实时示例，不会写入你的模板。')).toBeVisible()
  await expect(canvas.locator('.format-option')).toHaveCount(3)
  await expect(canvas.locator('.format-explanation')).toContainText('按步骤写')

  await expectNoSeriousAxeViolations(page)
})

test('generates a protocol, previews files, rehearses a template, and exports JSON', async ({ page }) => {
  await buildOneCustomDocument(page)
  await generateAndConfirmProtocol(page)

  await expect(page.getByRole('heading', { name: '查看模型以后会读到的资料。' })).toBeVisible()
  await expect(page.locator('.result-document')).toHaveCount(3)
  await expect(page.getByText('JSON 或 ZIP 才是可重新导入编辑的事实源。')).toBeVisible()
  await page.getByRole('button', { name: '演练并导出' }).click()

  await expect(page.getByRole('heading', { name: '先演练一次，再带走工作流包。' })).toBeVisible()
  await expect(page.locator('.simulation-badge')).toHaveText('可以继续')
  await expect(page.getByText('确认模板保留下一原子步骤空槽')).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 workflow.json' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('workflow.json')
})

test('starts from the standard template and lets the user remove or add ordinary documents', async ({ page }) => {
  await page.goto('/#build/step-1')
  await page.getByRole('button', { name: '创建标准模板' }).click()

  const spec = page.getByRole('checkbox', { name: /SPEC\.html/ })
  const status = page.getByRole('checkbox', { name: /STATUS\.html/ })
  await expect(spec).toBeChecked()
  await expect(status).toBeChecked()
  await status.uncheck()
  await expect(status).not.toBeChecked()
  await page.getByRole('button', { name: '新增自定义文档' }).click()
  await expect(page.locator('.custom-documents')).toBeVisible()
  await page.getByRole('button', { name: '开始搭建资料内容' }).click()
  await expect(page.locator('.canvas-step')).toBeVisible()
})

test('keeps the current route and project intact when import parsing fails', async ({ page }) => {
  await startBlankWorkflow(page)
  await expect(page).toHaveURL(/#build\/step-2$/)
  await page.getByLabel('选择要导入的文件').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{broken'),
  })
  await expect(page.locator('.status-line')).toContainText(/导入失败|解析/)
  await expect(page).toHaveURL(/#build\/step-2$/)
  await expect(page.getByRole('heading', { name: '选择需要长期维护的资料。' })).toBeVisible()
})

test('safely redirects removed advanced links to the guided canvas', async ({ page }) => {
  await page.goto('/#advanced/documents')
  await expect(page).toHaveURL(/#build\/step-1$/)
  await expect(page.getByRole('heading', { name: '从一套清楚的资料开始。' })).toBeVisible()
  await expect(page.locator('.left-rail')).toHaveCount(0)
  await expect(page.getByText('高级文档编辑')).toHaveCount(0)
})

test('keeps the home and blank-builder path inside a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/#home')
  await expect.poll(() => page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth)).toBe(0)

  await startBlankWorkflow(page)
  await page.getByRole('button', { name: '新增自定义文档' }).click()
  await page.getByRole('button', { name: '开始搭建资料内容' }).click()
  await page.getByRole('button', { name: '新增信息项' }).click()
  await expect.poll(() => page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth)).toBe(0)
  await expect(page.locator('.field-design-card')).toBeVisible()
})

test('provides a keyboard skip link without changing the route', async ({ page }) => {
  await page.goto('/#build/step-1')
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: '跳到主要内容' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#build\/step-1$/)
  await expect(page.locator('#main-content')).toBeFocused()
})
