import { expect, test, type Dialog, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

async function openAdvanced(page: Page) {
  await page.getByRole('link', { name: '高级编辑', exact: true }).click()
}

async function fillBuilderPurpose(page: Page, projectName = '资料整理项目') {
  await page.getByLabel('这个工作流服务哪个项目或任务？').fill(projectName)
  await page.getByLabel('未来模型恢复时最容易丢失什么信息？').fill('当前目标、输入材料位置和用户最近确认的边界。')
  await page.getByLabel('恢复后希望模型立刻做什么？').fill('先读取 STATUS.html，再检查下一原子步骤。')
}

async function buildToModuleCanvas(page: Page, additionalDocuments: RegExp[] = []) {
  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await fillBuilderPurpose(page)
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  for (const documentLabel of additionalDocuments) await page.getByLabel(documentLabel).check()
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  await expect(page.locator('.module-builder-step')).toBeVisible()
}

async function selectBuilderDocument(page: Page, filename: string) {
  const mobilePicker = page.getByLabel('当前编辑文档')
  if (await mobilePicker.isVisible()) {
    const option = mobilePicker.locator('option').filter({ hasText: filename })
    const value = await option.getAttribute('value')
    if (!value) throw new Error(`missing builder document option for ${filename}`)
    await mobilePicker.selectOption(value)
    return
  }
  await page.locator('.document-tab-row .module-doc-card').filter({ hasText: filename }).click()
}

async function markEveryContentDocumentReviewed(page: Page) {
  const documentTabs = page.locator('.document-tab-row .module-doc-card')
  await page.locator('.module-builder-step').waitFor({ state: 'visible' })
  await documentTabs.first().waitFor({ state: 'attached' })
  const documentCount = await documentTabs.count()
  expect(documentCount).toBeGreaterThan(0)

  for (let index = 0; index < documentCount; index += 1) {
    const filename = (await documentTabs.nth(index).locator('code').textContent())?.trim()
    if (!filename) throw new Error('missing builder document filename')
    await selectBuilderDocument(page, filename)
    const mobilePicker = page.getByLabel('当前编辑文档')
    const selectedBeforeReview = await mobilePicker.isVisible() ? await mobilePicker.inputValue() : ''
    const reviewButton = page.locator('.document-reviewed-button')
    await expect(reviewButton).toBeEnabled()
    await reviewButton.click()
    await expect(documentTabs.nth(index).locator('.document-review-state')).toHaveText('已检查')
    if (selectedBeforeReview && index < documentCount - 1) {
      await expect(mobilePicker).not.toHaveValue(selectedBeforeReview)
      const editorTop = () => page.locator('.canvas-document-head').evaluate((element) => Math.round(element.getBoundingClientRect().top))
      await expect.poll(editorTop).toBeGreaterThanOrEqual(0)
      await expect.poll(editorTop).toBeLessThan(80)
    }
  }

  await expect(page.getByLabel('内容文档检查进度').getByText(`${documentCount}/${documentCount} 份文档已检查`)).toBeVisible()
  await expect(page.getByRole('button', { name: '生成并审查入口协议草案' })).toBeEnabled()
}

async function expectActiveBuildStepFullyVisible(page: Page, stepNumber: number) {
  const activeStep = page.locator('.stepper li.active')
  await expect(activeStep.locator('button')).toHaveAttribute('aria-current', 'step')
  await expect(activeStep.locator('span')).toHaveText(String(stepNumber))
  await expect.poll(async () => activeStep.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const scroller = element.closest('.stepper')?.getBoundingClientRect()
    const visibleTop = Math.max(0, scroller?.top ?? 0)
    const visibleBottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight)
    return rect.left >= 12
      && rect.right <= window.innerWidth - 12
      && rect.top >= visibleTop - 1
      && rect.bottom <= visibleBottom + 1
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - document.documentElement.clientWidth)).toBe(0)
}

