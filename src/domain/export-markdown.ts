import { fieldValueToText, type WorkflowDocument, type WorkflowSchema } from './schema'

function renderDocument(document: WorkflowDocument): string {
  const lines = [`# ${document.title}`, '', `文件名：\`${document.filename}\``, `角色：\`${document.role}\``, `生命周期：\`${document.lifecycle}\``, '', document.description, '']
  for (const section of document.sections) {
    lines.push(`## ${section.title}`, '', `说明：${section.purpose}`, '')
    for (const field of section.fields) {
      lines.push(`### ${field.label}`, '', `字段 ID：\`${field.id}\``, `生命周期：\`${field.lifecycle}\``, `说明：${field.guidance}`, '', '值：', '', fieldValueToText(field.value) || '未填写', '')
    }
  }
  return lines.join('\n')
}

export function exportMarkdownDocuments(workflow: WorkflowSchema): Record<string, string> {
  return Object.fromEntries(
    workflow.documents.map((document) => [
      document.filename.replace(/\.html$/i, '.md'),
      renderDocument(document),
    ]),
  )
}

export function exportReadme(workflow: WorkflowSchema): string {
  const files = workflow.documents.map((document) => `- \`${document.filename}\`：${document.description}`).join('\n')
  const moduleSummary = workflow.documents
    .map((document) => {
      const sections = document.sections.map((section) => `${section.title}（${section.fields.length} 个字段）`).join('；')
      return `- \`${document.filename}\`：${sections || '暂无章节'}`
    })
    .join('\n')
  const recovery = workflow.rules.recoveryOrder
    .map((step, index) => {
      const document = workflow.documents.find((candidate) => candidate.id === step.documentId)
      return `${index + 1}. ${document?.filename ?? step.documentId} - ${step.condition}`
    })
    .join('\n')
  return [
    `# ${workflow.name}`,
    '',
    workflow.description,
    '',
    '## 文件清单',
    '',
    files,
    '',
    '## 模块摘要',
    '',
    moduleSummary,
    '',
    '## 推荐读取顺序',
    '',
    recovery || '未配置。',
    '',
    '## 导入说明',
    '',
    '保留 `workflow.json` 作为结构化事实源，可重新导入 Workflow Studio。',
    '',
  ].join('\n')
}
