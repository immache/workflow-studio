import { produce } from 'immer'
import { create } from 'zustand'
import {
  createCurrentStandardWorkflow,
  createBlankWorkflow,
} from '../data/presets/current-standard-workflow'
import { parseImportedWorkflow } from '../domain/import-export'
import {
  createField,
  fieldValueToText,
  scalarValue,
  type DocumentRole,
  type FieldType,
  type InformationLifecycle,
  type MaintenanceFormat,
  type RecoveryStep,
  type SimulationScenario,
  type SourceRef,
  type SourcePriorityRule,
  type UpdateTriggerRule,
  type CompletionCheck,
  type ConflictPolicy,
  type FieldValue,
  type HistoryPolicy,
  type WorkflowDocument,
  type WorkflowField,
  type WorkflowSchema,
  type WorkflowSection,
} from '../domain/schema'
import { warningSchemaHash } from '../domain/validation'
import {
  assertStorageAvailable,
  deleteWorkflowProject,
  listWorkflowProjects,
  loadWorkflowProject,
  saveWorkflowProject,
  type WorkflowProjectMeta,
} from '../storage/indexeddb'

export type AppView = 'overview' | 'documents' | 'rules' | 'simulation' | 'export'
export type SaveStatus = 'loading' | 'saving' | 'saved' | 'failed' | 'memory'

