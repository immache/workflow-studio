import { create } from 'zustand'
import {
  createCurrentStandardWorkflow,
  createEmptyTemplateWorkflow,
} from '../data/presets/current-standard-workflow'
import {
  createFieldFromModule,
  createContentDocument,
  createSectionFromModule,
  type ContentDocumentId,
} from '../data/modules/standard-workflow-modules'
import { parseImportedWorkflow } from '../domain/import-export'
import {
  remapWorkflowRootIdentity,
  normalizeWorkflowForRuntime,
  toPersistedWorkflow,
  withRegeneratedSystemProtocol,
} from '../domain/protocol-state'
import {
  createField,
  emptyValue,
  type ContentDocument,
  type DisplayFormatId,
  type ProtocolSupplement,
  type WorkflowField,
  type WorkflowSchema,
  type WorkflowSection,
} from '../domain/schema'
import {
  assertStorageAvailable,
  deleteWorkflowProject,
  listWorkflowProjects,
  loadActiveWorkflowProjectId,
  loadWorkflowProject,
  saveActiveWorkflowProjectId,
  saveWorkflowProject,
  type WorkflowProjectMeta,
} from '../storage/indexeddb'

export type SaveStatus = 'loading' | 'saving' | 'saved' | 'failed' | 'memory'
export type ProjectCreationInput = { name: string; description: string }

type WorkflowStore = {
  workflow: WorkflowSchema | null
  projects: WorkflowProjectMeta[]
  saveStatus: SaveStatus
  storageMessage: string
  storageAvailable: boolean
  importInProgress: boolean
  initialize: () => Promise<void>
  createStandardProject: (input: ProjectCreationInput) => Promise<void>
  createEmptyProject: (input: ProjectCreationInput) => Promise<void>
  openProject: (id: string) => Promise<void>
  duplicateCurrentProject: () => Promise<void>
  deleteProject: (id: string) => Promise<void>
  importProject: (file: File) => Promise<void>
  cancelImport: () => void
  updateWorkflowMeta: (patch: ProjectCreationInput) => void
  addContentDocument: () => void
  addStandardDocument: (id: ContentDocumentId) => void
  updateDocument: (documentId: string, patch: Pick<ContentDocument, 'title' | 'description'> & Partial<Pick<ContentDocument, 'filename'>>) => void
  removeDocument: (documentId: string) => void
  addSection: (documentId: string) => void
  addSectionFromModule: (documentId: string, moduleId: string) => void
  updateSection: (documentId: string, sectionId: string, patch: Pick<WorkflowSection, 'title' | 'purpose'>) => void
  removeSection: (documentId: string, sectionId: string) => void
  addField: (documentId: string, sectionId: string) => string | undefined
  addFieldFromModule: (documentId: string, sectionId: string, moduleId: string) => string | undefined
  updateField: (documentId: string, sectionId: string, fieldId: string, patch: Pick<WorkflowField, 'label' | 'guidance'> & Partial<Pick<WorkflowField, 'displayFormat'>>) => void
  moveField: (documentId: string, sectionId: string, fieldId: string, direction: -1 | 1) => void
  removeField: (documentId: string, sectionId: string, fieldId: string) => void
  regenerateProtocol: () => void
  addProtocolSupplement: (input: Omit<ProtocolSupplement, 'id'>) => void
  removeProtocolSupplement: (id: string) => void
  selectLegacyProtocol: (documentId: string) => void
  convertLegacyToTemplate: () => void
  saveCurrent: () => Promise<void>
}

let activeImportController: AbortController | undefined

function newId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

function isEditable(workflow: WorkflowSchema | null): workflow is WorkflowSchema {
  return Boolean(workflow && !workflow.readOnlyReason)
}

function normalizeSectionOrder(document: ContentDocument): void {
  document.sections.forEach((section, index) => {
    section.order = index + 1
    section.fields.forEach((field, fieldIndex) => {
      if (!field.id.trim()) field.id = newId('field')
      void fieldIndex
    })
  })
}

function templateFormat(format: DisplayFormatId | undefined): Extract<DisplayFormatId, 'paragraph' | 'bullet-list' | 'steps'> {
  return format === 'steps' || format === 'bullet-list' ? format : 'paragraph'
}

function blankField(order: number): WorkflowField {
  return createField({
    id: newId('field'),
    label: `新信息项 ${order}`,
    guidance: '说明未来模型需要记录的内容范围、更新时机和使用方式。',
    lifecycle: 'mixed',
    displayFormat: 'paragraph',
  })
}

