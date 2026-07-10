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

const states = {
  home: { selector: '.mode-home .home-hero', hash: '#home' },
  learn: { selector: '.mode-learn .learn-main', hash: '#learn' },
  'build-purpose': { selector: '#start-title', hash: '#build/step-1', activeStep: 1 },
  'document-selection': { selector: '#materials-title', hash: '#build/step-2', activeStep: 2 },
  'module-canvas': { selector: '.module-builder-step', hash: '#build/step-3', activeStep: 3 },
  'agents-draft-review': { selector: '.protocol-builder-step', hash: '#build/step-4', activeStep: 4 },
  'result-preview': {
    selector: '#preview-title',
    additionalSelectors: ['iframe.document-preview-frame'],
    frameSelector: 'iframe.document-preview-frame',
    frameContentSelector: 'h1',
    hash: '#build/step-5',
    activeStep: 5,
  },
  export: {
    selector: '#export-title',
    additionalSelectors: ['iframe.document-preview-frame'],
    frameSelector: 'iframe.document-preview-frame',
    frameContentSelector: 'h1',
    viewportOnly: true,
    hash: '#advanced/export',
  },
}

async function waitForState(page, expected) {
  await page.locator(expected.selector).waitFor({ state: 'visible' })
  for (const selector of expected.additionalSelectors ?? []) await page.locator(selector).waitFor({ state: 'visible' })
  if (expected.frameSelector && expected.frameContentSelector) {
    await page.frameLocator(expected.frameSelector).locator(expected.frameContentSelector).waitFor({ state: 'visible' })
  }
  await page.waitForFunction(({ hash, activeStep }) => {
    const activeStepNumber = document.querySelector('.stepper li.active span')?.textContent?.trim()
    return window.location.hash === hash && (activeStep === undefined || activeStepNumber === String(activeStep))
  }, { hash: expected.hash, activeStep: expected.activeStep })
  if (expected.activeStep !== undefined) await page.waitForTimeout(450)
}

async function metrics(page, label, expected) {
  return page.evaluate(({ currentLabel, currentExpected }) => {
    const root = document.documentElement
    const body = document.body
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
    const moduleChoiceContentOverflows = [...document.querySelectorAll('.module-choice-button')].filter((button) => {
      const buttonRect = button.getBoundingClientRect()
      return [...button.children].some((child) => {
        const childRect = child.getBoundingClientRect()
        return childRect.left < buttonRect.left - 1 || childRect.right > buttonRect.right + 1
      })
    }).length
    const selectorIsVisible = (selector) => {
      const element = document.querySelector(selector)
      const rect = element?.getBoundingClientRect()
      const style = element ? getComputedStyle(element) : null
      return Boolean(
        rect
        && style
        && rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden',
      )
    }
    const expectedElementVisible = selectorIsVisible(currentExpected.selector)
    const additionalSelectorsVisible = (currentExpected.additionalSelectors ?? []).every(selectorIsVisible)
    const activeStep = document.querySelector('.stepper li.active')
    const activeStepRect = activeStep?.getBoundingClientRect()
    const stepperRect = activeStep?.closest('.stepper')?.getBoundingClientRect()
    const activeStepNumber = activeStep?.querySelector('span')?.textContent?.trim() ?? null
    const activeStepFullyVisible = activeStepRect && stepperRect
      ? activeStepRect.left >= Math.max(0, stepperRect.left) - 1
        && activeStepRect.right <= Math.min(window.innerWidth, stepperRect.right) + 1
        && activeStepRect.top >= Math.max(0, stepperRect.top) - 1
        && activeStepRect.bottom <= Math.min(window.innerHeight, stepperRect.bottom) + 1
      : null
    const expectedStepMatches = currentExpected.activeStep === undefined
      ? true
      : activeStepNumber === String(currentExpected.activeStep)
    const hashMatches = window.location.hash === currentExpected.hash
    return {
      label: currentLabel,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      scrollY: window.scrollY,
      horizontalOverflow: Math.max(0, Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth),
      expectedSelector: currentExpected.selector,
      expectedHash: currentExpected.hash,
      actualHash: window.location.hash,
      expectedElementVisible,
      additionalSelectorsVisible,
      expectedStep: currentExpected.activeStep ?? null,
      activeStepNumber,
      activeStepFullyVisible,
      activeStepRect: activeStepRect
        ? { left: activeStepRect.left, right: activeStepRect.right, top: activeStepRect.top, bottom: activeStepRect.bottom }
        : null,
      pageStateCorrect: expectedElementVisible && additionalSelectorsVisible && hashMatches && expectedStepMatches,
      onboardingRawTerms: [...new Set(rawTerms)],
      homePrimaryEntries: document.querySelectorAll('.home-entry .button').length,
      writeMapVisible,
      protocolMapVisible: document.body.innerText.includes('协议地图'),
      moduleWorkbenchColumns,
      documentTabColumns,
      moduleChoiceContentOverflows,
    }
  }, { currentLabel: label, currentExpected: expected })
}

