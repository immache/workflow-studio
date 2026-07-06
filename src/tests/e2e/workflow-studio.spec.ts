import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

test('supports the core workflow design path', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /可恢复、可维护、可导出/ })).toBeVisible()
  await expect(page.getByText('关系图与恢复路径')).toBeVisible()
  await expect(page.locator('.graph-node')).toHaveCount(6)

  await page.getByRole('button', { name: '文档' }).click()
  await expect(page.getByRole('heading', { name: '文档、章节与字段' })).toBeVisible()
  await page.getByLabel('标题').first().fill('自动化验收协议')

  await page.getByRole('button', { name: '模拟' }).click()
  await page.getByRole('button', { name: /运行模拟/ }).click()
  await expect(page.getByRole('heading', { name: '恢复模拟器' })).toBeVisible()
  await expect(page.getByText('推导下一原子步骤')).toBeVisible()

  await page.getByRole('button', { name: '导出' }).click()
  await expect(page.getByRole('heading', { name: '预览与导出' })).toBeVisible()
  await expect(page.getByRole('button', { name: /下载 ZIP/ })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'workflow.json', exact: true })).toBeVisible()
})

test('creates a blank workflow, resolves validation error, switches format, and downloads ZIP', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '空白' }).click()

  await page.getByRole('button', { name: '导出' }).click()
  await expect(page.getByRole('button', { name: /下载 ZIP/ })).toBeDisabled()
  await expect(page.getByText('必填字段为空').first()).toBeVisible()

  await page.getByRole('button', { name: '文档' }).click()
  await page.getByLabel('值槽').first().fill('AGENTS.md -> SPEC.html -> STATUS.html')
  await page.getByRole('button', { name: 'STATUS.html', exact: true }).click()
  await page.locator('[data-field="blank-next-atomic-step"]').getByLabel('值槽').fill('继续完善状态快照中的当前目标。')

  await page.getByRole('button', { name: '导出' }).click()
  await page.getByLabel('主维护格式').selectOption('markdown')
  await expect(page.getByRole('button', { name: /下载 ZIP/ })).toBeEnabled()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /下载 ZIP/ }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/workflow\.zip$/)
  const downloadedPath = await download.path()
  expect(downloadedPath).toBeTruthy()
  const zip = await JSZip.loadAsync(await readFile(downloadedPath!))
  expect(zip.file('workflow.json')).toBeTruthy()
  expect(zip.file('README.md')).toBeTruthy()
  expect(zip.file('documents/AGENTS.md')).toBeTruthy()
  expect(zip.file('documents/STATUS.md')).toBeTruthy()
})

test('supports advanced field validation, hidden suggestions, and delete confirmation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '文档' }).click()

  await page.getByLabel('值槽').first().fill('短')
  await page.getByLabel('最小长度').first().fill('10')
  await expect(page.getByText('字段长度不足')).toBeVisible()

  await page.getByLabel('最小长度').first().fill('')
  await page.getByLabel('自定义校验').first().fill('error | valid-email | 必须是邮箱')
  await expect(page.getByText('自定义校验未通过')).toBeVisible()
  await page.getByLabel('自定义校验').first().fill('')
  await page.getByLabel('值槽').first().fill('')

  await page.getByLabel('多条实例').first().check()
  await page.getByRole('button', { name: '添加实例' }).first().click()
  await page.getByLabel('实例 1').fill('alpha')
  await expect(page.getByLabel('实例 1')).toHaveValue('alpha')
  await page.locator('.repeatable-row').first().getByRole('button', { name: '复制实例' }).click()
  await expect(page.getByLabel('实例 2')).toHaveValue('alpha')
  await page.getByLabel('实例 2').fill('beta')
  await page.getByRole('button', { name: '实例上移' }).last().click()
  await expect(page.getByLabel('实例 1')).toHaveValue('beta')
  await page.getByRole('button', { name: '删除实例' }).last().click()
  await expect(page.getByLabel('实例 2')).toHaveCount(0)
  await page.getByLabel('多条实例').first().uncheck()

  await page.getByLabel('值槽').first().fill('长'.repeat(1900))
  await expect(page.getByText('字段内容过长')).toBeVisible()
  await page.getByRole('button', { name: '隐藏 Suggestion' }).click()
  await expect(page.getByText('字段内容过长')).toBeHidden()

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
