import { describe, expect, it } from 'vitest'
import { createCurrentStandardWorkflow } from '../../data/presets/current-standard-workflow'
import {
  DEFAULT_REVIEW_PROMPT,
  buildReviewMaterial,
  compareReviewRequests,
  parseReviewReport,
  reviewReportIsStale,
} from '../../domain/agent-review'
import { withRegeneratedSystemProtocol } from '../../domain/protocol-state'
import { contentDocuments, scalarValue } from '../../domain/schema'

function materialFixture() {
  return buildReviewMaterial({
    workflow: createCurrentStandardWorkflow(),
    userPrompt: DEFAULT_REVIEW_PROMPT,
    protocolStatus: 'confirmed',
  })
}

function findingFixture() {
  const material = materialFixture()
  const document = material.snapshot.documents[0]
  const section = document.sections[0]
  const field = section.fields[0]
  return {
    material,
    finding: {
      id: 'F-001',
      severity: 'must_fix',
      observedLocation: { scope: 'field', documentId: document.id, sectionId: section.id, fieldId: field.id },
      editTarget: { scope: 'field', documentId: document.id, sectionId: section.id, fieldId: field.id, property: 'guidance' },
      title: '说明不够明确',
      analysis: '恢复后的模型无法判断这项资料何时需要更新。',
      recommendation: '用一句话说明更新触发条件。',
      evidence: '当前材料只给出了名称。',
    },
  }
}

describe('agent review material', () => {
  it('sends a whitelist snapshot without ordinary runtime values or schema configuration', () => {
    const workflow = createCurrentStandardWorkflow()
    const field = contentDocuments(workflow)[0].sections[0].fields[0]
    field.value = scalarValue('PRIVATE_RUNTIME_VALUE')
    field.defaultValue = 'PRIVATE_DEFAULT_VALUE'
    field.options = [{ value: 'secret', label: 'PRIVATE_OPTION' }]
    field.validation.customRules.push({ id: 'private-rule', description: 'PRIVATE_VALIDATION', severity: 'error', predicate: 'custom' })
    const material = buildReviewMaterial({
      workflow: withRegeneratedSystemProtocol(workflow),
      userPrompt: DEFAULT_REVIEW_PROMPT,
      protocolStatus: 'draft',
    })

    expect(material.reviewedRequest.materialMessage).not.toContain('PRIVATE_RUNTIME_VALUE')
    expect(material.reviewedRequest.materialMessage).not.toContain('PRIVATE_DEFAULT_VALUE')
    expect(material.reviewedRequest.materialMessage).not.toContain('PRIVATE_OPTION')
    expect(material.reviewedRequest.materialMessage).not.toContain('PRIVATE_VALIDATION')
    expect(material.reviewedRequest.materialMessage).toContain('不可信审查材料')
    expect(material.messages).toHaveLength(3)
    expect(material.reviewedRequest.materialCharacterCount).toBe(Array.from(material.reviewedRequest.materialMessage).length)
  })

  it('includes protocol confirmation and prompt in the input fingerprint', () => {
    const workflow = createCurrentStandardWorkflow()
    const confirmed = buildReviewMaterial({ workflow, userPrompt: 'A', protocolStatus: 'confirmed' })
    const draft = buildReviewMaterial({ workflow, userPrompt: 'A', protocolStatus: 'draft' })
    const changedPrompt = buildReviewMaterial({ workflow, userPrompt: 'B', protocolStatus: 'confirmed' })

    expect(confirmed.inputFingerprint).not.toBe(draft.inputFingerprint)
    expect(confirmed.inputFingerprint).not.toBe(changedPrompt.inputFingerprint)
    expect(confirmed.snapshot.protocol.status).toBe('confirmed')
  })
})