test('starts from a beginner friendly home page with two primary entries', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /为未来.*接手项目.*模型/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '进入工作流入门' })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始搭建工作流' })).toBeVisible()
  await expect(page.getByText('关系图与恢复路径')).toBeHidden()

  await page.getByRole('button', { name: '进入工作流入门' }).click()
  await expect(page.getByRole('heading', { name: '先弄懂工作流，再开始填内容。' })).toBeVisible()
  await expect(page.getByText('工作流的目的，是让模型知道始终该读什么、信什么、接着做什么。')).toBeVisible()
  await expect(page.getByText('如果模型断线重开，它第一眼应该看哪里？')).toBeVisible()

  await page.getByRole('button', { name: '去工作流搭建' }).click()
  await expect(page.getByRole('heading', { name: '像搭积木一样设计工作流。' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '先说清这套工作流要帮谁接手什么。' })).toBeVisible()
  await expect(page.getByRole('button', { name: '继续选择内容文档' })).toBeVisible()
})

test('announces route changes, exposes form errors, and has no serious beginner-page axe violations', async ({ page }) => {
  await page.goto('/#home')
  await page.getByRole('button', { name: '进入工作流入门' }).click()
  await expect(page.getByRole('heading', { name: '先弄懂工作流，再开始填内容。' })).toBeFocused()

  for (const hash of ['#home', '#learn', '#build/step-1']) {
    await page.goto(`/${hash}`)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact ?? ''))).toEqual([])
  }

  await page.getByLabel('这个工作流服务哪个项目或任务？').fill('')
  await page.getByLabel('未来模型恢复时最容易丢失什么信息？').fill('')
  await page.getByLabel('恢复后希望模型立刻做什么？').fill('')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  const projectName = page.getByLabel('这个工作流服务哪个项目或任务？')
  await expect(projectName).toBeFocused()
  await expect(projectName).toHaveAttribute('aria-invalid', 'true')
  await expect(projectName).toHaveAttribute('aria-describedby', 'builder-project-name-error')

  await page.getByLabel('导入已有工作流包').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{invalid'),
  })
  await expect(page.locator('.builder-step .notice')).toContainText(/JSON|导入失败|解析/)
})

