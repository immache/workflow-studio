import { chromium, devices } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const baseUrl = process.env.WORKFLOW_STUDIO_URL ?? 'http://127.0.0.1:4173/'
const outputDir = path.join(process.cwd(), 'artifacts', 'handoff-screenshots')

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 } },
  { name: 'tablet', viewport: { width: 1024, height: 900 } },
  { name: 'mobile', viewport: { width: 393, height: 852 }, device: devices['Pixel 7'] },
]

async function metrics(page, label) {
  return page.evaluate((currentLabel) => {
    const root = document.documentElement
    const onboarding = document.querySelector('.onboarding-main')
    const rawTerms = onboarding?.innerText.match(/shortText|lifecycle|sourceType|recencyPolicy|prefer-newer|FieldType|sourcePriority/g) ?? []
    const writeMapVisible = Boolean(document.querySelector('.write-map'))
    const moduleWorkbench = document.querySelector('.module-workbench')
    const moduleWorkbenchColumns = moduleWorkbench
      ? getComputedStyle(moduleWorkbench).gridTemplateColumns.split(' ').filter(Boolean).length
      : 0
    const documentTabRow = document.querySelector('.document-tab-row')
    const documentTabColumns = documentTabRow
      ? getComputedStyle(documentTabRow).gridTemplateColumns.split(' ').filter(Boolean).length
      : 0
    return {
      label: currentLabel,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      scrollY: window.scrollY,
      horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      onboardingRawTerms: [...new Set(rawTerms)],
      homePrimaryEntries: document.querySelectorAll('.home-entry .button').length,
      writeMapVisible,
      protocolMapVisible: document.body.innerText.includes('协议地图'),
      moduleWorkbenchColumns,
      documentTabColumns,
    }
  }, label)
}

async function capture(page, viewportName, stateName) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }))
  const file = `${viewportName}-${stateName}.png`
  await page.screenshot({ path: path.join(outputDir, file), fullPage: true })
  return metrics(page, `${viewportName}:${stateName}`)
}

async function runViewport(browser, config) {
  const context = await browser.newContext({
    ...(config.device ?? {}),
    viewport: config.viewport,
    locale: 'zh-CN',
  })
  const page = await context.newPage()
  const results = []

  await page.goto(baseUrl)
  results.push(await capture(page, config.name, 'home'))

  await page.locator('.home-entry .button').first().click()
  results.push(await capture(page, config.name, 'learn'))

  await page.locator('.learn-cta .button').click()
  results.push(await capture(page, config.name, 'build-purpose'))

  await page.getByLabel('这个工作流服务哪个项目或任务？').fill('截图验收工作流')
  await page.getByLabel('未来模型恢复时最容易丢失什么信息？').fill('当前目标、已验证事实和下一原子步骤。')
  await page.getByLabel('恢复后希望模型立刻做什么？').fill('先读取 STATUS.html，再继续执行下一原子步骤。')
  await page.getByRole('button', { name: '继续选择内容文档' }).click()
  results.push(await capture(page, config.name, 'document-selection'))

  await page.getByLabel(/USER\.html/).check()
  await page.getByRole('button', { name: '生成文档并进入模块画布' }).click()
  results.push(await capture(page, config.name, 'module-canvas'))

  await page.getByRole('button', { name: '生成并审查入口协议草案' }).click()
  results.push(await capture(page, config.name, 'agents-draft-review'))

  await page.getByRole('button', { name: '查看结果预览' }).click()
  results.push(await capture(page, config.name, 'result-preview'))

  await page.getByRole('button', { name: '打开完整导出页' }).click()
  results.push(await capture(page, config.name, 'export'))

  await context.close()
  return results
}

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch()
const allMetrics = []
try {
  for (const viewport of viewports) {
    allMetrics.push(...await runViewport(browser, viewport))
  }
} finally {
  await browser.close()
}

await writeFile(path.join(outputDir, 'metrics.json'), `${JSON.stringify(allMetrics, null, 2)}\n`, 'utf8')
const failures = allMetrics.filter((item) =>
  item.horizontalOverflow > 0 ||
  item.onboardingRawTerms.length > 0 ||
  item.protocolMapVisible ||
  (item.label.includes(':module-canvas') && !item.label.startsWith('mobile:') && item.moduleWorkbenchColumns > 2) ||
  (item.label.includes(':module-canvas') && !item.label.startsWith('mobile:') && item.documentTabColumns > 2) ||
  (item.label.startsWith('mobile:module-canvas') && item.documentTabColumns > 1) ||
  (
    ['document-selection', 'module-canvas', 'agents-draft-review'].some((state) => item.label.endsWith(state)) &&
    !item.writeMapVisible
  ),
)
if (failures.length > 0) {
  throw new Error(`Screenshot acceptance failed: ${JSON.stringify(failures, null, 2)}`)
}
console.log(`Captured ${allMetrics.length} states into ${outputDir}`)