async function capture(page, viewportName, stateName) {
  const expected = states[stateName]
  if (!expected) throw new Error(`Unknown screenshot state: ${stateName}`)
  await waitForState(page, expected)
  if (expected.frameSelector) {
    await page.locator(expected.frameSelector).scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
  }
  if (!expected.viewportOnly && !expected.frameSelector) {
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }))
  }
  await page.waitForTimeout(50)
  const file = `${viewportName}-${stateName}.png`
  const screenshotStyle = expected.frameSelector && !expected.viewportOnly
    ? await page.addStyleTag({ content: '.topbar, .stepper, .sticky-map { position: static !important; }' })
    : null
  try {
    if (expected.captureSelector) {
      await page.locator(expected.captureSelector).screenshot({ path: path.join(outputDir, file) })
    } else {
      await page.screenshot({ path: path.join(outputDir, file), fullPage: !expected.viewportOnly })
    }
  } finally {
    await screenshotStyle?.evaluate((element) => element.remove())
  }
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }))
  return metrics(page, `${viewportName}:${stateName}`, expected)
}

async function markEveryContentDocumentReviewed(page) {
  const documentTabs = page.locator('.document-tab-row .module-doc-card')
  const documentCount = await documentTabs.count()
  if (documentCount === 0) throw new Error('Module canvas has no content documents to review.')

  for (let index = 0; index < documentCount; index += 1) {
    const documentTab = documentTabs.nth(index)
    const filename = (await documentTab.locator('code').textContent())?.trim()
    if (!filename) throw new Error(`Content document ${index + 1} has no filename.`)
    const mobilePicker = page.getByLabel('当前编辑文档')
    if (await mobilePicker.isVisible()) {
      const value = await mobilePicker.locator('option').filter({ hasText: filename }).getAttribute('value')
      if (!value) throw new Error(`Content document ${filename} is missing from the mobile picker.`)
      await mobilePicker.selectOption(value)
    } else {
      await documentTab.click()
    }
    const reviewButton = page.locator('.document-reviewed-button')
    await reviewButton.waitFor({ state: 'visible' })
    if (!await reviewButton.isEnabled()) throw new Error(`Content document ${index + 1} has blocking validation errors.`)
    await reviewButton.click()
    await documentTab.locator('.document-review-state').filter({ hasText: '已检查' }).waitFor({ state: 'attached' })
  }

  await page.getByLabel('内容文档检查进度').getByText(`${documentCount}/${documentCount} 份文档已检查`).waitFor({ state: 'visible' })
  const reviewProtocolButton = page.getByRole('button', { name: '生成并审查入口协议草案' })
  if (!await reviewProtocolButton.isEnabled()) throw new Error('Protocol review remained disabled after every content document was reviewed.')
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

  await markEveryContentDocumentReviewed(page)
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
  !item.pageStateCorrect ||
  (item.expectedStep !== null && item.activeStepFullyVisible !== true) ||
  item.onboardingRawTerms.length > 0 ||
  item.protocolMapVisible ||
  item.moduleChoiceContentOverflows > 0 ||
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
