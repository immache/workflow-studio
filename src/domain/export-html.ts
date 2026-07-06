import { fieldValueToText, type WorkflowDocument, type WorkflowSchema } from './schema'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-|-$/g, '') || 'section'
}

function renderDocument(document: WorkflowDocument): string {
  const nav = document.sections.map((section) => `<a href="#${slugify(section.id)}">${escapeHtml(section.title)}</a>`).join('')
  const sections = document.sections
    .map((section) => {
      const fields = section.fields
        .map((field) => {
          const value = fieldValueToText(field.value)
          return `<section class="field" data-field="${escapeHtml(field.id)}"><h3>${escapeHtml(field.label)}</h3><p class="guidance" data-guidance="true">${escapeHtml(field.guidance)}</p><div class="value" data-value="true"${value ? '' : ' data-empty="true"'}>${escapeHtml(value || '未填写')}</div></section>`
        })
        .join('')
      return `<section id="${slugify(section.id)}"><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.purpose)}</p>${fields}</section>`
    })
    .join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{--bg:#F4F1EA;--paper:#FFFFFF;--line:#E8E6DC;--ink:#1A1915;--muted:#6F6D66;--accent:#D97757;--accent-ink:#9B442E;--serif:Georgia,"Times New Roman",serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.72 var(--sans)}main{max-width:960px;margin:0 auto;padding:48px 28px 72px}h1,h2{font-family:var(--serif);font-weight:400}h1{font-size:48px;line-height:1.05}.nav{display:flex;flex-wrap:wrap;gap:10px 18px;margin:28px 0 36px;padding:14px 0;border-block:1px solid var(--line)}.nav a{color:var(--muted);text-decoration:none}.nav a:hover{color:var(--accent-ink)}section{border-top:1px solid var(--line);padding:28px 0;scroll-margin-top:72px}.field{padding:14px 0;border-top:1px solid var(--line)}.guidance{margin:0 0 8px;color:var(--muted);font-size:13px}.value[data-empty=true]{padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--muted)}
  </style>
</head>
<body><main><p style="color:var(--accent-ink);font-size:12px;text-transform:uppercase">Workflow Recovery Document</p><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.description)}</p><nav class="nav" aria-label="章节">${nav}</nav>${sections}</main></body>
</html>`
}

export function exportHtmlDocuments(workflow: WorkflowSchema): Record<string, string> {
  return Object.fromEntries(workflow.documents.map((document) => [document.filename.replace(/\.md$/i, '.html'), renderDocument(document)]))
}
