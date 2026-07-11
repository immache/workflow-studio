import { projectDocumentNames, rewriteDocumentReferences, type DocumentNameProjection } from './export-naming'
import { fieldValueToText, type MaintenanceFormat, type WorkflowDocument, type WorkflowField, type WorkflowSchema } from './schema'
import { createCurrentStandardWorkflow } from '../data/presets/current-standard-workflow'
import { sectionModuleLibrary } from '../data/modules/standard-workflow-modules'

const standardSectionModuleIds = new Set([
  ...sectionModuleLibrary.map((module) => module.id),
  ...createCurrentStandardWorkflow().documents.flatMap((document) => document.sections.map((section) => section.id)),
])

function isStandardModule(sectionId: string): boolean {
  return sectionId.startsWith('protocol-') || [...standardSectionModuleIds].some((id) => sectionId === id || sectionId.startsWith(`${id}-`))
}

function valueLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function markdownTable(value: string): string {
  const rows = valueLines(value).map((line) => {
    const cells = line.split(/\s*\|\s*|[：:]\s*/).filter(Boolean)
    return `| ${cells[0] ?? ''} | ${cells.slice(1).join(' / ')} |`
  })
  return ['| 项目 | 内容 |', '| --- | --- |', ...rows].join('\n')
}

function renderValue(field: WorkflowField, value: string): string {
  if (!value.trim()) return '未填写'
  const lines = valueLines(value)
  if (field.displayFormat === 'checklist') return lines.map((line) => `- [ ] ${line.replace(/^[-*]\s*/, '')}`).join('\n')
  if (field.displayFormat === 'steps') return lines.map((line, index) => `${index + 1}. ${line.replace(/^\d+[.)、]\s*/, '')}`).join('\n')
  if (field.displayFormat === 'code') return `\`\`\`text\n${value}\n\`\`\``
  if (field.displayFormat === 'path-list') return lines.map((line) => `- \`${line}\``).join('\n')
  if (field.displayFormat === 'key-value' || field.displayFormat === 'decision-table' || field.displayFormat === 'timeline') return markdownTable(value)
  return value
}

export function renderMarkdownDocument(document: WorkflowDocument, projection: DocumentNameProjection): string {
  const outputFilename = projection.byDocumentId.get(document.id) ?? document.filename
  const rewrite = (text: string) => rewriteDocumentReferences(text, projection)
  const lines = [`# ${rewrite(document.title)}`, '', `文件名：\`${outputFilename}\``, `职责：\`${document.role}\``, '', rewrite(document.description), '']
  for (const section of document.sections) {
    lines.push(`## ${rewrite(section.title)}`, '', `说明：${rewrite(section.purpose)}`, '')
    for (const field of section.fields) {
      const guidance = rewrite(field.guidance)
      const value = rewrite(fieldValueToText(field.value))
      lines.push(`### ${rewrite(field.label)}`, '', `说明：${guidance}`, '', renderValue(field, value), '')
    }
  }
  return lines.join('\n')
}

export function exportMarkdownDocuments(workflow: WorkflowSchema): Record<string, string> {
  const projection = projectDocumentNames(workflow, 'markdown')
  return Object.fromEntries(workflow.documents.map((document) => [projection.byDocumentId.get(document.id)!, renderMarkdownDocument(document, projection)]))
}

export function exportReadme(workflow: WorkflowSchema, format: MaintenanceFormat = workflow.maintenanceFormat): string {
  const projection = projectDocumentNames(workflow, format)
  const rewrite = (text: string) => rewriteDocumentReferences(text, projection)
  const files = workflow.documents.map((document) => `- \`${projection.byDocumentId.get(document.id)}\`：${rewrite(document.description)}`).join('\n')
  const moduleGroups = workflow.documents.reduce<{ standard: string[]; custom: string[] }>((groups, document) => {
    const filename = projection.byDocumentId.get(document.id)
    for (const section of document.sections) {
      const entry = `- \`${filename}\` · ${rewrite(section.title)}（${section.fields.length} 个字段）`
      if (isStandardModule(section.id)) groups.standard.push(entry)
      else groups.custom.push(entry)
    }
    return groups
  }, { standard: [], custom: [] })
  const moduleSummary = [
    '### 标准模块',
    '',
    moduleGroups.standard.join('\n') || '- 无。',
    '',
    '### 自定义模块',
    '',
    moduleGroups.custom.join('\n') || '- 无。',
  ].join('\n')
  const recovery = workflow.rules.recoveryOrder.map((step, index) => {
    const document = workflow.documents.find((candidate) => candidate.id === step.documentId)
    return `${index + 1}. ${document ? projection.byDocumentId.get(document.id) : step.documentId} - ${rewrite(step.condition)}`
  }).join('\n')
  return [`# ${rewrite(workflow.name)}`, '', rewrite(workflow.description), '', '## 文件清单', '', files, '', '## 模块摘要', '', moduleSummary, '', '## 推荐读取顺序', '', recovery || '未配置。', '', '## 导入说明', '', '保留 `workflow.json` 作为结构化事实源，可重新导入 Workflow Studio。', ''].join('\n')
}