describe('agent review report parser', () => {
  it('accepts a fenced, actionable needs-revision report with a precise target', () => {
    const { material, finding } = findingFixture()
    const content = `\`\`\`json\n${JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '需要先澄清一个会影响恢复判断的说明。',
      },
      findings: [finding],
      limits: [],
    })}\n\`\`\``
    const report = parseReviewReport(content, material.snapshot)

    expect(report.findings[0].editTarget).toEqual(finding.editTarget)
    expect(report.overall.verdict).toBe('needs_revision')
  })

  it('accepts a partially known unassessable result without invented findings', () => {
    const material = materialFixture()
    const report = parseReviewReport(JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'unassessable',
        longTermStability: 'stable',
        maintenanceEfficiency: 'unassessable',
        summary: '资料不足以判断维护成本。',
      },
      findings: [],
      limits: ['需要补充实际维护频率。'],
    }), material.snapshot)

    expect(report.limits).toEqual(['需要补充实际维护频率。'])
  })

  it('normalizes a null limits value only when it means an empty list', () => {
    const material = materialFixture()
    const report = parseReviewReport(JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '有一项资料说明会影响长期恢复判断。',
      },
      findings: [{
        ...findingFixture().finding,
        id: 'F-001',
      }],
      limits: null,
    }), material.snapshot)

    expect(report.limits).toEqual([])
  })

  it('normalizes only unambiguous provider shorthand before strict target validation', () => {
    const material = materialFixture()
    const document = material.snapshot.documents[0]
    const report = parseReviewReport(JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '读取规则和资料说明各有一项需要修订。',
      },
      findings: [
        {
          id: 'F-001',
          severity: 'must_fix',
          observedLocation: { scope: 'protocol', documentId: 'protocol-system', sectionId: 'protocol-read-order', fieldId: 'protocol-read-order-value' },
          editTarget: 'protocol-read-order',
          title: '读取顺序需要调整',
          analysis: '当前读取顺序可能跳过必要资料。',
          recommendation: '把必要资料设为必读。',
          evidence: '协议中的读取规则允许该资料按需读取。',
        },
        {
          id: 'F-002',
          severity: 'should_fix',
          observedLocation: { scope: 'document', documentId: document.id, sectionId: null, fieldId: null },
          editTarget: { documentId: document.id, target: 'description' },
          title: '资料说明需要更具体',
          analysis: '说明没有说清这份资料在恢复时如何使用。',
          recommendation: '补充恢复时机和使用方式。',
          evidence: '资料说明只描述了主题。',
        },
      ],
      limits: [],
    }), material.snapshot)

    expect(report.findings[0].editTarget).toEqual({ scope: 'protocol-read-order' })
    expect(report.findings[1].editTarget).toEqual({ scope: 'document', documentId: document.id, property: 'description' })
  })

  it('keeps an auto-generated protocol finding but removes its impossible field edit target', () => {
    const material = materialFixture()
    const report = parseReviewReport(JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '自动生成的完成检查规则需要进一步澄清。',
      },
      findings: [{
        id: 'F-001',
        severity: 'must_fix',
        observedLocation: { scope: 'field', documentId: 'protocol-system', sectionId: 'protocol-completion', fieldId: 'protocol-completion-value' },
        editTarget: { scope: 'field', documentId: 'protocol-system', sectionId: 'protocol-completion', fieldId: 'protocol-completion-value', property: 'guidance' },
        title: '完成检查需要澄清',
        analysis: '自动生成规则没有指出应如何验证一项关键结果。',
        recommendation: '调整相关资料说明后重新生成入口协议。',
        evidence: '问题位于系统生成的完成检查字段。',
      }],
      limits: [],
    }), material.snapshot)

    expect(report.findings[0].observedLocation).toEqual({ scope: 'protocol', documentId: 'protocol-system', sectionId: 'protocol-completion', fieldId: 'protocol-completion-value' })
    expect(report.findings[0].editTarget).toBeNull()
  })

  it('normalizes a protocol field reported with a section scope', () => {
    const material = materialFixture()
    const report = parseReviewReport(JSON.stringify({
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '读取顺序需要调整，才能保证恢复后不会遗漏关键资料。',
      },
      findings: [{
        id: 'F-001',
        severity: 'must_fix',
        observedLocation: { scope: 'section', documentId: 'protocol-system', sectionId: 'protocol-read-order', fieldId: 'protocol-read-order-value' },
        editTarget: { scope: 'protocol-read-order' },
        title: '读取顺序需要调整',
        analysis: '关键资料被按需读取时，恢复流程可能跳过它。',
        recommendation: '把恢复必需资料设为必读。',
        evidence: '问题位于系统生成的读取顺序字段。',
      }],
      limits: [],
    }), material.snapshot)

    expect(report.findings[0].observedLocation).toEqual({ scope: 'protocol', documentId: 'protocol-system', sectionId: 'protocol-read-order', fieldId: 'protocol-read-order-value' })
    expect(report.findings[0].editTarget).toEqual({ scope: 'protocol-read-order' })
  })

  it('rejects unknown fields, invalid verdict semantics, and mismatched protocol actions', () => {
    const { material, finding } = findingFixture()
    const base = {
      schemaVersion: 'review-report-v1',
      overall: {
        verdict: 'needs_revision',
        longTermStability: 'at_risk',
        maintenanceEfficiency: 'adequate',
        summary: '需要修订。',
      },
      findings: [finding],
      limits: [],
    }
    expect(() => parseReviewReport(JSON.stringify({ ...base, unexpected: true }), material.snapshot)).toThrow('固定格式')
    expect(() => parseReviewReport(JSON.stringify({ ...base, overall: { ...base.overall, longTermStability: 'stable' } }), material.snapshot)).toThrow('固定格式')
    expect(() => parseReviewReport(JSON.stringify({
      ...base,
      findings: [{
        ...finding,
        editTarget: { scope: 'protocol-read-order' },
      }],
    }), material.snapshot)).toThrow('固定格式')
  })
})

describe('agent review lifecycle helpers', () => {
  it('uses a deterministic request order and marks reports stale from their fingerprint', () => {
    expect(compareReviewRequests(
      { version: 1, requestId: 'A', requestedAt: 10 },
      { version: 1, requestId: 'B', requestedAt: 10 },
    )).toBeLessThan(0)
    expect(reviewReportIsStale({ inputFingerprint: 'old' }, 'current')).toBe(true)
    expect(reviewReportIsStale({ inputFingerprint: 'current' }, 'current')).toBe(false)
  })
})