type WorkflowStore = {
  workflow: WorkflowSchema
  projects: WorkflowProjectMeta[]
  activeView: AppView
  selectedDocumentId: string
  selectedSectionId?: string
  selectedFieldId?: string
  simulationScenario: SimulationScenario
  saveStatus: SaveStatus
  storageMessage: string
  storageAvailable: boolean
  importInProgress: boolean
  initialize: () => Promise<void>
  setActiveView: (view: AppView) => void
  selectDocument: (documentId: string) => void
  selectField: (documentId: string, sectionId: string, fieldId: string) => void
  createPresetProject: () => Promise<void>
  createBlankProject: () => Promise<void>
  duplicateCurrentProject: () => Promise<void>
  openProject: (id: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  importProject: (file: File) => Promise<void>
  cancelImport: () => void
  updateWorkflowMeta: (patch: Pick<WorkflowSchema, 'name' | 'description'>) => void
  updateMaintenanceFormat: (format: MaintenanceFormat, secondaryFormat?: MaintenanceFormat) => void
  updateDocument: (documentId: string, patch: Partial<Pick<WorkflowDocument, 'title' | 'filename' | 'description' | 'role' | 'lifecycle'>>) => void
  addDocument: () => void
  moveDocument: (documentId: string, direction: -1 | 1) => void
  removeDocument: (documentId: string) => void
  addSection: (documentId: string) => void
  updateSection: (documentId: string, sectionId: string, patch: Partial<Pick<WorkflowSection, 'title' | 'purpose' | 'lifecycle'>>) => void
  removeSection: (documentId: string, sectionId: string) => void
  addField: (documentId: string, sectionId: string) => void
  updateField: (documentId: string, sectionId: string, fieldId: string, patch: Partial<Pick<WorkflowField, 'label' | 'type' | 'guidance' | 'lifecycle' | 'required' | 'allowEmpty' | 'defaultValue' | 'repeatable' | 'options' | 'validation'>>) => void
  updateFieldText: (documentId: string, sectionId: string, fieldId: string, value: string) => void
  addFieldInstance: (documentId: string, sectionId: string, fieldId: string) => void
  updateFieldInstance: (documentId: string, sectionId: string, fieldId: string, index: number, value: string) => void
  copyFieldInstance: (documentId: string, sectionId: string, fieldId: string, index: number, value?: string) => void
  moveFieldInstance: (documentId: string, sectionId: string, fieldId: string, index: number, direction: -1 | 1) => void
  removeFieldInstance: (documentId: string, sectionId: string, fieldId: string, index: number) => void
  removeField: (documentId: string, sectionId: string, fieldId: string) => void
  updateRecoveryStep: (stepId: string, patch: Partial<Pick<RecoveryStep, 'documentId' | 'condition' | 'required'>>) => void
  addRecoveryStep: (documentId: string) => void
  removeRecoveryStep: (stepId: string) => void
  updateSourcePriorityReason: (reason: string) => void
  updateSourceRef: (index: number, patch: Partial<SourceRef>) => void
  addSourceRef: () => void
  moveSourceRef: (index: number, direction: -1 | 1) => void
  removeSourceRef: (index: number) => void
  updateTrigger: (id: string, patch: Partial<Pick<UpdateTriggerRule, 'targetDocumentId' | 'trigger' | 'requiredAction'>>) => void
  addUpdateTrigger: () => void
  removeUpdateTrigger: (id: string) => void
  updateCompletionCheck: (id: string, patch: Partial<Pick<CompletionCheck, 'label' | 'description' | 'severityWhenMissing'>>) => void
  addCompletionCheck: () => void
  removeCompletionCheck: (id: string) => void
  updateConflictPolicy: (patch: Partial<ConflictPolicy>) => void
  updateHistoryPolicy: (patch: Partial<HistoryPolicy>) => void
  setSimulationScenario: (scenario: SimulationScenario) => void
  acceptWarning: (issue: { id: string; ruleId: string; target: WorkflowSchema['acceptedWarnings'][number]['target'] }) => void
  saveCurrent: () => Promise<void>
}

const lifecycleOptions: InformationLifecycle[] = ['realtime', 'stable', 'historical', 'preference', 'reference', 'validation', 'mixed']
const roleByLifecycle: Record<InformationLifecycle, DocumentRole> = {
  realtime: 'status',
  stable: 'plan',
  historical: 'history',
  preference: 'preference',
  reference: 'context',
  validation: 'validation',
  mixed: 'custom',
}

function newId(prefix: string): string {
  const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${value}`
}

function touch(workflow: WorkflowSchema): void {
  workflow.updatedAt = new Date().toISOString()
}

function canEdit(workflow: WorkflowSchema): boolean {
  return !workflow.readOnlyReason
}

function listValueFromText(value: string): FieldValue {
  const items = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  return { kind: 'list', value: items.map((item) => scalarValue(item)) }
}

function ensureListValue(field: WorkflowField): Extract<FieldValue, { kind: 'list' }> {
  if (field.value.kind === 'list') return field.value
  const text = fieldValueToText(field.value)
  field.value = text.trim().length === 0 ? { kind: 'list', value: [] } : listValueFromText(text)
  if (field.value.kind !== 'list') field.value = { kind: 'list', value: [] }
  return field.value
}

function workflowMeta(workflow: WorkflowSchema): WorkflowProjectMeta {
  return {
    id: workflow.workflowId,
    name: workflow.name,
    description: workflow.description,
    updatedAt: workflow.updatedAt,
  }
}

function newDocument(order: number): WorkflowDocument {
  const id = newId('document')
  return {
    id,
    filename: `CUSTOM_${order}.html`,
    title: `自定义文档 ${order}`,
    role: 'custom',
    lifecycle: 'stable',
    description: '记录这份文档的职责边界。',
    readPolicy: {
      whenToRead: ['按需读取'],
      dependsOnDocumentIds: [],
      readOrderHint: order,
    },
    updatePolicy: {
      updateTriggers: ['职责范围内事实变化时'],
      replacementMode: 'replace-current',
      staleInfoHandling: 'remove',
    },
    order,
    required: false,
    sections: [
      {
        id: newId('section'),
        title: '核心内容',
        purpose: '说明这份文档需要保存的信息。',
        lifecycle: 'stable',
        order: 1,
        repeatable: false,
        fields: [
          createField({
            id: newId('field'),
            label: '关键事实',
            guidance: '写清事实来源、适用边界和更新时机。',
            lifecycle: 'stable',
          }),
        ],
      },
    ],
  }
}

function newSection(order: number): WorkflowSection {
  return {
    id: newId('section'),
    title: `新章节 ${order}`,
    purpose: '说明本章节职责。',
    lifecycle: 'stable',
    order,
    repeatable: false,
    fields: [],
  }
}

function newField(order: number): WorkflowField {
  return createField({
    id: newId('field'),
    label: `新字段 ${order}`,
    type: 'longText',
    guidance: '保持说明常驻可见，只把具体内容写入值槽。',
    lifecycle: 'stable',
  })
}

function defaultSourcePriority(workflow: WorkflowSchema): SourceRef[] {
  return workflow.rules.sourcePriority[0]?.orderedSources ?? [
    { sourceType: 'latest-user-instruction', label: '最新明确用户指令', priority: 1, recencyPolicy: 'prefer-newer' },
    { sourceType: 'workspace-fact', label: '新鲜工作区事实', priority: 2, recencyPolicy: 'prefer-newer' },
    { sourceType: 'stable-plan', label: '稳定计划', priority: 3, recencyPolicy: 'ignore-recency' },
  ]
}

function resequenceSources(rule: SourcePriorityRule): void {
  rule.orderedSources.forEach((source, index) => {
    source.priority = index + 1
  })
}

function selectedDocumentIdFor(workflow: WorkflowSchema, previous?: string): string {
  return workflow.documents.some((document) => document.id === previous) ? previous! : workflow.documents[0]?.id ?? ''
}

const initialWorkflow = createCurrentStandardWorkflow()
let activeImportController: AbortController | undefined

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  workflow: initialWorkflow,
  projects: [],
  activeView: 'overview',
  selectedDocumentId: initialWorkflow.documents[0]?.id ?? '',
  simulationScenario: 'new-session',
  saveStatus: 'loading',
  storageMessage: '正在检查本地存储。',
  storageAvailable: true,
  importInProgress: false,

  initialize: async () => {
    try {
      await assertStorageAvailable()
      const projects = await listWorkflowProjects()
      if (projects.length === 0) {
        const workflow = createCurrentStandardWorkflow()
        await saveWorkflowProject(workflow)
        set({
          workflow,
          projects: [workflowMeta(workflow)],
          selectedDocumentId: workflow.documents[0]?.id ?? '',
          saveStatus: 'saved',
          storageMessage: '已保存到本地浏览器。',
          storageAvailable: true,
        })
        return
      }
      const workflow = await loadWorkflowProject(projects[0].id)
      if (!workflow) throw new Error('无法读取最近项目。')
      set({
        workflow,
        projects,
        selectedDocumentId: selectedDocumentIdFor(workflow),
        saveStatus: 'saved',
        storageMessage: '已从本地浏览器恢复。',
        storageAvailable: true,
      })
    } catch (error) {
      const workflow = createCurrentStandardWorkflow()
      set({
        workflow,
        projects: [workflowMeta(workflow)],
        selectedDocumentId: workflow.documents[0]?.id ?? '',
        saveStatus: 'memory',
        storageMessage: error instanceof Error ? `IndexedDB 不可用：${error.message}` : 'IndexedDB 不可用，已进入内存模式。',
        storageAvailable: false,
      })
    }
  },

  setActiveView: (view) => set({ activeView: view }),
  selectDocument: (documentId) => set({ selectedDocumentId: documentId, selectedSectionId: undefined, selectedFieldId: undefined }),
  selectField: (documentId, sectionId, fieldId) => set({ selectedDocumentId: documentId, selectedSectionId: sectionId, selectedFieldId: fieldId, activeView: 'documents' }),

  createPresetProject: async () => {
    const workflow = createCurrentStandardWorkflow()
    set({ workflow, selectedDocumentId: selectedDocumentIdFor(workflow), selectedSectionId: undefined, selectedFieldId: undefined })
    await get().saveCurrent()
  },
  createBlankProject: async () => {
    const workflow = createBlankWorkflow()
    set({ workflow, selectedDocumentId: selectedDocumentIdFor(workflow), selectedSectionId: undefined, selectedFieldId: undefined })
    await get().saveCurrent()
  },
  duplicateCurrentProject: async () => {
    if (!canEdit(get().workflow)) return
    const current = get().workflow
    const workflow = structuredClone(current) as WorkflowSchema
    workflow.workflowId = newId('workflow')
    workflow.name = `${current.name} 副本`
    workflow.createdAt = new Date().toISOString()
    touch(workflow)
    set({ workflow, selectedDocumentId: selectedDocumentIdFor(workflow), selectedSectionId: undefined, selectedFieldId: undefined })
    await get().saveCurrent()
  },
  openProject: async (id) => {
    if (!get().storageAvailable) return
    const workflow = await loadWorkflowProject(id)
    if (!workflow) return
    set({
      workflow,
      selectedDocumentId: selectedDocumentIdFor(workflow, get().selectedDocumentId),
      selectedSectionId: undefined,
      selectedFieldId: undefined,
      saveStatus: 'saved',
      storageMessage: '已打开本地项目。',
    })
  },
  deleteProject: async (id) => {
    if (!get().storageAvailable) return
    await deleteWorkflowProject(id)
    const projects = await listWorkflowProjects()
    if (projects.length === 0) {
      await get().createPresetProject()
      return
    }
    const workflow = await loadWorkflowProject(projects[0].id)
    if (workflow) {
      set({
        workflow,
        projects,
        selectedDocumentId: selectedDocumentIdFor(workflow),
        saveStatus: 'saved',
        storageMessage: '项目已删除。',
      })
    }
  },
  importProject: async (file) => {
    activeImportController?.abort()
    activeImportController = new AbortController()
    set({ importInProgress: true, storageMessage: `正在导入 ${file.name}。` })
    try {
      const workflow = await parseImportedWorkflow(file, { signal: activeImportController.signal })
      set({ workflow, selectedDocumentId: selectedDocumentIdFor(workflow), activeView: 'overview', storageMessage: `已导入 ${file.name}。` })
      if (workflow.readOnlyReason) {
        set({ saveStatus: 'memory', storageMessage: workflow.readOnlyReason })
        return
      }
      await get().saveCurrent()
    } finally {
      activeImportController = undefined
      set({ importInProgress: false })
    }
  },
  cancelImport: () => {
    activeImportController?.abort()
    set({ importInProgress: false, storageMessage: '导入已取消。' })
  },

  updateWorkflowMeta: (patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.name = patch.name
        draft.description = patch.description
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateMaintenanceFormat: (format, secondaryFormat) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.maintenanceFormat = format
        draft.secondaryFormat = secondaryFormat === format ? undefined : secondaryFormat
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateDocument: (documentId, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const document = draft.documents.find((candidate) => candidate.id === documentId)
        if (!document) return
        Object.assign(document, patch)
        if (patch.lifecycle && !patch.role) document.role = roleByLifecycle[patch.lifecycle]
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addDocument: () => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const document = newDocument(draft.documents.length + 1)
        draft.documents.push(document)
        draft.rules.recoveryOrder.push({
          id: newId('recovery'),
          documentId: document.id,
          condition: '按需读取',
          required: false,
          fallbackStepIds: [],
        })
        touch(draft)
      }),
    }))
    set({ selectedDocumentId: get().workflow.documents.at(-1)?.id ?? get().selectedDocumentId })
    void get().saveCurrent()
  },
  moveDocument: (documentId, direction) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const index = draft.documents.findIndex((document) => document.id === documentId)
        const target = index + direction
        if (index < 0 || target < 0 || target >= draft.documents.length) return
        const [document] = draft.documents.splice(index, 1)
        draft.documents.splice(target, 0, document)
        draft.documents.forEach((item, itemIndex) => {
          item.order = itemIndex + 1
          item.readPolicy.readOrderHint = itemIndex + 1
        })
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeDocument: (documentId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.documents = draft.documents.filter((document) => document.id !== documentId)
        draft.rules.recoveryOrder = draft.rules.recoveryOrder.filter((step) => step.documentId !== documentId)
        touch(draft)
      }),
    }))
    set({ selectedDocumentId: selectedDocumentIdFor(get().workflow), selectedSectionId: undefined, selectedFieldId: undefined })
    void get().saveCurrent()
  },
  addSection: (documentId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const document = draft.documents.find((candidate) => candidate.id === documentId)
        if (!document) return
        document.sections.push(newSection(document.sections.length + 1))
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateSection: (documentId, sectionId, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
        if (!section) return
        Object.assign(section, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeSection: (documentId, sectionId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const document = draft.documents.find((candidate) => candidate.id === documentId)
        if (!document) return
        document.sections = document.sections.filter((section) => section.id !== sectionId)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addField: (documentId, sectionId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
        if (!section) return
        section.fields.push(newField(section.fields.length + 1))
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateField: (documentId, sectionId, fieldId, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        const nextRepeatable = patch.repeatable
        Object.assign(field, patch)
        if (nextRepeatable === true) {
          field.value = listValueFromText(fieldValueToText(field.value))
        } else if (nextRepeatable === false && field.value.kind === 'list') {
          const text = fieldValueToText(field.value)
          field.value = text.trim().length === 0 ? { kind: 'empty' } : scalarValue(text)
        }
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateFieldText: (documentId, sectionId, fieldId, value) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        field.value = field.repeatable ? listValueFromText(value) : value.trim().length === 0 ? { kind: 'empty' } : scalarValue(value)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addFieldInstance: (documentId, sectionId, fieldId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        ensureListValue(field).value.push(scalarValue(''))
        field.repeatable = true
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateFieldInstance: (documentId, sectionId, fieldId, index, value) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        const list = ensureListValue(field)
        if (!list.value[index]) return
        list.value[index] = value.trim().length === 0 ? { kind: 'empty' } : scalarValue(value)
        field.repeatable = true
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  copyFieldInstance: (documentId, sectionId, fieldId, index, valueText) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        const list = ensureListValue(field)
        const value = valueText !== undefined ? scalarValue(valueText) : list.value[index]
        if (!value) return
        list.value.splice(index + 1, 0, JSON.parse(JSON.stringify(value)) as FieldValue)
        field.repeatable = true
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  moveFieldInstance: (documentId, sectionId, fieldId, index, direction) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        const list = ensureListValue(field)
        const target = index + direction
        if (index < 0 || target < 0 || target >= list.value.length) return
        const [item] = list.value.splice(index, 1)
        list.value.splice(target, 0, item)
        field.repeatable = true
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeFieldInstance: (documentId, sectionId, fieldId, index) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
        if (!field) return
        const list = ensureListValue(field)
        list.value.splice(index, 1)
        field.repeatable = true
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeField: (documentId, sectionId, fieldId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
        if (!section) return
        section.fields = section.fields.filter((field) => field.id !== fieldId)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateRecoveryStep: (stepId, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const step = draft.rules.recoveryOrder.find((candidate) => candidate.id === stepId)
        if (!step) return
        Object.assign(step, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addRecoveryStep: (documentId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.recoveryOrder.push({
          id: newId('recovery'),
          documentId,
          condition: '按需读取',
          required: false,
          fallbackStepIds: [],
        })
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeRecoveryStep: (stepId) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.recoveryOrder = draft.rules.recoveryOrder.filter((step) => step.id !== stepId)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateSourcePriorityReason: (reason) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        if (draft.rules.sourcePriority.length === 0) {
          draft.rules.sourcePriority.push({
            id: 'global-source-priority',
            scope: 'global',
            orderedSources: defaultSourcePriority(draft),
            tieBreaker: 'explicit-user-confirmation',
            reason,
          })
        } else {
          draft.rules.sourcePriority[0].reason = reason
        }
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateSourceRef: (index, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        if (draft.rules.sourcePriority.length === 0) {
          draft.rules.sourcePriority.push({
            id: 'global-source-priority',
            scope: 'global',
            orderedSources: defaultSourcePriority(draft),
            tieBreaker: 'explicit-user-confirmation',
            reason: '按来源优先级裁决冲突。',
          })
        }
        const rule = draft.rules.sourcePriority[0]
        const source = rule.orderedSources[index]
        if (!source) return
        Object.assign(source, patch)
        resequenceSources(rule)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addSourceRef: () => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        if (draft.rules.sourcePriority.length === 0) {
          draft.rules.sourcePriority.push({
            id: 'global-source-priority',
            scope: 'global',
            orderedSources: [],
            tieBreaker: 'manual-review',
            reason: '按来源优先级裁决冲突。',
          })
        }
        const rule = draft.rules.sourcePriority[0]
        rule.orderedSources.push({
          sourceType: 'workspace-fact',
          label: '新来源',
          priority: rule.orderedSources.length + 1,
          recencyPolicy: 'prefer-newer',
        })
        resequenceSources(rule)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  moveSourceRef: (index, direction) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const rule = draft.rules.sourcePriority[0]
        if (!rule) return
        const target = index + direction
        if (index < 0 || target < 0 || target >= rule.orderedSources.length) return
        const [source] = rule.orderedSources.splice(index, 1)
        rule.orderedSources.splice(target, 0, source)
        resequenceSources(rule)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeSourceRef: (index) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const rule = draft.rules.sourcePriority[0]
        if (!rule) return
        rule.orderedSources.splice(index, 1)
        resequenceSources(rule)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateTrigger: (id, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const trigger = draft.rules.updateTriggers.find((candidate) => candidate.id === id)
        if (!trigger) return
        Object.assign(trigger, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addUpdateTrigger: () => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.updateTriggers.push({
          id: newId('trigger'),
          targetDocumentId: draft.documents[0]?.id ?? '',
          trigger: '职责范围内信息变化',
          requiredAction: '按职责更新文档',
        })
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeUpdateTrigger: (id) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.updateTriggers = draft.rules.updateTriggers.filter((trigger) => trigger.id !== id)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateCompletionCheck: (id, patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        const check = draft.rules.completionChecks.find((candidate) => candidate.id === id)
        if (!check) return
        Object.assign(check, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  addCompletionCheck: () => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.completionChecks.push({
          id: newId('check'),
          label: '新完成检查',
          description: '说明交付前必须验证的事项。',
          severityWhenMissing: 'warning',
          relatedDocumentIds: [],
        })
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  removeCompletionCheck: (id) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        draft.rules.completionChecks = draft.rules.completionChecks.filter((check) => check.id !== id)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateConflictPolicy: (patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        Object.assign(draft.rules.conflictPolicy, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  updateHistoryPolicy: (patch) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        Object.assign(draft.rules.historyPolicy, patch)
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  setSimulationScenario: (scenario) => set({ simulationScenario: scenario }),
  acceptWarning: (issue) => {
    if (!canEdit(get().workflow)) return
    set((state) => ({
      workflow: produce(state.workflow, (draft) => {
        if (!draft.acceptedWarnings.some((warning) => warning.issueId === issue.id && warning.schemaHash === warningSchemaHash(draft, issue.target))) {
          draft.acceptedWarnings.push({
            issueId: issue.id,
            ruleId: issue.ruleId,
            target: issue.target,
            acceptedAt: new Date().toISOString(),
            schemaHash: warningSchemaHash(draft, issue.target),
            reason: '用户在本地接受该 Warning。',
          })
        }
        touch(draft)
      }),
    }))
    void get().saveCurrent()
  },
  saveCurrent: async () => {
    const { workflow, storageAvailable } = get()
    if (workflow.readOnlyReason) {
      set({ saveStatus: 'memory', storageMessage: workflow.readOnlyReason })
      return
    }
    if (!storageAvailable) {
      set({ saveStatus: 'memory', storageMessage: 'IndexedDB 不可用，当前修改仅保存在内存中。' })
      return
    }
    set({ saveStatus: 'saving', storageMessage: '正在保存到本地浏览器。' })
    try {
      await saveWorkflowProject(workflow)
      const projects = await listWorkflowProjects()
      set({ projects, saveStatus: 'saved', storageMessage: '已保存到本地浏览器。' })
    } catch (error) {
      set({
        saveStatus: 'failed',
        storageMessage: error instanceof Error ? `保存失败：${error.message}` : '保存失败，请导出 JSON 备份。',
      })
    }
  },
}))

export { lifecycleOptions }
export const fieldTypeOptions: FieldType[] = ['shortText', 'longText', 'richText', 'select', 'multiSelect', 'boolean', 'date', 'path', 'url', 'email', 'code', 'list', 'table', 'reference']
export const documentRoleOptions: DocumentRole[] = ['protocol', 'plan', 'status', 'preference', 'history', 'context', 'validation', 'custom']
export const sourceTypeOptions: SourceRef['sourceType'][] = ['latest-user-instruction', 'workspace-fact', 'current-status', 'stable-plan', 'user-preference', 'session-history', 'memory-history', 'context-reference', 'older-history']
