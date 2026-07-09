import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

async function openAdvanced(page: Page) {
  await page.getByRole('button', { name: '高级编辑', exact: true }).click()
}

test('starts from a beginner friendly home page with two primary entries', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /为未来接手项目的模型/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '进入工作流入门' })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始搭建工作流' })).toBeVisible()
  await expect(page.getByText('关系图与恢复路径')).toBeHidden()

  await page.getByRole('button', { name: '进入工作流入门' }).click()
  await expect(page.getByRole('heading', { name: '先弄懂工作流，再开始填内容。' })).toBeVisible()
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
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()

  await expect(page.getByRole('heading', { name: '逐份文档搭建模块。' })).toBeVisible()
  await expect(page.getByRole('button', { name: /STATUS\.html/ })).toBeVisible()
  await expect(page.locator('.write-map').getByText('写入地图', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '证据或验证方式' }).first().click()
  await expect(page.getByText('已添加字段模块')).toBeVisible()

  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  await expect(page.getByRole('heading', { name: '审查系统生成的入口协议草案。' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '文档清单' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '读取顺序' })).toBeVisible()
  await expect(page.locator('.protocol-review-grid').getByText('USER.html').first()).toBeVisible()

  await page.getByRole('button', { name: '查看结果预览' }).click()
  await expect(page.getByRole('heading', { name: '结果预览：文件树、模块分布和恢复路径。' })).toBeVisible()
  await expect(page.getByText('documents/AGENTS.html')).toBeVisible()
  await expect(page.getByText('HTML 预览')).toBeVisible()
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