test('explains an empty document selection and offers a minimal recovery document', async ({ page }) => {
  await page.goto('/#build/step-1')
  await fillBuilderPurpose(page, '最小选择工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  const documentChoices = page.locator('.material-card input[type="checkbox"]')
  for (let index = 0; index < await documentChoices.count(); index += 1) {
    if (await documentChoices.nth(index).isChecked()) await documentChoices.nth(index).uncheck()
  }

  await expect(page.getByText(/AGENTS\.md 只负责串联规则/)).toBeVisible()
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  await expect(page.locator('.builder-step .notice')).toContainText('至少选择 1 份内容文档')
  await expect(page).toHaveURL(/#build\/step-2$/)

  await page.getByRole('button', { name: '采用最小组合：STATUS.html' }).click()
  await expect(page.getByLabel(/STATUS\.html/)).toBeChecked()
})

test('keeps the active route when using the skip link', async ({ page }) => {
  await page.goto('/#build/step-3')
  const skipLink = page.getByRole('link', { name: '跳到主工作区' })
  await skipLink.focus()
  await expect(skipLink).toBeFocused()
  await skipLink.press('Enter')

  await expect(page).toHaveURL(/#build\/step-3$/)
  await expect(page.locator('#main-workspace')).toBeFocused()
  await expect(page.locator('.module-builder-step')).toBeVisible()
})

test('reports overview import failures and restores inspector focus on Escape', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await page.getByLabel('从总览导入工作流 JSON 或 ZIP').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{broken'),
  })
  await expect(page.locator('.entry-card .import-feedback')).toContainText(/JSON|导入失败|解析/)

  const inspectorTrigger = page.getByRole('button', { name: '检查', exact: true })
  await inspectorTrigger.click()
  const inspector = page.getByRole('dialog', { name: '检查与修复' })
  await expect(inspector).toHaveAttribute('aria-modal', 'true')
  await expect(page.getByRole('button', { name: '关闭检查器' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
  await expect(inspectorTrigger).toBeFocused()
})

test('contains a long unbroken workflow name on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile overflow regression')
  await page.goto('/#build/step-1')
  await fillBuilderPurpose(page, 'X'.repeat(180))
  await page.getByRole('button', { name: '继续选择内容文档' }).click()

  await expect.poll(() => page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth)).toBe(0)
  await expect(page.locator('.build-head h1')).toBeVisible()
})

test('builds a modular workflow through document selection and protocol review', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()

  const beginnerFlow = page.locator('.onboarding-main')
  await expect(beginnerFlow).not.toContainText(/shortText|lifecycle|sourceType|recencyPolicy|prefer-newer|FieldType|sourcePriority/)

  await page.getByLabel('这个工作流服务哪个项目或任务？').fill('资料整理项目')
  await page.getByLabel('未来模型恢复时最容易丢失什么信息？').fill('当前目标、输入材料位置和用户最近确认的边界。')
  await page.getByLabel('恢复后希望模型立刻做什么？').fill('先读取 STATUS.html，再检查下一原子步骤。')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()

  await expect(page.getByRole('heading', { name: '先选择需要的内容文档。' })).toBeVisible()
  await expect(page.getByText('AGENTS.md 不需要你第一步手写')).toBeVisible()
  await expect(page.getByLabel(/STATUS\.html/)).toBeChecked()
  await page.getByLabel(/USER\.html/).check()
  await page.getByLabel(/CONTEXT\.html/).check()
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()

  await expect(page.getByRole('heading', { name: '逐份文档搭建模块。' })).toBeVisible()
  await selectBuilderDocument(page, 'STATUS.html')
  await expect(page.locator('.write-map').getByText('写入地图', { exact: true })).toBeVisible()
  await expect(page.locator('.write-map').first()).toContainText('STATUS.html > 文档职责')

  const moduleCanvas = page.locator('.module-canvas')
  const documentMeta = moduleCanvas.locator('.canvas-document-head')
  await documentMeta.getByLabel('显示名').fill('交付状态快照')
  await documentMeta.getByLabel('这份文档只负责什么').fill('只记录本轮仍有效的目标、验证证据和下一原子步骤。')

  const firstSection = moduleCanvas.locator('.module-section-editor').first()
  await firstSection.getByLabel('章节名称').fill('本轮目标与接续动作')
  await firstSection.getByLabel('这一章负责什么').fill('提供恢复后可以立即执行的目标和唯一下一步。')

  const firstField = firstSection.locator('.module-field-editor').first()
  await firstField.getByLabel('字段名称').fill('本轮交付目标')
  await firstField.getByLabel('常驻说明').fill('只保留当前仍有效且可验证的交付目标。')
  await firstField.getByLabel('当前内容').fill('完成浏览器回归与交付截图验收。')
  await firstField.getByLabel('展示方式').selectOption('key-value')
  await expect(firstField.getByLabel('展示方式')).toHaveValue('key-value')
  await expect(page.locator('.write-map').first()).toContainText('STATUS.html > 本轮目标与接续动作 > 本轮交付目标')

  const fieldCountBeforeCopy = await firstSection.locator('.module-field-editor').count()
  await firstField.getByRole('button', { name: '复制字段 本轮交付目标' }).click()
  await expect(firstSection.locator('.module-field-editor')).toHaveCount(fieldCountBeforeCopy + 1)
  await expect(firstSection.locator('.module-field-editor').nth(1).getByLabel('字段名称')).toHaveValue('本轮交付目标 副本')

  await firstSection.locator('.field-library-band .module-choice-button').filter({ hasText: '证据或验证方式' }).click()
  const addedPresetField = firstSection.locator('.field-library-band .module-choice-button').filter({ hasText: '证据或验证方式（已加入）' })
  await expect(addedPresetField).toBeDisabled()

  await markEveryContentDocumentReviewed(page)

  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.getByRole('heading', { name: '审查系统生成的入口协议草案。' })).toBeVisible()
  const protocolSwitches = page.locator('.protocol-section-switcher .section-switch')
  const protocolModule = page.locator('.protocol-review-grid .module-section-editor')
  await expect(protocolSwitches).toHaveCount(5)
  await expect(protocolModule).toHaveCount(1)
  await expect(protocolModule.getByLabel('章节名称')).toHaveValue('文档清单')
  await expect(protocolModule.getByLabel('当前内容')).toHaveValue(/USER\.html[\s\S]*MEMORY\.html[\s\S]*CONTEXT\.html/)
  await expect(protocolModule.getByRole('button', { name: '上移章节 文档清单' })).toBeDisabled()
  await expect(protocolModule.getByRole('button', { name: '下移章节 文档清单' })).toBeVisible()
  await expect(protocolModule.getByRole('button', { name: '复制章节 文档清单' })).toBeVisible()
  await expect(protocolModule.getByRole('button', { name: '删除章节 文档清单' })).toBeVisible()
  await protocolSwitches.filter({ hasText: '读取顺序' }).click()
  await expect(protocolModule.getByLabel('章节名称')).toHaveValue('读取顺序')
  await expect(page.getByRole('button', { name: '新增协议模块' })).toBeVisible()

  await page.getByRole('button', { name: '查看结果预览' }).click()
  await expect(page.getByRole('heading', { name: /结果预览.*文件树.*模块分布.*恢复路径/ })).toBeVisible()
  await expect(page.getByText('documents/AGENTS.md')).toBeVisible()
  await expect(page.getByText('documents/CONTEXT.html')).toBeVisible()
  const htmlPreview = page.locator('iframe.document-preview-frame')
  await expect(htmlPreview).toBeVisible()
  await expect(htmlPreview).toHaveAttribute('title', 'SPEC.html 渲染预览')
  await expect(htmlPreview).toHaveAttribute('sandbox', '')
  await expect(page.frameLocator('iframe.document-preview-frame').getByRole('heading', { level: 1, name: '稳定计划' })).toBeVisible()
})

