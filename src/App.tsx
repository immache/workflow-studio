import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  FileArchive,
  FileJson,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Import,
  Layers3,
  ListChecks,
  Play,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import './App.css'
import { exportHtmlDocuments } from './domain/export-html'
import { exportMarkdownDocuments, exportReadme } from './domain/export-markdown'
import { createWorkflowZip, packageName } from './domain/export-zip'
import { dimensionLabels, scoreWorkflow } from './domain/scoring'
import {
  fieldValueToText,
  type FieldOption,
  type MaintenanceFormat,
  type SimulationScenario,
  type ValidationRule,
  type ValidationIssue,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowSchema,
} from './domain/schema'
import { scenarioLabels, simulateRecovery } from './domain/simulation'
import { hasBlockingErrors, validateWorkflow } from './domain/validation'
import {
  documentRoleOptions,
  fieldTypeOptions,
  lifecycleOptions,
  sourceTypeOptions,
  useWorkflowStore,
  type AppView,
} from './store/workflow-store'

const viewItems: { id: AppView; label: string; icon: typeof Layers3 }[] = [
  { id: 'overview', label: '总览', icon: Layers3 },
  { id: 'documents', label: '文档', icon: FilePlus2 },
  { id: 'rules', label: '规则', icon: GitBranch },
  { id: 'simulation', label: '模拟', icon: Play },
  { id: 'export', label: '导出', icon: FileArchive },
]

const scenarioOptions = Object.keys(scenarioLabels) as SimulationScenario[]
let didInitialize = false

function statusLabel(status: string): string {
  if (status === 'saved') return '已保存'
  if (status === 'saving') return '保存中'
  if (status === 'failed') return '保存失败'
  if (status === 'memory') return '内存模式'
  return '加载中'
}

function severityLabel(severity: ValidationIssue['severity']): string {
  if (severity === 'error') return 'Error'
  if (severity === 'warning') return 'Warning'
  if (severity === 'suggestion') return 'Suggestion'
  return 'Pass'
}

function formatProjectDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function confirmDelete(label: string): boolean {
  return window.confirm(`确认删除${label}？此操作会立即改变当前工作流。`)
}

function optionsToText(options: FieldOption[] | undefined): string {
  return options?.map((option) => [option.value, option.label, option.description ?? ''].join(' | ').replace(/\s+\|\s+$/, '')).join('\n') ?? ''
}

function parseOptionsText(text: string): FieldOption[] | undefined {
  const options = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, label, description] = line.split('|').map((part) => part.trim())
      return { value, label: label || value, description: description || undefined }
    })
    .filter((option) => option.value.length > 0)
  return options.length > 0 ? options : undefined
}

function customRulesToText(rules: ValidationRule[]): string {
  return rules.map((rule) => [rule.severity, rule.predicate, rule.description].join(' | ')).join('\n')
}

function parseCustomRulesText(text: string): ValidationRule[] {
  return text.split(/\r?\n/)
    .map((line, index) => {
      const [severityInput, predicateInput, descriptionInput] = line.split('|').map((part) => part.trim())
      const severity = ['error', 'warning', 'suggestion'].includes(severityInput) ? severityInput as ValidationRule['severity'] : 'warning'
      const predicate = ['non-empty', 'valid-path', 'valid-url', 'valid-email', 'matches-pattern', 'custom'].includes(predicateInput)
        ? predicateInput as ValidationRule['predicate']
        : 'custom'
      const description = descriptionInput || predicateInput || severityInput
      if (!description) return undefined
      return { id: `custom-${index + 1}`, severity, predicate, description }
    })
    .filter((rule): rule is ValidationRule => Boolean(rule))
}

function fieldInstances(field: WorkflowField) {
  if (field.value.kind === 'list') return field.value.value
  const text = fieldValueToText(field.value)
  return text.trim().length === 0 ? [] : [field.value]
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function downloadText(content: string, filename: string, type = 'application/json'): void {
  downloadBlob(new Blob([content], { type }), filename)
}

function selectedDocument(workflow: WorkflowSchema, selectedDocumentId: string): WorkflowDocument | undefined {
  return workflow.documents.find((document) => document.id === selectedDocumentId) ?? workflow.documents[0]
}

function selectedField(workflow: WorkflowSchema, documentId: string, sectionId?: string, fieldId?: string): WorkflowField | undefined {
  return workflow.documents
    .find((document) => document.id === documentId)
    ?.sections.find((section) => section.id === sectionId)
    ?.fields.find((field) => field.id === fieldId)
}

function TopBar({ issueCount }: { issueCount: number }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const saveStatus = useWorkflowStore((state) => state.saveStatus)
  const storageMessage = useWorkflowStore((state) => state.storageMessage)
  const importProject = useWorkflowStore((state) => state.importProject)
  const importInProgress = useWorkflowStore((state) => state.importInProgress)
  const cancelImport = useWorkflowStore((state) => state.cancelImport)
  const saveCurrent = useWorkflowStore((state) => state.saveCurrent)
  const [importMessage, setImportMessage] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const readOnly = Boolean(workflow.readOnlyReason)

  async function handleImport(file: File | undefined) {
    if (!file) return
    try {
      await importProject(file)
      setImportMessage(`已导入 ${file.name}`)
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '导入失败。')
    }
  }

  return (
    <header className="topbar">
      <a className="skip-link" href="#main-workspace">跳到主工作区</a>
      <div className="brand-block">
        <span className="kicker">Workflow Studio</span>
        <strong>{workflow.name}</strong>
      </div>
      <div className="topbar-status" aria-live="polite">
        <span className={`save-dot save-dot-${saveStatus}`}></span>
        <span>{statusLabel(saveStatus)}</span>
        <span className="muted">{storageMessage}</span>
        {issueCount > 0 ? <span className="status-pill">{issueCount} 个 Error</span> : <span className="status-pill status-pill-ok">可导出</span>}
      </div>
      <div className="topbar-actions">
        <button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}>
          <Import size={16} aria-hidden="true" />
          导入
        </button>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          accept=".json,.zip,application/json,application/zip"
          onChange={(event) => void handleImport(event.currentTarget.files?.[0])}
        />
        <button type="button" className="button button-secondary" onClick={() => void saveCurrent()} disabled={readOnly}>
          <Save size={16} aria-hidden="true" />
          保存
        </button>
        {importInProgress ? (
          <button type="button" className="button button-ghost" onClick={cancelImport}>
            取消导入
          </button>
        ) : null}
      </div>
      {workflow.readOnlyReason ? <p className="topbar-message">{workflow.readOnlyReason}</p> : importMessage ? <p className="topbar-message">{importMessage}</p> : null}
    </header>
  )
}

