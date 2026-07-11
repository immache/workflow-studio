import { createStore, del, get, keys, set } from 'idb-keyval'
import type { WorkflowSchema } from '../domain/schema'
import { migrateWorkflowSchema } from '../data/migrations/workflow-migrations'
import { normalizeWorkflowForRuntime, toPersistedWorkflow } from '../domain/protocol-state'
import { assertWorkflowShape } from '../domain/strict-workflow-shape'

export type WorkflowProjectMeta = {
  id: string
  name: string
  description: string
  updatedAt: string
}

const database = createStore('workflow-studio', 'workflows')
const projectPrefix = 'workflow:'
const activeProjectKey = 'active-workflow-id'

function projectKey(id: string): string {
  return `${projectPrefix}${id}`
}

export async function assertStorageAvailable(): Promise<void> {
  const probeKey = '__workflow_studio_probe__'
  await set(probeKey, { ok: true }, database)
  await del(probeKey, database)
}

export async function listWorkflowProjects(): Promise<WorkflowProjectMeta[]> {
  const allKeys = await keys(database)
  const workflowKeys = allKeys.filter((key): key is string => typeof key === 'string' && key.startsWith(projectPrefix))
  const workflows = await Promise.all(workflowKeys.map(async (key) => {
    const raw = await get<unknown>(key, database)
    if (!raw) return undefined
    try {
      const migrated = migrateWorkflowSchema(raw)
      assertWorkflowShape(migrated)
      return normalizeWorkflowForRuntime(migrated)
    } catch {
      return undefined
    }
  }))
  return workflows
    .filter((workflow): workflow is WorkflowSchema => Boolean(workflow))
    .map((workflow) => ({
      id: workflow.workflowId,
      name: workflow.name,
      description: workflow.description,
      updatedAt: workflow.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadWorkflowProject(id: string): Promise<WorkflowSchema | undefined> {
  const raw = await get<unknown>(projectKey(id), database)
  if (!raw) return undefined
  const migrated = migrateWorkflowSchema(raw)
  assertWorkflowShape(migrated)
  return normalizeWorkflowForRuntime(migrated)
}

export async function loadActiveWorkflowProjectId(): Promise<string | undefined> {
  return get<string>(activeProjectKey, database)
}

export async function saveActiveWorkflowProjectId(id: string): Promise<void> {
  await set(activeProjectKey, id, database)
}

export async function saveWorkflowProject(workflow: WorkflowSchema): Promise<void> {
  await set(projectKey(workflow.workflowId), toPersistedWorkflow(workflow), database)
}

export async function deleteWorkflowProject(id: string): Promise<void> {
  await del(projectKey(id), database)
}