test('allows a static workflow to omit STATUS.html and generates conditional reading guidance', async ({ page }) => {
  await page.goto('/#build/step-1')
  await fillBuilderPurpose(page, '静态规范工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await page.getByLabel(/STATUS\.html/).uncheck()
  await expect(page.getByLabel(/STATUS\.html/)).not.toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: '第一动作仍引用未选择的文档' })).toContainText('STATUS.html')
  await expect(page.getByRole('button', { name: '生成文档并进入模块画布' })).toBeDisabled()
  await page.getByRole('button', { name: '修改第一动作' }).click()
  await expect(page.getByLabel('恢复后希望模型立刻做什么？')).toBeFocused()
  await page.getByLabel('恢复后希望模型立刻做什么？').fill('读取入口协议后核对稳定计划。')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await expect(page.getByLabel(/STATUS\.html/)).not.toBeChecked()
  await expect(page.getByRole('alert').filter({ hasText: '第一动作仍引用未选择的文档' })).toHaveCount(0)
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  await markEveryContentDocumentReviewed(page)
  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()

  await page.locator('.protocol-section-switcher .section-switch').filter({ hasText: '读取顺序' }).click()
  const readOrder = page.locator('textarea[name="protocol-recovery-order-value"]')
  await expect(readOrder).toHaveValue(/必读：AGENTS\.md -> SPEC\.html/)
  await expect(readOrder).toHaveValue(/按需读取：MEMORY\.html/)
  await expect(readOrder).not.toHaveValue(/STATUS\.html/)
  await expect(page.locator('textarea[name="protocol-fallback-next-atomic-step-value"]')).toHaveValue('读取入口协议后核对稳定计划。')
})