function LeftRail() {
  const projects = useWorkflowStore((state) => state.projects)
  const workflow = useWorkflowStore((state) => state.workflow)
  const activeView = useWorkflowStore((state) => state.activeView)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const setActiveView = useWorkflowStore((state) => state.setActiveView)
  const selectDocument = useWorkflowStore((state) => state.selectDocument)
  const openProject = useWorkflowStore((state) => state.openProject)
  const deleteProject = useWorkflowStore((state) => state.deleteProject)
  const createPresetProject = useWorkflowStore((state) => state.createPresetProject)
  const createBlankProject = useWorkflowStore((state) => state.createBlankProject)
  const duplicateCurrentProject = useWorkflowStore((state) => state.duplicateCurrentProject)

  return (
    <aside className="left-rail" aria-label="项目与文档">
      <section className="rail-section">
        <div className="rail-heading">
          <span>项目</span>
          <FolderOpen size={16} aria-hidden="true" />
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === workflow.workflowId ? 'project-item active' : 'project-item'}
              onClick={() => void openProject(project.id)}
            >
              <span>{project.name}</span>
              <small>{formatProjectDate(project.updatedAt)}</small>
            </button>
          ))}
        </div>
        <div className="rail-actions">
          <button type="button" className="button button-secondary" onClick={() => void createPresetProject()}>
            <Plus size={15} aria-hidden="true" />
            标准预设
          </button>
          <button type="button" className="button button-ghost" onClick={() => void createBlankProject()}>
            空白
          </button>
          <button type="button" className="button button-ghost" onClick={() => void duplicateCurrentProject()}>
            复制
          </button>
          {projects.length > 1 ? (
            <button type="button" className="icon-button" aria-label="删除当前项目" onClick={() => {
              if (confirmDelete('当前项目')) void deleteProject(workflow.workflowId)
            }}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </section>

      <nav className="rail-section" aria-label="工作台视图">
        <div className="rail-heading">工作台</div>
        <div className="view-list">
          {viewItems.map((view) => {
            const Icon = view.icon
            return (
              <button key={view.id} type="button" className={activeView === view.id ? 'view-item active' : 'view-item'} onClick={() => setActiveView(view.id)}>
                <Icon size={16} aria-hidden="true" />
                {view.label}
              </button>
            )
          })}
        </div>
      </nav>

      <section className="rail-section">
        <div className="rail-heading">文档树</div>
        <div className="document-tree">
          {workflow.documents.map((document) => (
            <button
              key={document.id}
              type="button"
              className={selectedDocumentId === document.id ? 'document-node active' : 'document-node'}
              onClick={() => {
                selectDocument(document.id)
                setActiveView('documents')
              }}
            >
              <span>{document.title}</span>
              <small>{document.filename}</small>
            </button>
          ))}
        </div>
      </section>
    </aside>
  )
}

