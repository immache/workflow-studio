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
    const rawTerms = onboarding?.innerText.match(/shortText|lifecycle|sourceType|recencyPolicy|prefer-newer|FieldType/g) ?? []
    return {
      label: currentLabel,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      scrollY: window.scrollY,
      horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      onboardingRawTerms: [...new Set(rawTerms)],
      homePrimaryEntries: document.querySelectorAll('.home-entry .button').length,
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
  results.push(await capture(page, config.name, 'build-start'))

  await page.locator('.start-grid .start-card').nth(1).click()
  await page.locator('.question-form input').fill('截图验收工作流')
  await page.locator('.question-form textarea').nth(0).fill('当前目标、已验证事实和下一原子步骤。')
  await page.locator('.question-form textarea').nth(1).fill('先读取 STATUS.html，再继续执行下一原子步骤。')
  await page.locator('.builder-actions .button-primary').click()
  await page.getByLabel(/长期计划/).check()
  await page.locator('.builder-actions .button-primary').click()
  results.push(await capture(page, config.name, 'build-generated'))

  await page.locator('.builder-actions .button-secondary').click()
  results.push(await capture(page, config.name, 'advanced-documents'))

  await page.getByRole('button', { name: /生成可复制的工作流包/ }).click()
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
console.log(`Captured ${allMetrics.length} states into ${outputDir}`)