test('persists the builder draft and selected documents across a refresh', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await fillBuilderPurpose(page, '刷新后继续的工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await page.getByLabel(/USER\.html/).check()

  await expect(page).toHaveURL(/#build\/step-2$/)
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.localStorage).find((item) => item.startsWith('workflow-studio.builder-draft.v2.'))
    const draft = JSON.parse(key ? window.localStorage.getItem(key) ?? '{}' : '{}') as { projectName?: string }
    return draft.projectName
  })).toBe('刷新后继续的工作流')
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(window.localStorage).find((item) => item.startsWith('workflow-studio.builder-draft.v2.'))
    const draft = JSON.parse(key ? window.localStorage.getItem(key) ?? '{}' : '{}') as { selectedContentDocs?: string[] }
    return draft.selectedContentDocs?.includes('user') ?? false
  })).toBe(true)

  await page.reload()
  await expect(page.getByRole('heading', { name: '先选择需要的内容文档。' })).toBeVisible()
  await expect(page.getByLabel(/USER\.html/)).toBeChecked()
  await page.getByRole('button', { name: '返回用途说明' }).click()
  await expect(page.getByLabel('这个工作流服务哪个项目或任务？')).toHaveValue('刷新后继续的工作流')
  await expect(page.getByLabel('未来模型恢复时最容易丢失什么信息？')).toHaveValue('当前目标、输入材料位置和用户最近确认的边界。')
  await expect(page.getByLabel('恢复后希望模型立刻做什么？')).toHaveValue('先读取 STATUS.html，再检查下一原子步骤。')
})