function Overview({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateWorkflowMeta = useWorkflowStore((state) => state.updateWorkflowMeta)
  const score = useMemo(() => scoreWorkflow(workflow, issues), [workflow, issues])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning' && !issue.accepted).length
  const fieldCount = workflow.documents.reduce((sum, document) => sum + document.sections.reduce((inner, section) => inner + section.fields.length, 0), 0)

  return (
    <section className="workspace-section" aria-labelledby="overview-title">
      <div className="editorial-hero">
        <div>
          <span className="kicker">Local-first workflow builder</span>
          <h1 id="overview-title">把工作流设计成可恢复、可维护、可导出的协议。</h1>
        </div>
        <div className="hero-editor">
          <label>
            项目名称
            <input value={workflow.name} onChange={(event) => updateWorkflowMeta({ name: event.currentTarget.value, description: workflow.description })} />
          </label>
          <label>
            一句话说明
            <textarea value={workflow.description} rows={3} onChange={(event) => updateWorkflowMeta({ name: workflow.name, description: event.currentTarget.value })} />
          </label>
        </div>
      </div>

      <div className="metric-grid" aria-label="工作流摘要">
        <Metric label="总分" value={`${score.total}`} detail={score.status === 'good' ? '结构健康' : score.status === 'caution' ? '需要关注' : '风险较高'} />
        <Metric label="文档" value={`${workflow.documents.length}`} detail={`${fieldCount} 个字段`} />
        <Metric label="校验" value={`${errorCount} / ${warningCount}`} detail="Error / Warning" />
        <Metric label="导出" value={workflow.maintenanceFormat.toUpperCase()} detail={workflow.secondaryFormat ? `次级 ${workflow.secondaryFormat}` : '无次级格式'} />
      </div>

      <div className="split-panel">
        <RelationshipGraph workflow={workflow} issues={issues} />
        <section className="plain-panel">
          <div className="section-heading">
            <h2>评分原因</h2>
            <span className="muted">最多显示每个维度的前三条原因</span>
          </div>
          <div className="score-list">
            {Object.entries(score.dimensions).map(([dimension, result]) => (
              <article key={dimension} className="score-row">
                <div>
                  <strong>{dimensionLabels[dimension as keyof typeof dimensionLabels]}</strong>
                  <small>{result.reasons[0] ?? '未发现主要扣分项。'}</small>
                </div>
                <span>{result.score}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function DocumentEditor() {
  const workflow = useWorkflowStore((state) => state.workflow)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const selectDocument = useWorkflowStore((state) => state.selectDocument)
  const selectFieldAction = useWorkflowStore((state) => state.selectField)
  const updateDocument = useWorkflowStore((state) => state.updateDocument)
  const addDocument = useWorkflowStore((state) => state.addDocument)
  const moveDocument = useWorkflowStore((state) => state.moveDocument)
  const removeDocument = useWorkflowStore((state) => state.removeDocument)
  const addSection = useWorkflowStore((state) => state.addSection)
  const updateSection = useWorkflowStore((state) => state.updateSection)
  const removeSection = useWorkflowStore((state) => state.removeSection)
  const addField = useWorkflowStore((state) => state.addField)
  const updateField = useWorkflowStore((state) => state.updateField)
  const updateFieldText = useWorkflowStore((state) => state.updateFieldText)
  const addFieldInstance = useWorkflowStore((state) => state.addFieldInstance)
  const updateFieldInstance = useWorkflowStore((state) => state.updateFieldInstance)
  const copyFieldInstance = useWorkflowStore((state) => state.copyFieldInstance)
  const moveFieldInstance = useWorkflowStore((state) => state.moveFieldInstance)
  const removeFieldInstance = useWorkflowStore((state) => state.removeFieldInstance)
  const removeField = useWorkflowStore((state) => state.removeField)
  const document = selectedDocument(workflow, selectedDocumentId)
  const documentIndex = document ? workflow.documents.findIndex((item) => item.id === document.id) : -1

  if (!document) {
    return (
      <section className="workspace-section">
        <EmptyState title="还没有文档" detail="请先创建一个恢复入口文档。" actionLabel="新增文档" onAction={addDocument} />
      </section>
    )
  }

  return (
    <section className="workspace-section" aria-labelledby="documents-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Documents</span>
          <h1 id="documents-title">文档、章节与字段</h1>
        </div>
        <button type="button" className="button button-primary" onClick={addDocument}>
          <FilePlus2 size={16} aria-hidden="true" />
          新增文档
        </button>
      </div>

      <div className="document-selector" aria-label="选择文档">
        {workflow.documents.map((item) => (
          <button key={item.id} type="button" className={item.id === document.id ? 'chip active' : 'chip'} onClick={() => selectDocument(item.id)}>
            {item.filename}
          </button>
        ))}
      </div>

      <section className="form-band" aria-label="文档属性">
        <label>
          标题
          <input value={document.title} onChange={(event) => updateDocument(document.id, { title: event.currentTarget.value })} />
        </label>
        <label>
          文件名
          <input value={document.filename} onChange={(event) => updateDocument(document.id, { filename: event.currentTarget.value })} />
        </label>
        <label>
          角色
          <select value={document.role} onChange={(event) => updateDocument(document.id, { role: event.currentTarget.value as WorkflowDocument['role'] })}>
            {documentRoleOptions.map((role) => <option key={role}>{role}</option>)}
          </select>
        </label>
        <label>
          生命周期
          <select value={document.lifecycle} onChange={(event) => updateDocument(document.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
            {lifecycleOptions.map((lifecycle) => <option key={lifecycle}>{lifecycle}</option>)}
          </select>
        </label>
        <label className="wide-field">
          职责说明
          <textarea rows={3} value={document.description} onChange={(event) => updateDocument(document.id, { description: event.currentTarget.value })} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" disabled={documentIndex <= 0} onClick={() => moveDocument(document.id, -1)}>
            上移
          </button>
          <button type="button" className="button button-secondary" disabled={documentIndex < 0 || documentIndex >= workflow.documents.length - 1} onClick={() => moveDocument(document.id, 1)}>
            下移
          </button>
          <button type="button" className="button button-ghost danger" disabled={workflow.documents.length <= 1} onClick={() => {
            if (confirmDelete(`文档 ${document.title}`)) removeDocument(document.id)
          }}>
            <Trash2 size={15} aria-hidden="true" />
            删除文档
          </button>
        </div>
      </section>

      <div className="section-stack">
        {document.sections.map((section) => (
          <article key={section.id} className="section-editor">
            <div className="section-heading compact">
              <div>
                <h2>{section.title}</h2>
                <p>{section.purpose}</p>
              </div>
              <div className="inline-actions">
                <button type="button" className="button button-secondary" onClick={() => addField(document.id, section.id)}>
                  <Plus size={15} aria-hidden="true" />
                  字段
                </button>
                <button type="button" className="icon-button" aria-label={`删除章节 ${section.title}`} onClick={() => {
                  if (confirmDelete(`章节 ${section.title}`)) removeSection(document.id, section.id)
                }}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="form-band form-band-compact">
              <label>
                章节标题
                <input value={section.title} onChange={(event) => updateSection(document.id, section.id, { title: event.currentTarget.value })} />
              </label>
              <label>
                生命周期
                <select value={section.lifecycle} onChange={(event) => updateSection(document.id, section.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
                  {lifecycleOptions.map((lifecycle) => <option key={lifecycle}>{lifecycle}</option>)}
                </select>
              </label>
              <label className="wide-field">
                章节目的
                <textarea rows={2} value={section.purpose} onChange={(event) => updateSection(document.id, section.id, { purpose: event.currentTarget.value })} />
              </label>
            </div>
            <div className="field-list">
              {section.fields.map((field) => (
                <article key={field.id} className="field-editor" data-field={field.id}>
                  <div className="field-grid">
                    <label>
                      字段名
                      <input value={field.label} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { label: event.currentTarget.value })} />
                    </label>
                    <label>
                      类型
                      <select value={field.type} onChange={(event) => updateField(document.id, section.id, field.id, { type: event.currentTarget.value as WorkflowField['type'] })}>
                        {fieldTypeOptions.map((type) => <option key={type}>{type}</option>)}
                      </select>
                    </label>
                    <label>
                      生命周期
                      <select value={field.lifecycle} onChange={(event) => updateField(document.id, section.id, field.id, { lifecycle: event.currentTarget.value as WorkflowDocument['lifecycle'] })}>
                        {lifecycleOptions.map((lifecycle) => <option key={lifecycle}>{lifecycle}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>
                    常驻说明
                    <textarea rows={2} value={field.guidance} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { guidance: event.currentTarget.value })} />
                  </label>
                  {field.repeatable ? (
                    <div className="repeatable-editor" aria-label={`${field.label} 值槽实例列表`}>
                      <div className="repeatable-heading">
                        <span>值槽实例</span>
                        <button type="button" className="button button-secondary" onClick={() => addFieldInstance(document.id, section.id, field.id)}>
                          <Plus size={15} aria-hidden="true" />
                          添加实例
                        </button>
                      </div>
                      {fieldInstances(field).map((item, index) => (
                        <div key={`${field.id}-${index}`} className="repeatable-row">
                          <label>
                            实例 {index + 1}
                            <input value={fieldValueToText(item)} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onInput={(event) => updateFieldInstance(document.id, section.id, field.id, index, event.currentTarget.value)} />
                          </label>
                          <div className="inline-actions">
                            <button type="button" className="icon-button" aria-label="实例上移" disabled={index === 0} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, -1)}>↑</button>
                            <button type="button" className="icon-button" aria-label="实例下移" disabled={index === fieldInstances(field).length - 1} onClick={() => moveFieldInstance(document.id, section.id, field.id, index, 1)}>↓</button>
                            <button type="button" className="icon-button" aria-label="复制实例" onClick={(event) => {
                              const input = event.currentTarget.closest('.repeatable-row')?.querySelector('input')
                              copyFieldInstance(document.id, section.id, field.id, index, input?.value)
                            }}>
                              <Plus size={15} aria-hidden="true" />
                            </button>
                            <button type="button" className="icon-button" aria-label="删除实例" onClick={() => removeFieldInstance(document.id, section.id, field.id, index)}>
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))}
                      {fieldInstances(field).length === 0 ? <p className="muted">还没有实例，添加后会写入 list 值。</p> : null}
                    </div>
                  ) : (
                    <label>
                      值槽
                      <textarea rows={4} value={fieldValueToText(field.value)} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onChange={(event) => updateFieldText(document.id, section.id, field.id, event.currentTarget.value)} />
                    </label>
                  )}
                  <div className="field-advanced">
                    <label>
                      默认值
                      <input value={typeof field.defaultValue === 'string' ? field.defaultValue : ''} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { defaultValue: event.currentTarget.value.trim().length === 0 ? undefined : event.currentTarget.value })} />
                    </label>
                    <label>
                      选项
                      <textarea
                        rows={3}
                        value={optionsToText(field.options)}
                        placeholder="value | label | description…"
                        onFocus={() => selectFieldAction(document.id, section.id, field.id)}
                        onChange={(event) => {
                          const options = parseOptionsText(event.currentTarget.value)
                          updateField(document.id, section.id, field.id, {
                            options,
                            validation: {
                              ...field.validation,
                              allowedValues: options?.map((option) => option.value),
                            },
                          })
                        }}
                      />
                    </label>
                    <label>
                      最小长度
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={field.validation.minLength ?? ''}
                        onFocus={() => selectFieldAction(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, {
                          validation: {
                            ...field.validation,
                            minLength: event.currentTarget.value === '' ? undefined : Number.parseInt(event.currentTarget.value, 10),
                          },
                        })}
                      />
                    </label>
                    <label>
                      最大长度
                      <input
                        type="number"
                        min="0"
                        inputMode="numeric"
                        value={field.validation.maxLength ?? ''}
                        onFocus={() => selectFieldAction(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, {
                          validation: {
                            ...field.validation,
                            maxLength: event.currentTarget.value === '' ? undefined : Number.parseInt(event.currentTarget.value, 10),
                          },
                        })}
                      />
                    </label>
                    <label>
                      Pattern
                      <input value={field.validation.pattern ?? ''} onFocus={() => selectFieldAction(document.id, section.id, field.id)} onChange={(event) => updateField(document.id, section.id, field.id, { validation: { ...field.validation, pattern: event.currentTarget.value || undefined } })} />
                    </label>
                    <label className="wide-field">
                      自定义校验
                      <textarea
                        rows={3}
                        value={customRulesToText(field.validation.customRules)}
                        placeholder="warning | non-empty | 说明…"
                        onFocus={() => selectFieldAction(document.id, section.id, field.id)}
                        onChange={(event) => updateField(document.id, section.id, field.id, { validation: { ...field.validation, customRules: parseCustomRulesText(event.currentTarget.value) } })}
                      />
                    </label>
                  </div>
                  <div className="field-flags">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={field.required} onChange={(event) => updateField(document.id, section.id, field.id, { required: event.currentTarget.checked })} />
                      必填
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={field.allowEmpty} onChange={(event) => updateField(document.id, section.id, field.id, { allowEmpty: event.currentTarget.checked })} />
                      允许空值导出
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={field.repeatable} onChange={(event) => updateField(document.id, section.id, field.id, { repeatable: event.currentTarget.checked })} />
                      多条实例
                    </label>
                    <button type="button" className="button button-ghost danger" onClick={() => {
                      if (confirmDelete(`字段 ${field.label}`)) removeField(document.id, section.id, field.id)
                    }}>
                      删除字段
                    </button>
                  </div>
                </article>
              ))}
              {section.fields.length === 0 ? <p className="muted">这个章节还没有字段。</p> : null}
            </div>
          </article>
        ))}
      </div>

      <button type="button" className="button button-secondary" onClick={() => addSection(document.id)}>
        <Plus size={16} aria-hidden="true" />
        新增章节
      </button>
    </section>
  )
}

function RulesEditor() {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateRecoveryStep = useWorkflowStore((state) => state.updateRecoveryStep)
  const addRecoveryStep = useWorkflowStore((state) => state.addRecoveryStep)
  const removeRecoveryStep = useWorkflowStore((state) => state.removeRecoveryStep)
  const updateSourcePriorityReason = useWorkflowStore((state) => state.updateSourcePriorityReason)
  const updateSourceRef = useWorkflowStore((state) => state.updateSourceRef)
  const addSourceRef = useWorkflowStore((state) => state.addSourceRef)
  const moveSourceRef = useWorkflowStore((state) => state.moveSourceRef)
  const removeSourceRef = useWorkflowStore((state) => state.removeSourceRef)
  const updateTrigger = useWorkflowStore((state) => state.updateTrigger)
  const addUpdateTrigger = useWorkflowStore((state) => state.addUpdateTrigger)
  const removeUpdateTrigger = useWorkflowStore((state) => state.removeUpdateTrigger)
  const updateCompletionCheck = useWorkflowStore((state) => state.updateCompletionCheck)
  const addCompletionCheck = useWorkflowStore((state) => state.addCompletionCheck)
  const removeCompletionCheck = useWorkflowStore((state) => state.removeCompletionCheck)
  const updateConflictPolicy = useWorkflowStore((state) => state.updateConflictPolicy)
  const updateHistoryPolicy = useWorkflowStore((state) => state.updateHistoryPolicy)
  const sourceRule = workflow.rules.sourcePriority[0]

  return (
    <section className="workspace-section" aria-labelledby="rules-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Rules</span>
          <h1 id="rules-title">恢复顺序与来源优先级</h1>
        </div>
        <button type="button" className="button button-primary" onClick={() => addRecoveryStep(workflow.documents[0]?.id ?? '')} disabled={workflow.documents.length === 0}>
          <Plus size={16} aria-hidden="true" />
          恢复步骤
        </button>
      </div>

      <section className="plain-panel">
        <h2>恢复顺序</h2>
        <div className="rule-list">
          {workflow.rules.recoveryOrder.map((step, index) => (
            <article key={step.id} className="rule-row">
              <span className="rule-index">{index + 1}</span>
              <label>
                文档
                <select value={step.documentId} onChange={(event) => updateRecoveryStep(step.id, { documentId: event.currentTarget.value })}>
                  {workflow.documents.map((document) => <option key={document.id} value={document.id}>{document.filename}</option>)}
                </select>
              </label>
              <label>
                读取条件
                <input value={step.condition} onChange={(event) => updateRecoveryStep(step.id, { condition: event.currentTarget.value })} />
              </label>
              <label className="checkbox-label inline-checkbox">
                <input type="checkbox" checked={step.required} onChange={(event) => updateRecoveryStep(step.id, { required: event.currentTarget.checked })} />
                必读
              </label>
              <button type="button" className="icon-button" aria-label="删除恢复步骤" onClick={() => {
                if (confirmDelete('恢复步骤')) removeRecoveryStep(step.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>来源优先级</h2>
          <button type="button" className="button button-secondary" onClick={addSourceRef}>
            <Plus size={15} aria-hidden="true" />
            来源
          </button>
        </div>
        <label>
          裁决理由
          <textarea rows={3} value={sourceRule?.reason ?? ''} onChange={(event) => updateSourcePriorityReason(event.currentTarget.value)} />
        </label>
        <div className="source-list">
          {(sourceRule?.orderedSources ?? []).map((source, index) => (
            <article key={`${source.priority}-${source.label}`} className="source-row editable-source">
              <span>{source.priority}</span>
              <label>
                标签
                <input value={source.label} onChange={(event) => updateSourceRef(index, { label: event.currentTarget.value })} />
              </label>
              <label>
                来源类型
                <select value={source.sourceType} onChange={(event) => updateSourceRef(index, { sourceType: event.currentTarget.value as typeof source.sourceType })}>
                  {sourceTypeOptions.map((type) => <option key={type}>{type}</option>)}
                </select>
              </label>
              <label>
                新鲜度
                <select value={source.recencyPolicy} onChange={(event) => updateSourceRef(index, { recencyPolicy: event.currentTarget.value as typeof source.recencyPolicy })}>
                  <option value="prefer-newer">prefer-newer</option>
                  <option value="ignore-recency">ignore-recency</option>
                  <option value="manual">manual</option>
                </select>
              </label>
              <div className="inline-actions">
                <button type="button" className="icon-button" aria-label="来源上移" disabled={index === 0} onClick={() => moveSourceRef(index, -1)}>↑</button>
                <button type="button" className="icon-button" aria-label="来源下移" disabled={index === (sourceRule?.orderedSources.length ?? 0) - 1} onClick={() => moveSourceRef(index, 1)}>↓</button>
                <button type="button" className="icon-button" aria-label="删除来源" onClick={() => {
                  if (confirmDelete('来源')) removeSourceRef(index)
                }}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>更新触发器</h2>
          <button type="button" className="button button-secondary" onClick={addUpdateTrigger}>
            <Plus size={15} aria-hidden="true" />
            触发器
          </button>
        </div>
        <div className="rule-list">
          {workflow.rules.updateTriggers.map((trigger) => (
            <article key={trigger.id} className="trigger-row">
              <label>
                目标文档
                <select value={trigger.targetDocumentId} onChange={(event) => updateTrigger(trigger.id, { targetDocumentId: event.currentTarget.value })}>
                  {workflow.documents.map((document) => <option key={document.id} value={document.id}>{document.filename}</option>)}
                </select>
              </label>
              <label>
                触发条件
                <input value={trigger.trigger} onChange={(event) => updateTrigger(trigger.id, { trigger: event.currentTarget.value })} />
              </label>
              <label>
                必要动作
                <input value={trigger.requiredAction} onChange={(event) => updateTrigger(trigger.id, { requiredAction: event.currentTarget.value })} />
              </label>
              <button type="button" className="icon-button" aria-label="删除更新触发器" onClick={() => {
                if (confirmDelete('更新触发器')) removeUpdateTrigger(trigger.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="plain-panel">
        <div className="section-heading compact">
          <h2>完成检查</h2>
          <button type="button" className="button button-secondary" onClick={addCompletionCheck}>
            <Plus size={15} aria-hidden="true" />
            检查
          </button>
        </div>
        <div className="rule-list">
          {workflow.rules.completionChecks.map((check) => (
            <article key={check.id} className="trigger-row">
              <label>
                名称
                <input value={check.label} onChange={(event) => updateCompletionCheck(check.id, { label: event.currentTarget.value })} />
              </label>
              <label>
                说明
                <input value={check.description} onChange={(event) => updateCompletionCheck(check.id, { description: event.currentTarget.value })} />
              </label>
              <label>
                缺失级别
                <select value={check.severityWhenMissing} onChange={(event) => updateCompletionCheck(check.id, { severityWhenMissing: event.currentTarget.value as typeof check.severityWhenMissing })}>
                  <option value="error">error</option>
                  <option value="warning">warning</option>
                </select>
              </label>
              <button type="button" className="icon-button" aria-label="删除完成检查" onClick={() => {
                if (confirmDelete('完成检查')) removeCompletionCheck(check.id)
              }}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="form-band">
        <label>
          冲突默认动作
          <select value={workflow.rules.conflictPolicy.defaultAction} onChange={(event) => updateConflictPolicy({ defaultAction: event.currentTarget.value as typeof workflow.rules.conflictPolicy.defaultAction })}>
            <option value="apply-source-priority">apply-source-priority</option>
            <option value="ask-user">ask-user</option>
            <option value="block-until-resolved">block-until-resolved</option>
          </select>
        </label>
        <label>
          未解决冲突级别
          <select value={workflow.rules.conflictPolicy.unresolvedConflictSeverity} onChange={(event) => updateConflictPolicy({ unresolvedConflictSeverity: event.currentTarget.value as typeof workflow.rules.conflictPolicy.unresolvedConflictSeverity })}>
            <option value="error">error</option>
            <option value="warning">warning</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.conflictPolicy.requireExplicitNoteForManualOverride} onChange={(event) => updateConflictPolicy({ requireExplicitNoteForManualOverride: event.currentTarget.checked })} />
          人工覆盖需要说明
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.historyPolicy.appendOnly} onChange={(event) => updateHistoryPolicy({ appendOnly: event.currentTarget.checked })} />
          历史只追加
        </label>
        <label>
          失效历史处理
          <select value={workflow.rules.historyPolicy.obsoleteHandling} onChange={(event) => updateHistoryPolicy({ obsoleteHandling: event.currentTarget.value as typeof workflow.rules.historyPolicy.obsoleteHandling })}>
            <option value="mark-obsolete">mark-obsolete</option>
            <option value="archive-with-replacement">archive-with-replacement</option>
            <option value="delete">delete</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={workflow.rules.historyPolicy.requireIndexUpdate} onChange={(event) => updateHistoryPolicy({ requireIndexUpdate: event.currentTarget.checked })} />
          历史索引必须更新
        </label>
      </section>
    </section>
  )
}

function SimulationView({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const scenario = useWorkflowStore((state) => state.simulationScenario)
  const setScenario = useWorkflowStore((state) => state.setSimulationScenario)
  const [resultScenario, setResultScenario] = useState<SimulationScenario>(scenario)
  const result = useMemo(() => simulateRecovery(workflow, resultScenario), [workflow, resultScenario])

  return (
    <section className="workspace-section" aria-labelledby="simulation-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Simulation</span>
          <h1 id="simulation-title">恢复模拟器</h1>
        </div>
        <div className="inline-actions">
          <select value={scenario} onChange={(event) => setScenario(event.currentTarget.value as SimulationScenario)} aria-label="选择模拟情境">
            {scenarioOptions.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
          </select>
          <button type="button" className="button button-primary" onClick={() => setResultScenario(scenario)}>
            <Play size={16} aria-hidden="true" />
            运行模拟
          </button>
        </div>
      </div>

      <div className="split-panel">
        <RelationshipGraph workflow={workflow} issues={issues} activeDocumentIds={result.readDocuments} />
        <section className={`plain-panel simulation-status simulation-${result.status}`}>
          <h2>{scenarioLabels[result.scenario]}</h2>
          <p>{result.nextAtomicStep}</p>
          {result.blockers.length > 0 ? (
            <ul className="blocker-list">
              {result.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : null}
          {result.conflicts.length > 0 ? (
            <div className="conflict-list">
              {result.conflicts.map((conflict) => (
                <article key={conflict.id}>
                  <strong>{conflict.description}</strong>
                  <p>裁决：{conflict.selectedSource?.label ?? '需要人工确认'}。{conflict.reason}</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <ol className="timeline" aria-label="模拟步骤">
        {result.steps.map((step) => (
          <li key={`${step.order}-${step.action}`} className={`timeline-step timeline-${step.outcome}`}>
            <span>{step.order}</span>
            <div>
              <strong>{step.action}</strong>
              <p>{step.reason}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ExportCenter({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const updateMaintenanceFormat = useWorkflowStore((state) => state.updateMaintenanceFormat)
  const blocking = hasBlockingErrors(issues)
  const htmlDocs = useMemo(() => exportHtmlDocuments(workflow), [workflow])
  const markdownDocs = useMemo(() => exportMarkdownDocuments(workflow), [workflow])
  const [message, setMessage] = useState('')
  const [isExporting, setIsExporting] = useState(false)
  const primaryDocs = workflow.maintenanceFormat === 'html' ? htmlDocs : markdownDocs
  const firstPreview = Object.entries(primaryDocs)[0]

  async function downloadZip() {
    if (blocking) {
      setMessage('存在未解决 Error，导出已阻止。')
      return
    }
    setIsExporting(true)
    try {
      const pkg = await createWorkflowZip(workflow)
      downloadBlob(pkg.blob, packageName(workflow))
      setMessage(`已生成 ZIP，包含 ${Object.keys(pkg.files).length} 个文件。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ZIP 生成失败。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section className="workspace-section" aria-labelledby="export-title">
      <div className="section-heading">
        <div>
          <span className="kicker">Export</span>
          <h1 id="export-title">预览与导出</h1>
        </div>
        <div className="inline-actions">
          <button type="button" className="button button-secondary" onClick={() => downloadText(JSON.stringify(workflow, null, 2), 'workflow.json')}>
            <FileJson size={16} aria-hidden="true" />
            workflow.json
          </button>
          <button type="button" className="button button-primary" disabled={blocking || isExporting} onClick={() => void downloadZip()}>
            <Download size={16} aria-hidden="true" />
            下载 ZIP
          </button>
        </div>
      </div>

      <section className="form-band">
        <label>
          主维护格式
          <select value={workflow.maintenanceFormat} onChange={(event) => updateMaintenanceFormat(event.currentTarget.value as MaintenanceFormat, workflow.secondaryFormat)}>
            <option value="html">HTML</option>
            <option value="markdown">Markdown</option>
          </select>
        </label>
        <label>
          次级格式
          <select value={workflow.secondaryFormat ?? ''} onChange={(event) => updateMaintenanceFormat(workflow.maintenanceFormat, event.currentTarget.value ? event.currentTarget.value as MaintenanceFormat : undefined)}>
            <option value="">不生成</option>
            <option value="html">HTML</option>
            <option value="markdown">Markdown</option>
          </select>
        </label>
        <div className={blocking ? 'export-gate blocked' : 'export-gate'}>
          {blocking ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
          <span>{blocking ? 'Error 未解决，ZIP 导出禁用。' : '没有阻塞性错误，可以导出。'}</span>
        </div>
      </section>

      {message ? <p className="notice" aria-live="polite">{message}</p> : null}

      <div className="split-panel">
        <section className="plain-panel">
          <h2>ZIP 文件结构</h2>
          <ul className="file-list">
            <li>workflow.json</li>
            <li>README.md</li>
            {Object.keys(primaryDocs).map((filename) => <li key={filename}>documents/{filename}</li>)}
            {workflow.secondaryFormat ? <li>documents-{workflow.secondaryFormat === 'html' ? 'html' : 'md'}/...</li> : null}
          </ul>
        </section>
        <section className="plain-panel">
          <h2>README 预览</h2>
          <pre className="code-preview">{exportReadme(workflow)}</pre>
        </section>
      </div>

      <section className="plain-panel">
        <h2>文档预览：{firstPreview?.[0] ?? '无文档'}</h2>
        <pre className="code-preview">{firstPreview?.[1] ?? '没有可预览的导出内容。'}</pre>
      </section>
    </section>
  )
}

function RightPanel({ issues }: { issues: ValidationIssue[] }) {
  const workflow = useWorkflowStore((state) => state.workflow)
  const selectedDocumentId = useWorkflowStore((state) => state.selectedDocumentId)
  const selectedSectionId = useWorkflowStore((state) => state.selectedSectionId)
  const selectedFieldId = useWorkflowStore((state) => state.selectedFieldId)
  const acceptWarning = useWorkflowStore((state) => state.acceptWarning)
  const [showSuggestions, setShowSuggestions] = useState(true)
  const field = selectedField(workflow, selectedDocumentId, selectedSectionId, selectedFieldId)
  const suggestionCount = issues.filter((issue) => issue.severity === 'suggestion').length
  const visibleIssues = issues
    .filter((issue) => showSuggestions || issue.severity !== 'suggestion')
    .filter((issue) => issue.severity !== 'pass' || issues.length <= 8)
    .slice(0, 10)
  const errors = issues.filter((issue) => issue.severity === 'error').length

  return (
    <aside className="right-panel" aria-label="属性、校验与预览">
      <section className="inspector">
        <div className="rail-heading">
          <span>当前对象</span>
          <Boxes size={16} aria-hidden="true" />
        </div>
        {field ? (
          <div className="inspector-field">
            <strong>{field.label}</strong>
            <p>{field.guidance}</p>
            <small>{field.id} · {field.lifecycle} · {field.type}</small>
          </div>
        ) : (
          <p className="muted">选中文档字段后，这里显示模型编辑提示和值槽状态。</p>
        )}
      </section>
      <section className="inspector" aria-live="polite">
        <div className="rail-heading">
          <span>校验结果</span>
          <ListChecks size={16} aria-hidden="true" />
        </div>
        <p className="validation-summary">{errors > 0 ? `${errors} 个 Error 阻止导出` : '没有阻塞性 Error'}</p>
        {suggestionCount > 0 ? (
          <button type="button" className="button button-ghost suggestion-toggle" onClick={() => setShowSuggestions((value) => !value)}>
            {showSuggestions ? '隐藏 Suggestion' : '显示 Suggestion'}
          </button>
        ) : null}
        <div className="issue-list">
          {visibleIssues.map((issue) => (
            <article key={issue.id} className={`issue issue-${issue.severity}${issue.accepted ? ' accepted' : ''}`}>
              <span>{severityLabel(issue.severity)}</span>
              <strong>{issue.title}</strong>
              <p>{issue.message}</p>
              {issue.severity === 'warning' && issue.canAccept && !issue.accepted ? (
                <button type="button" className="button button-ghost" onClick={() => acceptWarning(issue)}>
                  接受 Warning
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </aside>
  )
}

function RelationshipGraph({ workflow, issues, activeDocumentIds = [] }: { workflow: WorkflowSchema; issues: ValidationIssue[]; activeDocumentIds?: string[] }) {
  const documents = workflow.documents
  const errorDocumentIds = new Set(issues.filter((issue) => issue.severity === 'error' && issue.target.documentId).map((issue) => issue.target.documentId))
  const activeSet = new Set(activeDocumentIds)
  const nodePositions = documents.map((document, index) => ({
    document,
    x: 110 + (index % 3) * 280,
    y: 70 + Math.floor(index / 3) * 105,
  }))
  const nodeById = new Map(nodePositions.map((node) => [node.document.id, node]))
  const edges = workflow.rules.recoveryOrder
    .map((step, index, steps) => {
      const from = nodeById.get(step.documentId)
      const next = steps[index + 1] ? nodeById.get(steps[index + 1].documentId) : undefined
      return from && next ? { from, next, required: step.required } : undefined
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  const height = Math.max(300, 155 + Math.ceil(documents.length / 3) * 105)

  return (
    <section className="graph-panel" aria-labelledby="graph-title">
      <div className="section-heading compact">
        <div>
          <h2 id="graph-title">关系图与恢复路径</h2>
          <p>{documents.length} 个节点，{edges.length} 条路径边；橙色实线表示必读恢复路径，虚线表示按需读取。</p>
        </div>
      </div>
      <div className="graph-scroll" role="img" aria-label={`关系图：${documents.length} 个节点，${edges.length} 条边，当前恢复顺序为 ${workflow.rules.recoveryOrder.length} 步。`}>
        <svg viewBox={`0 0 920 ${height}`} className="relationship-svg" aria-hidden="true">
          {edges.map((edge) => (
            <line
              key={`${edge.from.document.id}-${edge.next.document.id}`}
              x1={edge.from.x + 90}
              y1={edge.from.y}
              x2={edge.next.x - 90}
              y2={edge.next.y}
              className={edge.required ? 'graph-edge required' : 'graph-edge optional'}
            />
          ))}
          {nodePositions.map((node) => {
            const hasError = errorDocumentIds.has(node.document.id)
            const active = activeSet.has(node.document.filename) || activeSet.has(node.document.id)
            return (
              <g key={node.document.id} transform={`translate(${node.x - 92} ${node.y - 36})`} className={hasError ? 'graph-node error' : active ? 'graph-node active' : 'graph-node'}>
                <rect width="184" height="72" rx="12" />
                <text x="16" y="27">{node.document.filename}</text>
                <text x="16" y="50" className="graph-node-meta">{node.document.role} · {node.document.lifecycle}</text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className="graph-summary">
        文本摘要：恢复顺序包含 {workflow.rules.recoveryOrder.length} 步；错误节点 {errorDocumentIds.size} 个；阻塞节点由校验结果决定。
      </p>
    </section>
  )
}

function EmptyState({ title, detail, actionLabel, onAction }: { title: string; detail: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{detail}</p>
      <button type="button" className="button button-primary" onClick={onAction}>{actionLabel}</button>
    </div>
  )
}

function MainWorkspace({ issues }: { issues: ValidationIssue[] }) {
  const activeView = useWorkflowStore((state) => state.activeView)
  if (activeView === 'documents') return <DocumentEditor />
  if (activeView === 'rules') return <RulesEditor />
  if (activeView === 'simulation') return <SimulationView issues={issues} />
  if (activeView === 'export') return <ExportCenter issues={issues} />
  return <Overview issues={issues} />
}

function App() {
  const initialize = useWorkflowStore((state) => state.initialize)
  const workflow = useWorkflowStore((state) => state.workflow)
  const issues = useMemo(() => validateWorkflow(workflow), [workflow])
  const errorCount = issues.filter((issue) => issue.severity === 'error').length

  useEffect(() => {
    if (didInitialize) return
    didInitialize = true
    void initialize()
  }, [initialize])

  return (
    <div className={workflow.readOnlyReason ? 'app-shell read-only-shell' : 'app-shell'}>
      <TopBar issueCount={errorCount} />
      {workflow.readOnlyReason ? <div className="read-only-banner" role="status">{workflow.readOnlyReason}</div> : null}
      <div className="studio-layout">
        <LeftRail />
        <main id="main-workspace" className="main-workspace">
          <MainWorkspace issues={issues} />
        </main>
        <RightPanel issues={issues} />
      </div>
    </div>
  )
}

export default App