function normalizeTemplateField(field: WorkflowField): WorkflowField {
  return {
    ...structuredClone(field),
    value: emptyValue(),
    required: false,
    allowEmpty: true,
    defaultValue: undefined,
    displayFormat: templateFormat(field.displayFormat),
  }
}

function blankDocument(order: number): ContentDocument {
  const id = newId('document')
  return {
    id,
    filename: `DOCUMENT_${order}.html`,
    title: `自定义文档 ${order}`,
    role: 'custom',
    lifecycle: 'mixed',
    description: '说明这份资料只负责保存什么，以及何时需要读取。',
    readPolicy: { whenToRead: ['需要这份资料职责内的信息时读取。'], dependsOnDocumentIds: [], readOrderHint: order },
    updatePolicy: { updateTriggers: ['职责范围内的信息变化时更新。'], replacementMode: 'replace-current', staleInfoHandling: 'remove' },
    order,
    required: false,
    sections: [{
      id: newId('section'),
      title: '主要内容',
      purpose: '把同一主题下的信息项放在这一章。',
      lifecycle: 'mixed',
      order: 1,
      repeatable: false,
      fields: [],
    }],
  }
}

function mutate(workflow: WorkflowSchema, recipe: (draft: ReturnType<typeof toPersistedWorkflow>) => void): WorkflowSchema {
  const draft = structuredClone(toPersistedWorkflow(workflow))
  recipe(draft)
  draft.updatedAt = new Date().toISOString()
  draft.documents.forEach(normalizeSectionOrder)
  return normalizeWorkflowForRuntime(draft)
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => {
  const setWorkflow = (workflow: WorkflowSchema | null, message?: string) => set({
    workflow,
    ...(message ? { storageMessage: message } : {}),
  })
  const persist = async (successMessage = '已保存到本地浏览器。') => {
    const workflow = get().workflow
    if (!workflow) return
    if (workflow.readOnlyReason) {
      set({ saveStatus: 'memory', storageMessage: workflow.readOnlyReason })
      return
    }
    if (!get().storageAvailable) {
      set({ saveStatus: 'memory', storageMessage: 'IndexedDB 不可用，当前修改仅保存在内存中。' })
      return
    }
    set({ saveStatus: 'saving', storageMessage: '正在保存到本地浏览器。' })
    try {
      await saveWorkflowProject(workflow)
      await saveActiveWorkflowProjectId(workflow.workflowId)
      set({ projects: await listWorkflowProjects(), saveStatus: 'saved', storageMessage: successMessage })
    } catch (error) {
      set({ saveStatus: 'failed', storageMessage: error instanceof Error ? `保存失败：${error.message}` : '保存失败，请导出 JSON 备份。' })
    }
  }
  const update = (recipe: (draft: ReturnType<typeof toPersistedWorkflow>) => void) => {
    const current = get().workflow
    if (!isEditable(current)) return
    setWorkflow(mutate(current, recipe))
    void persist()
  }

  return {
    workflow: null,
    projects: [],
    saveStatus: 'loading',
    storageMessage: '正在检查本地存储。',
    storageAvailable: true,
    importInProgress: false,
    initialize: async () => {
      try {
        await assertStorageAvailable()
        const projects = await listWorkflowProjects()
        if (projects.length === 0) {
          set({ workflow: null, projects: [], saveStatus: 'saved', storageMessage: '还没有本地工作流。', storageAvailable: true })
          return
        }
        const active = await loadActiveWorkflowProjectId()
        const selected = projects.find((project) => project.id === active) ?? projects[0]
        const workflow = await loadWorkflowProject(selected.id)
        if (!workflow) throw new Error('无法读取最近项目。')
        await saveActiveWorkflowProjectId(workflow.workflowId)
        set({ workflow, projects, saveStatus: 'saved', storageMessage: '已从本地浏览器恢复。', storageAvailable: true })
      } catch (error) {
        set({ workflow: null, projects: [], saveStatus: 'memory', storageAvailable: false, storageMessage: error instanceof Error ? `本地存储不可用：${error.message}` : '本地存储不可用。' })
      }
    },
    createStandardProject: async ({ name, description }) => {
      let workflow = createCurrentStandardWorkflow()
      workflow.name = name.trim() || '当前标准工作流'
      workflow.description = description.trim() || '使用标准恢复文档设计模型协作工作流。'
      workflow = withRegeneratedSystemProtocol(workflow)
      setWorkflow(workflow)
      await persist()
    },
    createEmptyProject: async ({ name, description }) => {
      setWorkflow(createEmptyTemplateWorkflow(name.trim() || '未命名工作流', description.trim() || '从空白开始设计文档、章节和信息项。'))
      await persist()
    },
    openProject: async (id) => {
      if (!get().storageAvailable) return
      const workflow = await loadWorkflowProject(id)
      if (!workflow) return
      await saveActiveWorkflowProjectId(id)
      set({ workflow, saveStatus: 'saved', storageMessage: '已打开本地项目。' })
    },
    duplicateCurrentProject: async () => {
      const current = get().workflow
      if (!isEditable(current)) return
      let workflow = remapWorkflowRootIdentity(current, newId('workflow'))
      workflow.name = `${current.name} 副本`
      workflow.createdAt = new Date().toISOString()
      workflow = withRegeneratedSystemProtocol(workflow)
      setWorkflow(workflow)
      await persist()
    },
    deleteProject: async (id) => {
      if (!get().storageAvailable) return
      await deleteWorkflowProject(id)
      const projects = await listWorkflowProjects()
      if (projects.length === 0) {
        set({ workflow: null, projects: [], saveStatus: 'saved', storageMessage: '项目已删除，你可以重新开始。' })
        return
      }
      const selected = projects[0]
      const workflow = await loadWorkflowProject(selected.id)
      if (!workflow) return
      await saveActiveWorkflowProjectId(workflow.workflowId)
      set({ workflow, projects, saveStatus: 'saved', storageMessage: '项目已删除，已打开其他本地项目。' })
    },
    importProject: async (file) => {
      activeImportController?.abort()
      const controller = new AbortController()
      activeImportController = controller
      set({ importInProgress: true, storageMessage: `正在导入 ${file.name}。` })
      try {
        const workflow = await parseImportedWorkflow(file, { signal: controller.signal })
        if (workflow.readOnlyReason && !window.confirm(`${workflow.readOnlyReason}\n\n是否以只读副本打开？原文件不会被降级或覆盖。`)) {
          set({ saveStatus: 'saved', storageMessage: '已取消打开高版本只读副本，当前项目未改变。' })
          return
        }
        setWorkflow(workflow, `已导入 ${file.name}。`)
        if (!workflow.readOnlyReason) await persist()
        else set({ saveStatus: 'memory', storageMessage: workflow.readOnlyReason })
      } catch (error) {
        if (controller.signal.aborted) set({ storageMessage: '导入已取消。' })
        else set({ storageMessage: error instanceof Error ? `导入失败：${error.message}` : '导入失败，当前项目未改变。' })
      } finally {
        if (activeImportController === controller) activeImportController = undefined
        set({ importInProgress: false })
      }
    },
    cancelImport: () => {
      activeImportController?.abort()
      set({ importInProgress: false, storageMessage: '导入已取消。' })
    },
    updateWorkflowMeta: (patch) => update((draft) => {
      draft.name = patch.name
      draft.description = patch.description
    }),
    addContentDocument: () => update((draft) => {
      draft.documents.push(blankDocument(draft.documents.length + 1))
    }),
    addStandardDocument: (id) => update((draft) => {
      if (draft.documents.some((document) => document.id === `content-${id}`)) return
      const document = createContentDocument(id, draft.documents.length + 1)
      draft.documents.push({
        ...document,
        sections: document.sections.map((section) => ({ ...section, fields: section.fields.map(normalizeTemplateField) })),
      })
    }),
    updateDocument: (documentId, patch) => update((draft) => {
      const document = draft.documents.find((candidate) => candidate.id === documentId)
      if (!document) return
      document.title = patch.title
      document.description = patch.description
      if (patch.filename !== undefined) document.filename = patch.filename
    }),
    removeDocument: (documentId) => update((draft) => {
      draft.documents = draft.documents.filter((document) => document.id !== documentId)
      draft.documents.forEach((document, index) => {
        document.order = index + 1
        document.readPolicy.readOrderHint = index + 1
      })
    }),
    addSection: (documentId) => update((draft) => {
      const document = draft.documents.find((candidate) => candidate.id === documentId)
      if (!document) return
      document.sections.push({
        id: newId('section'),
        title: `新章节 ${document.sections.length + 1}`,
        purpose: '说明这一章负责保存的主题。',
        lifecycle: 'mixed',
        order: document.sections.length + 1,
        repeatable: false,
        fields: [],
      })
    }),
    addSectionFromModule: (documentId, moduleId) => update((draft) => {
      const document = draft.documents.find((candidate) => candidate.id === documentId)
      const section = createSectionFromModule(moduleId, (document?.sections.length ?? 0) + 1)
      if (!document || !section) return
      document.sections.push({
        ...section,
        fields: section.fields.map(normalizeTemplateField),
      })
    }),
    updateSection: (documentId, sectionId, patch) => update((draft) => {
      const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
      if (!section) return
      section.title = patch.title
      section.purpose = patch.purpose
    }),
    removeSection: (documentId, sectionId) => update((draft) => {
      const document = draft.documents.find((candidate) => candidate.id === documentId)
      if (!document) return
      document.sections = document.sections.filter((section) => section.id !== sectionId)
    }),
    addField: (documentId, sectionId) => {
      let addedId: string | undefined
      update((draft) => {
        const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
        if (!section) return
        const field = blankField(section.fields.length + 1)
        section.fields.push(field)
        addedId = field.id
      })
      return addedId
    },
    addFieldFromModule: (documentId, sectionId, moduleId) => {
      let addedId: string | undefined
      update((draft) => {
        const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
        const field = createFieldFromModule(moduleId)
        if (!section || !field) return
        const templateField = normalizeTemplateField(field)
        section.fields.push(templateField)
        addedId = templateField.id
      })
      return addedId
    },
    updateField: (documentId, sectionId, fieldId, patch) => update((draft) => {
      const field = draft.documents.find((document) => document.id === documentId)?.sections.find((section) => section.id === sectionId)?.fields.find((candidate) => candidate.id === fieldId)
      if (!field) return
      field.label = patch.label
      field.guidance = patch.guidance
      if (patch.displayFormat !== undefined) field.displayFormat = templateFormat(patch.displayFormat)
    }),
    moveField: (documentId, sectionId, fieldId, direction) => update((draft) => {
      const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
      if (!section) return
      const index = section.fields.findIndex((field) => field.id === fieldId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= section.fields.length) return
      const [field] = section.fields.splice(index, 1)
      section.fields.splice(target, 0, field)
    }),
    removeField: (documentId, sectionId, fieldId) => update((draft) => {
      const section = draft.documents.find((document) => document.id === documentId)?.sections.find((candidate) => candidate.id === sectionId)
      if (section) section.fields = section.fields.filter((field) => field.id !== fieldId)
    }),
    regenerateProtocol: () => {
      const current = get().workflow
      if (!isEditable(current)) return
      setWorkflow(withRegeneratedSystemProtocol(current))
      void persist()
    },
    addProtocolSupplement: (input) => update((draft) => {
      draft.protocolState.supplements.push({ ...input, id: newId('supplement') })
    }),
    removeProtocolSupplement: (id) => update((draft) => {
      draft.protocolState.supplements = draft.protocolState.supplements.filter((supplement) => supplement.id !== id)
    }),
    selectLegacyProtocol: (documentId) => update((draft) => {
      if (draft.protocolState.legacyManualOverride) draft.protocolState.legacyManualOverride.selectedDocumentId = documentId
    }),
    convertLegacyToTemplate: () => {
      const current = get().workflow
      if (!isEditable(current) || current.mode !== 'legacy-content') return
      const draft = toPersistedWorkflow(current)
      draft.mode = 'template'
      draft.updatedAt = new Date().toISOString()
      draft.acceptedWarnings = []
      draft.documents = draft.documents.map((document) => ({
        ...document,
        sections: document.sections.map((section) => ({
          ...section,
          fields: section.fields.map((field) => ({
            ...field,
            type: 'longText',
            value: emptyValue(),
            required: false,
            allowEmpty: true,
            defaultValue: undefined,
            options: undefined,
            repeatable: false,
            validation: { customRules: [] },
            displayFormat: templateFormat(field.displayFormat),
          })),
        })),
      }))
      draft.protocolState = { ...draft.protocolState, legacyManualOverride: undefined }
      setWorkflow(withRegeneratedSystemProtocol(normalizeWorkflowForRuntime(draft)), '已转换为新的空模板。')
      void persist('已转换为新的空模板。')
    },
    saveCurrent: persist,
  }
})