test('keeps the wizard step in the URL and follows browser history', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await expect(page).toHaveURL(/#build\/step-1$/)
  await expect(page.getByRole('heading', { name: '先说清这套工作流要帮谁接手什么。' })).toBeVisible()

  await fillBuilderPurpose(page, '浏览器历史工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await expect(page).toHaveURL(/#build\/step-2$/)
  await expect(page.getByRole('heading', { name: '先选择需要的内容文档。' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/#build\/step-1$/)
  await expect(page.getByRole('heading', { name: '先说清这套工作流要帮谁接手什么。' })).toBeVisible()
  await expect(page.getByLabel('这个工作流服务哪个项目或任务？')).toHaveValue('浏览器历史工作流')

  await page.goForward()
  await expect(page).toHaveURL(/#build\/step-2$/)
  await expect(page.getByRole('heading', { name: '先选择需要的内容文档。' })).toBeVisible()
})

test('preserves manual protocol content until regeneration is explicitly confirmed', async ({ page }) => {
  await buildToModuleCanvas(page)
  await markEveryContentDocumentReviewed(page)
  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.locator('.protocol-builder-step')).toBeVisible()

  const manualProtocolContent = '手工协议内容：先核对人工确认，再读取 STATUS.html。'
  const firstProtocolField = page.locator('.protocol-review-grid .module-field-editor').first()
  await firstProtocolField.getByLabel('当前内容').fill(manualProtocolContent)
  await expect(page.getByText('协议修改已保存。系统不会自动重生成并覆盖这些内容。')).toBeVisible()

  await page.getByRole('button', { name: '返回内容文档' }).click()
  await expect(page.locator('.module-builder-step')).toBeVisible()
  await page.getByRole('button', { name: '进入入口协议审查' }).click()
  await expect(page.locator('.protocol-builder-step')).toBeVisible()
  await expect(page.getByText('已保留当前入口协议草案，没有覆盖导入或手工修改。请继续审查各模块。')).toBeVisible()
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(manualProtocolContent)

  const regenerateButton = page.getByRole('button', { name: '重新生成草案' })
  let dismissedDialogs = 0
  const dismissRegeneration = async (dialog: Dialog) => {
    dismissedDialogs += 1
    await dialog.dismiss()
  }
  page.on('dialog', dismissRegeneration)
  await regenerateButton.click()
  await expect.poll(() => dismissedDialogs).toBe(2)
  page.off('dialog', dismissRegeneration)
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(manualProtocolContent)

  let acceptedDialogs = 0
  const acceptRegeneration = async (dialog: Dialog) => {
    acceptedDialogs += 1
    await dialog.accept()
  }
  page.on('dialog', acceptRegeneration)
  await regenerateButton.click()
  await expect.poll(() => acceptedDialogs).toBe(2)
  page.off('dialog', acceptRegeneration)
  await expect(page.getByText('入口协议和恢复规则已重新生成；之前的手工修改已被替换。')).toBeVisible()
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).not.toHaveValue(manualProtocolContent)
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(/STATUS\.html/)
})

test('does not silently overwrite AGENTS edits made before the first protocol review', async ({ page }) => {
  await buildToModuleCanvas(page)
  await page.getByRole('button', { name: '打开高级文档编辑' }).click()
  await expect(page).toHaveURL(/#advanced\/documents$/)
  const manualProtocolContent = '首次审查前保留的人工入口协议。'
  await page.getByLabel('当前内容').first().fill(manualProtocolContent)
  await page.getByRole('link', { name: '工作流搭建', exact: true }).click()
  await expect(page.locator('.module-builder-step')).toBeVisible()
  await markEveryContentDocumentReviewed(page)

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('AGENTS.md 已被手工修改')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.locator('.protocol-builder-step')).toBeVisible()
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(manualProtocolContent)
})

test('keeps the active builder step visible without horizontal page overflow on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile viewport regression')

  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await expectActiveBuildStepFullyVisible(page, 1)
  await expect(page.getByLabel('写入地图')).toBeVisible()
  await expect.poll(() => page.locator('.topbar').evaluate((element) => getComputedStyle(element).position)).toBe('static')
  await expect.poll(() => page.locator('.topbar').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(72)

  await fillBuilderPurpose(page, '移动端回归工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await expect(page.locator('#materials-title')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 2)
  await expect(page.getByLabel('写入地图')).toBeVisible()

  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  await expect(page.locator('.module-builder-step')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 3)
  await expect(page.getByLabel('写入地图')).toBeVisible()
  await expect(page.locator('.canvas-section-list .module-section-editor')).toHaveCount(1)
  await expect(page.locator('.canvas-section-list .module-field-editor[open]')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(5000)

  await markEveryContentDocumentReviewed(page)
  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.locator('.protocol-builder-step')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 4)
  await expect(page.getByLabel('写入地图')).toBeVisible()
  await expect(page.locator('.protocol-review-grid .module-section-editor')).toHaveCount(1)
  await expect(page.locator('.protocol-review-grid .module-field-editor[open]')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4000)

  await page.getByRole('button', { name: '查看结果预览' }).click()
  await expect(page.locator('#preview-title')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 5)
  await expect(page.getByLabel('写入地图')).toBeVisible()

  await page.getByRole('button', { name: '进入演练与导出' }).click()
  await expect(page.locator('#export-ready-title')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 6)
  await expect(page.getByLabel('写入地图')).toBeVisible()
})

test('supports the core advanced workflow design path', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await expect(page).toHaveURL(/#advanced\/overview$/)

  await expect(page.getByRole('heading', { name: /当前工作流.*交付/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '使用标准恢复文档' })).toBeVisible()
  await expect(page.getByText('关系图与恢复路径')).toBeVisible()
  await expect(page.locator('.graph-node')).toHaveCount(6)

  await page.getByRole('link', { name: /写给未来模型看的资料/ }).click()
  await expect(page).toHaveURL(/#advanced\/documents$/)
  await expect(page.getByRole('heading', { name: '写给未来模型看的资料' })).toBeVisible()
  await page.getByLabel('标题').first().fill('自动化验收协议')

  await page.getByRole('link', { name: /演练断线后如何恢复/ }).click()
  await expect(page).toHaveURL(/#advanced\/simulation$/)
  await page.getByRole('button', { name: /演练新会话恢复/ }).click()
  await expect(page.getByRole('heading', { name: '演练断线后如何恢复' })).toBeVisible()
  await expect(page.getByText('推导下一原子步骤')).toBeVisible()

  await page.getByRole('link', { name: /生成可复制的工作流包/ }).click()
  await expect(page).toHaveURL(/#advanced\/export$/)
  await expect(page.getByRole('heading', { name: /生成可复制的.*工作流包/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载工作流包', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'workflow.json', exact: true })).toBeVisible()
  await expect(page.frameLocator('iframe.document-preview-frame').getByRole('heading', { level: 1, name: '稳定计划' })).toBeVisible()
})

test('creates a blank workflow, resolves validation error, switches format, and downloads ZIP', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await page.getByRole('button', { name: '创建最小工作流' }).click()

  await page.getByRole('link', { name: /生成可复制的工作流包/ }).click()
  await expect(page.getByRole('button', { name: '下载工作流包', exact: true })).toBeDisabled()
  await expect(page.getByText('必填字段为空').first()).toBeVisible()

  await page.getByRole('link', { name: /写给未来模型看的资料/ }).click()
  await page.getByLabel('当前内容').first().fill('AGENTS.md -> SPEC.html -> STATUS.html')
  await page.getByRole('button', { name: /STATUS\.html/ }).click()
  await page.locator('[data-field="blank-next-atomic-step"]').getByLabel('当前内容').fill('继续完善状态快照中的当前目标。')

  await page.getByRole('link', { name: /生成可复制的工作流包/ }).click()
  await page.getByLabel('主维护格式').selectOption('markdown')
  await expect(page.getByRole('button', { name: '下载工作流包', exact: true })).toBeEnabled()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载工作流包', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/workflow\.zip$/)
  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const zip = await JSZip.loadAsync(await readFile(downloadedPath!))
  expect(zip.file('workflow.json')).toBeTruthy()
  expect(zip.file('README.md')).toBeTruthy()
  expect(zip.file('documents/AGENTS.md')).toBeTruthy()
  expect(zip.file('documents/STATUS.md')).toBeTruthy()
  expect(zip.file('documents/MEMORY.md')).toBeTruthy()
})

test('supports advanced field validation, hidden suggestions, and delete confirmation', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await page.getByRole('link', { name: /写给未来模型看的资料/ }).click()

  await page.getByLabel('当前内容').first().fill('短')
  await page.getByText('高级校验与底层值').first().click()
  await page.getByLabel('最小长度').first().fill('10')
  await page.getByRole('button', { name: '检查', exact: true }).click()
  await expect(page.getByText('字段长度不足')).toBeVisible()
  await page.getByRole('button', { name: '关闭检查器' }).click()

  await page.getByLabel('最小长度').first().fill('')
  await page.getByLabel('高级校验').first().fill('error | valid-email | 必须是邮箱')
  await page.getByRole('button', { name: '检查', exact: true }).click()
  await expect(page.getByText('自定义校验未通过')).toBeVisible()
  await page.getByRole('button', { name: '关闭检查器' }).click()
  await page.getByLabel('高级校验').first().fill('')
  await page.getByLabel('当前内容').first().fill('')

  await page.getByText('结构设置').first().click()
  await page.getByLabel('允许多条内容').first().check()
  await page.getByRole('button', { name: '添加内容' }).first().click()
  await page.getByLabel('内容条目 1').fill('alpha')
  await expect(page.getByLabel('内容条目 1')).toHaveValue('alpha')
  await page.locator('.repeatable-row').first().getByRole('button', { name: '复制内容' }).click()
  await expect(page.getByLabel('内容条目 2')).toHaveValue('alpha')
  await page.getByLabel('内容条目 2').fill('beta')
  await page.getByRole('button', { name: '内容上移' }).last().click()
  await expect(page.getByLabel('内容条目 1')).toHaveValue('beta')
  await page.getByRole('button', { name: '删除内容' }).last().click()
  await expect(page.getByLabel('内容条目 2')).toHaveCount(0)
  await page.getByLabel('允许多条内容').first().uncheck()

  await page.getByLabel('当前内容').first().fill('长'.repeat(1900))
  await page.getByRole('button', { name: '检查', exact: true }).click()
  await expect(page.getByText('字段内容过长')).toBeVisible()
  await page.getByRole('button', { name: '隐藏 Suggestion' }).click()
  await expect(page.getByText('字段内容过长')).toBeHidden()
  await page.getByRole('button', { name: '关闭检查器' }).click()

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('删除字段')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: '删除字段' }).first().click()
  await expect(page.getByLabel('字段名').first()).toHaveValue('读取顺序')

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('删除字段')
    await dialog.accept()
  })
  await page.getByRole('button', { name: '删除字段' }).first().click()
  await expect(page.getByText('这个章节还没有字段。')).toBeVisible()
})

test('keeps focus while editing source priority labels', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await page.getByRole('link', { name: /规定未来模型怎么读/ }).click()

  const sourceName = page.getByLabel('显示名称').first()
  await sourceName.fill('')
  await sourceName.pressSequentially('用户最新指令')

  await expect(sourceName).toBeFocused()
  await expect(sourceName).toHaveValue('用户最新指令')
})
