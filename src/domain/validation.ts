import {
  fieldValueToText,
  isFieldEmpty,
  type ValidationIssue,
  type ValidationTarget,
  type WorkflowDocument,
  type WorkflowSchema,
} from './schema'
import { unsafeDocumentFilenameReason } from './file-safety'
import { projectedFilenameCollisions } from './export-naming'
import { realtimeStatusDocuments, resolveNextAtomicStep } from './recovery-semantics'

function issue(input: Omit<ValidationIssue, 'id'> & { id?: string }): ValidationIssue {
  return {
    id: input.id ?? `${input.ruleId}-${input.target.documentId ?? 'workflow'}-${input.target.fieldId ?? input.target.ruleId ?? 'target'}`,
    ...input,
  }
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function allFields(document: WorkflowDocument) {
  return document.sections.flatMap((section) => section.fields.map((field) => ({ section, field })))
}

function sameTarget(left: ValidationTarget, right: ValidationTarget): boolean {
  return (
    left.documentId === right.documentId &&
    left.sectionId === right.sectionId &&
    left.fieldId === right.fieldId &&
    left.ruleId === right.ruleId
  )
}

function targetExists(workflow: WorkflowSchema, target: ValidationTarget): boolean {
  if (target.fieldId) {
    return workflow.documents.some((document) =>
      (!target.documentId || document.id === target.documentId) &&
      document.sections.some((section) =>
        (!target.sectionId || section.id === target.sectionId) &&
        section.fields.some((field) => field.id === target.fieldId),
      ),
    )
  }
  if (target.sectionId) {
    return workflow.documents.some((document) =>
      (!target.documentId || document.id === target.documentId) &&
      document.sections.some((section) => section.id === target.sectionId),
    )
  }
  if (target.documentId) {
    return workflow.documents.some((document) => document.id === target.documentId)
  }
  if (target.ruleId) {
    return Boolean(
      workflow.rules.recoveryOrder.some((step) => step.id === target.ruleId) ||
      workflow.rules.sourcePriority.some((rule) => rule.id === target.ruleId) ||
      workflow.rules.updateTriggers.some((rule) => rule.id === target.ruleId) ||
      workflow.rules.completionChecks.some((check) => check.id === target.ruleId),
    )
  }
  return true
}

const requiredPresetSections: Record<string, string[]> = {
  'SPEC.html': ['mission', 'success-criteria', 'scope', 'phases', 'persistent-constraints', 'users-scenarios', 'open-questions'],
  'STATUS.html': ['anchor', 'state', 'next-step', 'facts', 'blockers', 'recovery-pointers'],
  'USER.html': ['collaboration', 'output', 'execution', 'user-boundaries', 'user-maintenance-rules'],
  'MEMORY.html': ['memory-usage-section', 'memory-index', 'timeline', 'memory-rules'],
  'CONTEXT.html': ['context-usage-section', 'entry-fields', 'basic-terms', 'custom-term-template', 'context-boundaries', 'context-maintenance-rules'],
}

const protocolCoreModules = [
  { label: '文档清单', sectionIds: ['protocol-doc-list', 'document-responsibility'], titlePattern: /文档(?:清单|职责)/ },
  { label: '读取顺序', sectionIds: ['protocol-read-order', 'recovery-path', 'recovery'], titlePattern: /(?:读取顺序|恢复路径)/ },
  { label: '来源优先级', sectionIds: ['protocol-source-priority', 'source-priority'], titlePattern: /来源优先级/ },
  { label: '更新规则', sectionIds: ['protocol-update-rules', 'update-rules'], titlePattern: /更新规则/ },
  { label: '完成检查', sectionIds: ['protocol-completion', 'completion-protocol'], titlePattern: /(?:完成检查|完成协议)/ },
]

const currentStandardPresetDocuments: Record<string, string> = {
  spec: 'SPEC.html',
  status: 'STATUS.html',
  user: 'USER.html',
  memory: 'MEMORY.html',
  context: 'CONTEXT.html',
}

function isCurrentStandardPresetDocument(document: WorkflowDocument): boolean {
  return currentStandardPresetDocuments[document.id] === document.filename
}

function protocolCoreSection(document: WorkflowDocument, definition: typeof protocolCoreModules[number]) {
  return document.sections.find((section) => definition.sectionIds.includes(section.id) || definition.titlePattern.test(section.title))
}

function usesManagedProtocolTemplate(document: WorkflowDocument): boolean {
  if (document.role !== 'protocol') return false
  return document.id === 'agents' || document.sections.some((section) => section.id.startsWith('protocol-'))
}

function fieldValidationTarget(document: WorkflowDocument, section: WorkflowDocument['sections'][number], fieldId: string): ValidationTarget {
  return { documentId: document.id, sectionId: section.id, fieldId }
}

function customRuleFails(predicate: string, valueText: string, pattern?: string): boolean {
  const text = valueText.trim()
  if (predicate === 'non-empty') return text.length === 0
  if (text.length === 0) return false
  if (predicate === 'valid-url') {
    try {
      const url = new URL(text)
      return !['http:', 'https:'].includes(url.protocol)
    } catch {
      return true
    }
  }
  if (predicate === 'valid-email') {
    return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
  }
  if (predicate === 'valid-path') {
    return text.includes('\u0000') || /[<>:"|?*]/.test(text)
  }
  if (predicate === 'matches-pattern') {
    if (!pattern) return true
    try {
      return !new RegExp(pattern).test(text)
    } catch {
      return true
    }
  }
  if (predicate === 'custom') return false
  return false
}

function targetFingerprint(workflow: WorkflowSchema, target: ValidationTarget): string {
  if (target.fieldId) {
    for (const document of workflow.documents) {
      for (const section of document.sections) {
        const field = section.fields.find((candidate) => candidate.id === target.fieldId)
        if (field) return JSON.stringify({ documentId: document.id, sectionId: section.id, field })
      }
    }
  }
  if (target.sectionId) {
    for (const document of workflow.documents) {
      const section = document.sections.find((candidate) => candidate.id === target.sectionId)
      if (section) return JSON.stringify({ documentId: document.id, section })
    }
  }
  if (target.documentId) {
    const document = workflow.documents.find((candidate) => candidate.id === target.documentId)
    if (document) return JSON.stringify(document)
  }
  if (target.ruleId) {
    return JSON.stringify({
      recovery: workflow.rules.recoveryOrder.find((step) => step.id === target.ruleId),
      sourcePriority: workflow.rules.sourcePriority.find((rule) => rule.id === target.ruleId),
      updateTrigger: workflow.rules.updateTriggers.find((rule) => rule.id === target.ruleId),
      completionCheck: workflow.rules.completionChecks.find((check) => check.id === target.ruleId),
    })
  }
  return JSON.stringify({
    documents: workflow.documents.map((document) => ({ id: document.id, filename: document.filename, role: document.role, lifecycle: document.lifecycle })),
    rules: workflow.rules,
    exportSettings: workflow.exportSettings,
  })
}

export function warningSchemaHash(workflow: WorkflowSchema, target: ValidationTarget): string {
  let hash = 2166136261
  const text = targetFingerprint(workflow, target)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

export function validateWorkflow(workflow: WorkflowSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (workflow.documents.length === 0) {
    issues.push(
      issue({
        severity: 'error',
        title: '缺少文档',
        message: '工作流至少需要一个恢复入口文档。',
        target: {},
        ruleId: 'structure-documents-present',
      }),
    )
  }

  const entityIds = [
    workflow.workflowId,
    ...workflow.documents.flatMap((document) => [
      document.id,
      ...document.sections.flatMap((section) => [section.id, ...section.fields.map((field) => field.id)]),
    ]),
  ]
  const entityIdSet = new Set(entityIds)
  for (const id of duplicateValues(entityIds)) {
    issues.push(
      issue({
        severity: 'error',
        title: 'ID 重复',
        message: `ID ${id} 被多个对象使用，会导致编辑和导出引用混乱。`,
        target: {},
        ruleId: 'structure-unique-ids',
      }),
    )
  }

  const filenames = workflow.documents.map((document) => document.filename.trim())
  for (const filename of duplicateValues(filenames)) {
    const document = workflow.documents.find((candidate) => candidate.filename === filename)
    issues.push(
      issue({
        severity: 'error',
        title: '文件名重复',
        message: `多个文档导出为 ${filename}，会覆盖文件。`,
        target: { documentId: document?.id },
        ruleId: 'structure-unique-filenames',
      }),
    )
  }

  const exportFormats = [workflow.maintenanceFormat, workflow.secondaryFormat].filter((format): format is NonNullable<typeof format> => Boolean(format))
  for (const format of exportFormats) {
    for (const filename of projectedFilenameCollisions(workflow, format)) {
      issues.push(
        issue({
          severity: 'error',
          title: '导出文件名冲突',
          message: `${format === 'html' ? 'HTML' : 'Markdown'} 导出会让多个文档覆盖为 ${filename}。`,
          target: {},
          ruleId: `export-${format}-filename-collision`,
        }),
      )
    }
  }

  for (const document of workflow.documents) {
    const reason = unsafeDocumentFilenameReason(document.filename)
    if (reason) {
      issues.push(
        issue({
          severity: 'error',
          title: '文件名不安全',
          message: `${document.filename || '未命名文件'}：${reason}`,
          target: { documentId: document.id },
          ruleId: 'export-safe-filename',
        }),
      )
    }
  }

  if (workflow.secondaryFormat && workflow.secondaryFormat === workflow.maintenanceFormat) {
    issues.push(
      issue({
        severity: 'error',
        title: '主次格式冲突',
        message: '次级格式不能与主维护格式相同。',
        target: {},
        ruleId: 'export-secondary-format-conflict',
      }),
    )
  }

  const protocolDocuments = workflow.documents.filter((document) => document.role === 'protocol')
  if (protocolDocuments.length === 0) {
    issues.push(
      issue({
        severity: 'error',
        title: '缺少协议入口',
        message: '至少需要一个 role 为 protocol 的文档作为恢复入口。',
        target: {},
        ruleId: 'recovery-protocol-entry',
      }),
    )
  } else if (!protocolDocuments.some((document) => workflow.rules.recoveryOrder[0]?.documentId === document.id)) {
    issues.push(
      issue({
        severity: 'error',
        title: '入口协议不是第一读取项',
        message: '恢复顺序必须从入口协议开始，否则模型可能跳过总规则。',
        target: { documentId: protocolDocuments[0].id },
        ruleId: 'recovery-protocol-first',
      }),
    )
  }

  if (workflow.rules.sourcePriority.length === 0) {
    issues.push(
      issue({
        severity: 'warning',
        title: '缺少来源优先级',
        message: '目标冲突时没有明确裁决规则，建议至少配置全局来源优先级。',
        target: {},
        ruleId: 'recovery-source-priority-present',
        canAccept: true,
      }),
    )
  } else {
    const globalRule = workflow.rules.sourcePriority.find((rule) => rule.scope === 'global') ?? workflow.rules.sourcePriority[0]
    const priorities = globalRule.orderedSources.map((source) => source.priority)
    if (duplicateValues(priorities.map(String)).length > 0) {
      issues.push(
        issue({
          severity: 'warning',
          title: '来源优先级重复',
          message: '同一来源优先级规则中存在重复 priority，排序可能不稳定。',
          target: { ruleId: globalRule.id },
          ruleId: 'recovery-source-priority-order',
          canAccept: true,
        }),
      )
    }
    if (globalRule.orderedSources[0]?.sourceType !== 'latest-user-instruction') {
      issues.push(
        issue({
          severity: 'warning',
          title: '最高来源不是用户指令',
          message: '建议把最新明确用户指令放在全局来源优先级第一位。',
          target: { ruleId: globalRule.id },
          ruleId: 'recovery-source-priority-user-first',
          canAccept: true,
        }),
      )
    }
  }

  if (workflow.rules.recoveryOrder.length === 0) {
    issues.push(
      issue({
        severity: 'error',
        title: '缺少恢复顺序',
        message: '恢复模拟器和后续模型需要明确读取顺序。',
        target: {},
        ruleId: 'recovery-order-present',
      }),
    )
  }

  const documentIds = new Set(workflow.documents.map((document) => document.id))
  const recoveryStepIds = new Set(workflow.rules.recoveryOrder.map((step) => step.id))
  for (const step of workflow.rules.recoveryOrder) {
    if (!documentIds.has(step.documentId)) {
      issues.push(
        issue({
          severity: 'error',
          title: '恢复步骤引用失效',
          message: `恢复步骤 ${step.id} 引用了不存在的文档。`,
          target: { ruleId: step.id },
          ruleId: 'recovery-valid-references',
        }),
      )
    }
    if (step.fallbackStepIds.some((fallbackId) => !recoveryStepIds.has(fallbackId))) {
      issues.push(
        issue({
          severity: 'error',
          title: '备用恢复步骤引用失效',
          message: `恢复步骤 ${step.id} 的备用步骤不存在。`,
          target: { ruleId: step.id },
          ruleId: 'recovery-valid-fallback-references',
        }),
      )
    }
  }

  for (const document of workflow.documents) {
    if (document.readPolicy.dependsOnDocumentIds.some((documentId) => !documentIds.has(documentId))) {
      issues.push(issue({
        severity: 'error',
        title: '文档依赖引用失效',
        message: `${document.filename} 引用了不存在的依赖文档。`,
        target: { documentId: document.id },
        ruleId: 'recovery-valid-document-dependencies',
      }))
    }
  }

  for (const rule of workflow.rules.sourcePriority) {
    if ((rule.targetId && !entityIdSet.has(rule.targetId)) || rule.orderedSources.some((source) => source.documentId && !documentIds.has(source.documentId))) {
      issues.push(issue({
        severity: 'error',
        title: '来源优先级引用失效',
        message: `来源规则 ${rule.id} 引用了不存在的文档。`,
        target: { ruleId: rule.id },
        ruleId: 'recovery-valid-source-references',
      }))
    }
  }

  for (const trigger of workflow.rules.updateTriggers) {
    if (!documentIds.has(trigger.targetDocumentId)) {
      issues.push(issue({
        severity: 'error',
        title: '更新规则引用失效',
        message: `更新规则 ${trigger.id} 指向不存在的文档。`,
        target: { ruleId: trigger.id },
        ruleId: 'maintenance-valid-update-references',
      }))
    }
  }

  for (const check of workflow.rules.completionChecks) {
    if (check.relatedDocumentIds.some((documentId) => !documentIds.has(documentId))) {
      issues.push(issue({
        severity: 'error',
        title: '完成检查引用失效',
        message: `完成检查 ${check.id} 引用了不存在的文档。`,
        target: { ruleId: check.id },
        ruleId: 'completion-valid-document-references',
      }))
    }
  }

  const realtimeDocuments = realtimeStatusDocuments(workflow)
  if (realtimeDocuments.length === 0) {
    issues.push(
      issue({
        severity: 'warning',
        title: '没有实时状态文档',
        message: '未启用实时状态文档；适合静态流程，但持续执行的项目可能难以恢复当前目标和下一步。',
        target: {},
        ruleId: 'recovery-realtime-status',
        canAccept: true,
      }),
    )
  } else if (realtimeDocuments.length > 1) {
    issues.push(
      issue({
        severity: 'warning',
        title: '实时状态分散',
        message: '多个实时文档会增加维护成本，建议明确唯一状态入口。',
        target: { documentId: realtimeDocuments[0].id },
        ruleId: 'responsibility-realtime-duplication',
        canAccept: true,
      }),
    )
  }

  const nextAtomicStep = resolveNextAtomicStep(workflow)
  if (!nextAtomicStep.document) {
    issues.push(issue({
      severity: 'warning',
      title: '未配置下一原子步骤',
      message: '没有状态文档时不会强制下一原子步骤；若工作流需要连续执行，建议启用 STATUS.html。',
      target: {},
      ruleId: 'recovery-next-atomic-step-present',
      canAccept: true,
    }))
  } else if (!nextAtomicStep.field) {
    issues.push(
      issue({
        severity: 'error',
        title: '缺少下一原子步骤字段',
        message: '恢复后需要一个明确字段承载下一原子步骤或等价入口。',
        target: {},
        ruleId: 'recovery-next-atomic-step-present',
      }),
    )
  } else if (!nextAtomicStep.value) {
    issues.push(
      issue({
        severity: 'error',
        title: '下一原子步骤为空',
        message: '下一原子步骤必须具体可执行，否则恢复后没有唯一入口。',
        target: {},
        ruleId: 'recovery-next-atomic-step-value',
      }),
    )
  }

  for (const document of workflow.documents) {
    if (!document.filename.trim() || !document.title.trim()) {
      issues.push(
        issue({
          severity: 'error',
          title: '文档元数据不完整',
          message: '文档必须有文件名和标题。',
          target: { documentId: document.id },
          ruleId: 'structure-document-metadata',
        }),
      )
    }
    if (document.sections.length === 0) {
      issues.push(
        issue({
          severity: 'error',
          title: '文档没有章节',
          message: `${document.title} 至少需要一个章节承载字段。`,
          target: { documentId: document.id },
          ruleId: 'structure-document-sections',
        }),
      )
    }
    const expectedSections = isCurrentStandardPresetDocument(document)
      ? requiredPresetSections[document.filename]
      : undefined
    if (expectedSections) {
      const existing = new Set(document.sections.map((section) => section.id))
      const missing = expectedSections.filter((sectionId) => !existing.has(sectionId))
      if (missing.length > 0) {
        issues.push(
          issue({
            severity: 'error',
            title: '标准预设章节缺失',
            message: `${document.filename} 缺少章节：${missing.join(', ')}。`,
            target: { documentId: document.id },
            ruleId: 'structure-preset-required-sections',
          }),
        )
      }
    }
    if (usesManagedProtocolTemplate(document)) {
      const resolvedCoreModules = protocolCoreModules.map((definition) => ({ definition, section: protocolCoreSection(document, definition) }))
      const missingCoreModules = resolvedCoreModules.filter((item) => !item.section)
      if (missingCoreModules.length > 0) {
        issues.push(issue({
          severity: 'error',
          title: '入口协议核心模块缺失',
          message: `入口协议缺少：${missingCoreModules.map((item) => item.definition.label).join('、')}。`,
          target: { documentId: document.id },
          ruleId: 'structure-protocol-core-modules',
        }))
      }
      const emptyCoreSections = resolvedCoreModules
        .map((item) => item.section)
        .filter((section): section is NonNullable<typeof section> => Boolean(section))
        .filter((section) => !section.fields.some((field) => fieldValueToText(field.value).trim().length > 0))
      if (emptyCoreSections.length > 0) {
        issues.push(issue({
          severity: 'error',
          title: '入口协议核心模块没有内容',
          message: `请为以下模块保留至少一个有内容的字段：${emptyCoreSections.map((section) => section.title).join('、')}。`,
          target: { documentId: document.id, sectionId: emptyCoreSections[0].id },
          ruleId: 'structure-protocol-core-content',
        }))
      }
    }
    if (document.readPolicy.whenToRead.length === 0) {
      issues.push(
        issue({
          severity: 'warning',
          title: '读取策略缺少触发条件',
          message: `${document.title} 没有说明何时读取。`,
          target: { documentId: document.id },
          ruleId: 'maintenance-read-policy',
          canAccept: true,
        }),
      )
    }
    if (document.updatePolicy.updateTriggers.length === 0) {
      issues.push(
        issue({
          severity: 'warning',
          title: '更新策略缺少触发条件',
          message: `${document.title} 没有说明何时维护。`,
          target: { documentId: document.id },
          ruleId: 'maintenance-update-policy',
          canAccept: true,
        }),
      )
    }
    if (document.lifecycle === 'mixed' && document.description.trim().length < 12) {
      issues.push(
        issue({
          severity: 'warning',
          title: '混合生命周期缺少边界说明',
          message: 'mixed 文档需要更清晰说明职责边界，避免混写状态与历史。',
          target: { documentId: document.id },
          ruleId: 'responsibility-mixed-boundary',
          canAccept: true,
        }),
      )
    }

    for (const section of document.sections) {
      if (!section.title.trim() || !section.purpose.trim()) {
        issues.push(
          issue({
            severity: 'error',
            title: '章节说明缺失',
            message: '章节 title 和 purpose 必须可见，避免职责边界不清。',
            target: { documentId: document.id, sectionId: section.id },
            ruleId: 'structure-section-metadata',
          }),
        )
      }
    }

    for (const { section, field } of allFields(document)) {
      if (!field.label.trim() || !field.guidance.trim()) {
        issues.push(
          issue({
            severity: 'error',
            title: '字段说明缺失',
            message: '字段 label 和 guidance 必须常驻可见。',
            target: { documentId: document.id, sectionId: section.id, fieldId: field.id },
            ruleId: 'model-editability-guidance',
          }),
        )
      }
      if (field.required && !field.allowEmpty && isFieldEmpty(field)) {
        issues.push(
          issue({
            severity: 'error',
            title: '必填字段为空',
            message: `${field.label} 是必填字段，但当前没有值。`,
            target: { documentId: document.id, sectionId: section.id, fieldId: field.id },
            ruleId: 'structure-required-field-value',
          }),
        )
      }
      const valueText = fieldValueToText(field.value)
      const validationTarget = fieldValidationTarget(document, section, field.id)
      if (field.value.kind === 'reference' && !entityIdSet.has(field.value.targetId)) {
        issues.push(issue({
          severity: 'error',
          title: '字段引用失效',
          message: `${field.label} 指向不存在的对象。`,
          target: validationTarget,
          ruleId: 'field-validation-reference-target',
        }))
      }
      if (!isFieldEmpty(field) && field.validation.minLength !== undefined && valueText.length < field.validation.minLength) {
        issues.push(
          issue({
            severity: 'error',
            title: '字段长度不足',
            message: `${field.label} 至少需要 ${field.validation.minLength} 个字符。`,
            target: validationTarget,
            ruleId: 'field-validation-min-length',
          }),
        )
      }
      if (field.validation.maxLength !== undefined && valueText.length > field.validation.maxLength) {
        issues.push(
          issue({
            severity: 'error',
            title: '字段长度超限',
            message: `${field.label} 不能超过 ${field.validation.maxLength} 个字符。`,
            target: validationTarget,
            ruleId: 'field-validation-max-length',
          }),
        )
      }
      if (!isFieldEmpty(field) && field.validation.pattern) {
        try {
          if (!new RegExp(field.validation.pattern).test(valueText)) {
            issues.push(
              issue({
                severity: 'error',
                title: '字段格式不匹配',
                message: `${field.label} 不符合配置的 pattern。`,
                target: validationTarget,
                ruleId: 'field-validation-pattern',
              }),
            )
          }
        } catch {
          issues.push(
            issue({
              severity: 'error',
              title: '字段正则无效',
              message: `${field.label} 的 pattern 不是有效正则表达式。`,
              target: validationTarget,
              ruleId: 'field-validation-pattern-invalid',
            }),
          )
        }
      }
      if (!isFieldEmpty(field) && field.validation.allowedValues && field.validation.allowedValues.length > 0) {
        const values = field.value.kind === 'list' ? field.value.value.map(fieldValueToText).filter(Boolean) : [valueText]
        const invalidValue = values.find((value) => !field.validation.allowedValues?.includes(value))
        if (invalidValue) {
          issues.push(
            issue({
              severity: 'error',
              title: '字段选项无效',
              message: `${field.label} 的值 ${invalidValue} 不在允许选项中。`,
              target: validationTarget,
              ruleId: 'field-validation-allowed-values',
            }),
          )
        }
      }
      for (const customRule of field.validation.customRules) {
        if (customRuleFails(customRule.predicate, valueText, field.validation.pattern)) {
          issues.push(
            issue({
              severity: customRule.severity,
              title: '自定义校验未通过',
              message: customRule.description,
              target: validationTarget,
              ruleId: `field-validation-custom-${customRule.id}`,
            }),
          )
        }
      }
      if (fieldValueToText(field.value).length > 1800) {
        issues.push(
          issue({
            severity: 'suggestion',
            title: '字段内容过长',
            message: '长字段可以拆成多个章节，提升恢复时扫描效率。',
            target: { documentId: document.id, sectionId: section.id, fieldId: field.id },
            ruleId: 'readability-long-field',
          }),
        )
      }
    }
  }

  const documentsWithUpdateTriggers = new Set(workflow.rules.updateTriggers.map((rule) => rule.targetDocumentId))
  for (const document of workflow.documents) {
    if (!documentsWithUpdateTriggers.has(document.id)) {
      issues.push(
        issue({
          severity: 'warning',
          title: '更新触发器未覆盖文档',
          message: `${document.title} 没有对应 update trigger。`,
          target: { documentId: document.id },
          ruleId: 'maintenance-update-trigger-coverage',
          canAccept: true,
        }),
      )
    }
  }

  if (workflow.rules.completionChecks.length === 0) {
    issues.push(
      issue({
        severity: 'warning',
        title: '缺少完成检查',
        message: '没有 completionChecks，交付前检查可能只依赖临场记忆。',
        target: {},
        ruleId: 'maintenance-completion-checks',
        canAccept: true,
      }),
    )
  }

  if (workflow.rules.historyPolicy.allowedStatuses.length === 0) {
    issues.push(
      issue({
        severity: 'error',
        title: '历史状态集合为空',
        message: '历史策略必须允许至少一个状态，才能记录演变历史。',
        target: {},
        ruleId: 'maintenance-history-policy',
      }),
    )
  }

  const resolved: ValidationIssue[] = issues.map((candidate) => ({
    ...candidate,
    accepted:
      candidate.severity === 'warning' &&
      workflow.acceptedWarnings.some(
        (warning) =>
          warning.issueId === candidate.id &&
          warning.ruleId === candidate.ruleId &&
          warning.schemaHash === warningSchemaHash(workflow, candidate.target) &&
          sameTarget(warning.target, candidate.target) &&
          targetExists(workflow, warning.target),
      ),
  }))

  resolved.push(
    issue({
      severity: 'pass',
      title: '结构化事实源存在',
      message: 'workflow.json 能表达文档、章节、字段、规则和导出设置。',
      target: {},
      ruleId: 'structure-source-present',
    }),
  )
  return resolved
}

export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((issueItem) => issueItem.severity === 'error')
}
