import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

async function openAdvanced(page: Page) {
  await page.getByRole('button', { name: '高级编辑', exact: true }).click()
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

async function markEveryContentDocumentReviewed(page: Page) {
  const documentTabs = page.locator('.document-tab-row .module-doc-card')
  const documentCount = await documentTabs.count()
  expect(documentCount).toBeGreaterThan(0)

  for (let index = 0; index < documentCount; index += 1) {
    await documentTabs.nth(index).click()
    const reviewButton = page.getByRole('button', { name: '标记这份文档已检查', exact: true })
    await expect(reviewButton).toBeEnabled()
    await reviewButton.click()
    await expect(documentTabs.nth(index).locator('.document-review-state')).toHaveText('已检查')
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
    const visibleLeft = Math.max(0, scroller?.left ?? 0)
    const visibleRight = Math.min(window.innerWidth, scroller?.right ?? window.innerWidth)
    const visibleTop = Math.max(0, scroller?.top ?? 0)
    const visibleBottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight)
    return rect.left >= visibleLeft - 1
      && rect.right <= visibleRight + 1
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

  await expect(page.getByRole('heading', { name: /为未来接手项目的模型/ })).toBeVisible()
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
  await expect(page.getByRole('button', { name: /STATUS\.html/ })).toBeVisible()
  await expect(page.locator('.write-map').getByText('写入地图', { exact: true })).toBeVisible()
  await expect(page.locator('.write-map').first()).toContainText('STATUS.html > 当前目标与下一步 > 当前目标')

  const moduleCanvas = page.locator('.module-canvas')
  const documentMeta = moduleCanvas.locator('.canvas-document-head')
  await documentMeta.getByLabel('文档标题').fill('交付状态快照')
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

  const fieldCountBeforeCopy = await firstSection.locator('.module-field-editor').count()
  await firstField.getByRole('button', { name: '复制字段 本轮交付目标' }).click()
  await expect(firstSection.locator('.module-field-editor')).toHaveCount(fieldCountBeforeCopy + 1)
  await expect(firstSection.locator('.module-field-editor').nth(1).getByLabel('字段名称')).toHaveValue('本轮交付目标 副本')

  await firstSection.getByRole('button', { name: '证据或验证方式', exact: true }).click()
  const addedPresetField = firstSection.getByRole('button', { name: '证据或验证方式（已加入）', exact: true })
  await expect(addedPresetField).toBeDisabled()

  await markEveryContentDocumentReviewed(page)

  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.getByRole('heading', { name: '审查系统生成的入口协议草案。' })).toBeVisible()
  const protocolModules = page.locator('.protocol-review-grid .module-section-editor')
  await expect(protocolModules).toHaveCount(5)
  await expect(protocolModules.first().getByLabel('章节名称')).toHaveValue('文档清单')
  await expect(protocolModules.nth(1).getByLabel('章节名称')).toHaveValue('读取顺序')
  await expect(protocolModules.first().getByLabel('当前内容')).toHaveValue(/USER\.html[\s\S]*MEMORY\.html[\s\S]*CONTEXT\.html/)
  await expect(protocolModules.first().getByRole('button', { name: '上移章节 文档清单' })).toBeDisabled()
  await expect(protocolModules.first().getByRole('button', { name: '下移章节 文档清单' })).toBeVisible()
  await expect(protocolModules.first().getByRole('button', { name: '复制章节 文档清单' })).toBeVisible()
  await expect(protocolModules.first().getByRole('button', { name: '删除章节 文档清单' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新增协议模块' })).toBeVisible()

  await page.getByRole('button', { name: '查看结果预览' }).click()
  await expect(page.getByRole('heading', { name: '结果预览：文件树、模块分布和恢复路径。' })).toBeVisible()
  await expect(page.getByText('documents/AGENTS.md')).toBeVisible()
  await expect(page.getByText('documents/CONTEXT.html')).toBeVisible()
  const htmlPreview = page.locator('iframe.document-preview-frame')
  await expect(htmlPreview).toBeVisible()
  await expect(htmlPreview).toHaveAttribute('title', 'SPEC.html 渲染预览')
  await expect(htmlPreview).toHaveAttribute('sandbox', '')
  await expect(page.frameLocator('iframe.document-preview-frame').getByRole('heading', { level: 1, name: '稳定计划' })).toBeVisible()
})

test('persists the builder draft and selected documents across a refresh', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await fillBuilderPurpose(page, '刷新后继续的工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await page.getByLabel(/USER\.html/).check()

  await expect(page).toHaveURL(/#build\/step-2$/)
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(window.localStorage.getItem('workflow-studio.builder-draft.v1') ?? '{}') as { projectName?: string }
    return draft.projectName
  })).toBe('刷新后继续的工作流')
  await expect.poll(() => page.evaluate(() => {
    const draft = JSON.parse(window.localStorage.getItem('workflow-studio.builder-draft.v1') ?? '{}') as { selectedContentDocs?: string[] }
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
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('重新生成会覆盖当前 AGENTS.md')
    await dialog.dismiss()
  })
  await regenerateButton.click()
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(manualProtocolContent)

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('重新生成会覆盖当前 AGENTS.md')
    await dialog.accept()
  })
  await regenerateButton.click()
  await expect(page.getByText('入口协议草案已重新生成；之前的手工协议修改已被替换。')).toBeVisible()
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).not.toHaveValue(manualProtocolContent)
  await expect(page.locator('.protocol-review-grid .module-field-editor').first().getByLabel('当前内容')).toHaveValue(/STATUS\.html/)
})

test('keeps the active builder step visible without horizontal page overflow on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile viewport regression')

  await page.goto('/')
  await page.getByRole('button', { name: '开始搭建工作流' }).click()
  await expectActiveBuildStepFullyVisible(page, 1)

  await fillBuilderPurpose(page, '移动端回归工作流')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  await expect(page.locator('#materials-title')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 2)

  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  await expect(page.locator('.module-builder-step')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 3)

  await markEveryContentDocumentReviewed(page)
  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.locator('.protocol-builder-step')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 4)

  await page.getByRole('button', { name: '查看结果预览' }).click()
  await expect(page.locator('#preview-title')).toBeVisible()
  await expectActiveBuildStepFullyVisible(page, 5)
})

test('supports the core advanced workflow design path', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)

  await expect(page.getByRole('heading', { name: /当前工作流.*交付/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '使用标准恢复文档' })).toBeVisible()
  await expect(page.getByText('关系图与恢复路径')).toBeVisible()
  await expect(page.locator('.graph-node')).toHaveCount(6)

  await page.getByRole('button', { name: /写给未来模型看的资料/ }).click()
  await expect(page.getByRole('heading', { name: '写给未来模型看的资料' })).toBeVisible()
  await page.getByLabel('标题').first().fill('自动化验收协议')

  await page.getByRole('button', { name: /演练断线后如何恢复/ }).click()
  await page.getByRole('button', { name: /演练新会话恢复/ }).click()
  await expect(page.getByRole('heading', { name: '演练断线后如何恢复' })).toBeVisible()
  await expect(page.getByText('推导下一原子步骤')).toBeVisible()

  await page.getByRole('button', { name: /生成可复制的工作流包/ }).click()
  await expect(page.getByRole('heading', { name: '生成可复制的工作流包' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下载工作流包', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'workflow.json', exact: true })).toBeVisible()
})

test('creates a blank workflow, resolves validation error, switches format, and downloads ZIP', async ({ page }) => {
  await page.goto('/')
  await openAdvanced(page)
  await page.getByRole('button', { name: '创建最小工作流' }).click()

  await page.getByRole('button', { name: /生成可复制的工作流包/ }).click()
  await expect(page.getByRole('button', { name: '下载工作流包', exact: true })).toBeDisabled()
  await expect(page.getByText('必填字段为空').first()).toBeVisible()

  await page.getByRole('button', { name: /写给未来模型看的资料/ }).click()
  await page.getByLabel('当前内容').first().fill('AGENTS.md -> SPEC.html -> STATUS.html')
  await page.getByRole('button', { name: /STATUS\.html/ }).click()
  await page.locator('[data-field="blank-next-atomic-step"]').getByLabel('当前内容').fill('继续完善状态快照中的当前目标。')

  await page.getByRole('button', { name: /生成可复制的工作流包/ }).click()
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
  await page.getByRole('button', { name: /写给未来模型看的资料/ }).click()

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
  await page.getByRole('button', { name: /规定未来模型怎么读/ }).click()

  const sourceName = page.getByLabel('显示名称').first()
  await sourceName.fill('')
  await sourceName.pressSequentially('用户最新指令')

  await expect(sourceName).toBeFocused()
  await expect(sourceName).toHaveValue('用户最新指令')
})
