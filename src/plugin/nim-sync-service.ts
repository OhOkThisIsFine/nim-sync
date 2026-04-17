import crypto from 'crypto'
import path from 'path'
import type { NIMModel, OpenCodeConfig, CacheData, AuthConfig } from '../types/index.js'
import { NVIDIAApiError } from '../types/index.js'
import { validateOpenCodeConfig } from '../types/schema.js'
import { withRetry } from '../lib/retry.js'
import {
  readJSONC,
  writeJSONC,
  updateJSONCPaths,
  acquireLock,
  getConfigFilePath,
  getCacheDir,
  getDataDir,
  API_TIMEOUT_MS,
  CACHE_TTL_MS,
  MIN_MANUAL_REFRESH_INTERVAL_MS
} from '../lib/file-utils.js'
import {
  NIM_REFRESH_COMMAND_DESCRIPTION,
  NIM_REFRESH_COMMAND_NAME,
  NIM_REFRESH_COMMAND_TEMPLATE
} from './nim-refresh-command.js'

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const CACHE_FILE_NAME = 'nim-sync-cache.json'

const ALLOWED_MODEL_PROPERTIES = new Set([
  'id', 'name', 'description', 'model_type', 'quantization',
  'created', 'owned_by', 'object', 'root', 'parent', 'permission'
])

type RefreshSource = 'background' | 'manual'
export type NIMSyncRefreshResult =
  | 'updated'
  | 'unchanged'
  | 'failed'
  | 'missing-api-key'
  | 'skipped'
  | 'in-progress'
type RefreshCommandConfig = NonNullable<OpenCodeConfig['command']>[string]

export interface NIMSyncToast {
  title: string
  message: string
  variant: 'info' | 'success' | 'error'
}

export interface NIMSyncServiceOptions {
  getConfigSnapshot?: () => Promise<OpenCodeConfig> | OpenCodeConfig
  showToast?: (toast: NIMSyncToast) => void | Promise<void>
}

export interface NIMSyncService {
  getAPIKey: () => Promise<string | null>
  getNextRefreshDelay: () => Promise<number>
  updateConfig: (models: NIMModel[]) => Promise<boolean>
  refreshModels: (force?: boolean) => Promise<NIMSyncRefreshResult>
  manualRefresh: () => Promise<void>
  shouldRefresh: () => Promise<boolean>
}

const getCachePath = (): string => path.join(getCacheDir(), CACHE_FILE_NAME)
const getAuthPath = (): string => path.join(getDataDir(), 'auth.json')

const defaultGetConfigSnapshot = async (): Promise<OpenCodeConfig> => {
  return readJSONC<OpenCodeConfig>(await getConfigFilePath())
}

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }

  return value
}

const managedNIMConfigMatches = (
  currentConfig: NonNullable<OpenCodeConfig['provider']>['nim'] | undefined,
  nextConfig: NonNullable<OpenCodeConfig['provider']>['nim']
): boolean => {
  return JSON.stringify(sortKeysDeep(currentConfig ?? null)) === JSON.stringify(sortKeysDeep(nextConfig))
}

const managedRefreshCommandMatches = (
  currentConfig: RefreshCommandConfig | undefined,
  nextConfig: RefreshCommandConfig
): boolean => {
  return JSON.stringify(sortKeysDeep(currentConfig ?? null)) === JSON.stringify(sortKeysDeep(nextConfig))
}

const buildManagedRefreshCommand = (): NonNullable<OpenCodeConfig['command']>[typeof NIM_REFRESH_COMMAND_NAME] => ({
  description: NIM_REFRESH_COMMAND_DESCRIPTION,
  template: NIM_REFRESH_COMMAND_TEMPLATE,
  subtask: false
})

const getManagedRefreshCommandCleanup = (config: OpenCodeConfig): {
  removed: boolean
  command: OpenCodeConfig['command'] | undefined
  updates: Array<{
    jsonPath: Array<string | number>
    data: unknown
  }>
} => {
  const managedRefreshCommand = buildManagedRefreshCommand()
  const currentRefreshCommand = config.command?.[NIM_REFRESH_COMMAND_NAME]

  if (!managedRefreshCommandMatches(currentRefreshCommand, managedRefreshCommand)) {
    return {
      removed: false,
      command: config.command,
      updates: []
    }
  }

  const nextCommand = {
    ...(config.command ?? {})
  }

  delete nextCommand[NIM_REFRESH_COMMAND_NAME]

  const updates = [
    {
      jsonPath: ['command', NIM_REFRESH_COMMAND_NAME] as Array<string | number>,
      data: undefined
    }
  ]

  if (Object.keys(nextCommand).length === 0) {
    updates.push({
      jsonPath: ['command'],
      data: undefined
    })
  }

  return {
    removed: true,
    command: Object.keys(nextCommand).length > 0 ? nextCommand : undefined,
    updates
  }
}

function validateAPIResponse(response: unknown): NIMModel[] {
  if (!response || typeof response !== 'object') throw new Error('Invalid API response: Expected object, got ' + (response === null ? 'null' : typeof response))
  const obj = response as Record<string, unknown>
  if (!('data' in obj)) throw new Error('Invalid API response: Missing data field. Keys: [' + Object.keys(obj).join(', ') + ']')
  const data = obj.data
  if (!Array.isArray(data)) throw new Error('Invalid API response: data must be array, got ' + typeof data)
  const seenIds = new Set<string>()
  const models: NIMModel[] = []
  for (let i = 0; i < data.length; i++) {
    const m = data[i] as Record<string, unknown>
    if (!m || typeof m !== 'object') throw new Error('Invalid model at index ' + i + ': not an object')
    if (typeof m.id !== 'string' || m.id.length === 0) throw new Error('Invalid model at index ' + i + ': invalid id')
    if (typeof m.name !== 'string' || m.name.length === 0) throw new Error('Model ' + m.id + ': invalid name')
    if (seenIds.has(m.id)) throw new Error('Duplicate model ID: ' + m.id)
    const unexpected = Object.keys(m).filter(k => !ALLOWED_MODEL_PROPERTIES.has(k))
    if (unexpected.length > 0) console.warn('[NIM-Sync] Model ' + m.id + ' has unexpected props: [' + unexpected.join(', ') + ']')
    seenIds.add(m.id)
    models.push({
      id: m.id,
      name: m.name,
      description: typeof m.description === 'string' ? m.description : undefined,
      model_type: typeof m.model_type === 'string' ? m.model_type : undefined,
      quantization: typeof m.quantization === 'string' ? m.quantization : undefined
    })
  }
  return models
}

const fetchModels = async (apiKey: string): Promise<NIMModel[]> => {
  return withRetry(async () => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    try {
      const response = await fetch(NIM_BASE_URL + '/models', {
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      if (!response.ok) throw new NVIDIAApiError(response.status, response.statusText)
      let data: unknown
      try { data = await response.json() } catch (e) { throw new Error('Failed to parse JSON: ' + (e instanceof Error ? e.message : 'Unknown')) }
      return validateAPIResponse(data)
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') throw new Error('NVIDIA API request timed out after ' + (API_TIMEOUT_MS / 1000) + ' seconds')
      throw error
    }
  }, { maxRetries: 3, initialDelay: 1000, maxDelay: 10000, retryStatusCodes: [429, 500, 502, 503, 504] })
}

const hashModels = (models: NIMModel[]): string => {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify([...models].sort((a, b) => a.id.localeCompare(b.id))))
  return hash.digest('hex')
}

const readCache = async (): Promise<CacheData | null> => {
  try {
    const cache = await readJSONC<CacheData>(getCachePath())
    return cache?.lastRefresh ? cache : null
  } catch {
    return null
  }
}

export function createNIMSyncService(options: NIMSyncServiceOptions = {}): NIMSyncService {
  let refreshInProgress = false
  let lastManualRefresh = 0

  const showToast = (toast: NIMSyncToast): void => {
    void Promise.resolve(options.showToast?.(toast)).catch(() => {})
  }

  const sanitizeErrorMessage = (msg: string, apiKey: string | null): string => {
    if (!apiKey) return msg
    return msg.replace(apiKey, '[REDACTED]')
  }

  const writeCache = async (cache: CacheData): Promise<void> => {
    let releaseLockFn: (() => Promise<void>) | null = null
    try {
      releaseLockFn = await acquireLock('nim-cache-write')
    } catch (lockError) {
      const msg = lockError instanceof Error ? lockError.message : 'Unknown error'
      console.error('[NIM-Sync] Cache lock failed:', msg)
      showToast({ title: 'NVIDIA Sync Warning', message: 'Cache lock failed: ' + msg, variant: 'error' })
      throw lockError
    }
    try {
      await writeJSONC(getCachePath(), cache, { backup: true })
    } catch (writeError) {
      const msg = writeError instanceof Error ? writeError.message : 'Unknown error'
      console.error('[NIM-Sync] Cache write failed:', msg)
      showToast({ title: 'NVIDIA Sync Failed', message: 'Failed to write cache: ' + msg, variant: 'error' })
      throw writeError
    } finally {
      if (releaseLockFn) { try { await releaseLockFn() } catch (e) { console.error('[NIM-Sync] Failed to release cache lock:', e) } }
    }
  }

  const getAPIKey = async (): Promise<string | null> => {
    try {
      const auth = await readJSONC<AuthConfig>(getAuthPath())
      if (!auth || Object.keys(auth).length === 0) {
        return process.env.NVIDIA_API_KEY || null
      }
      if (auth.credentials?.nim?.apiKey && typeof auth.credentials.nim.apiKey === 'string') {
        return auth.credentials.nim.apiKey
      }
      return process.env.NVIDIA_API_KEY || null
    } catch (error) {
      console.error('[NIM-Sync] Failed to read auth:', error instanceof Error ? error.message : 'Unknown error')
      return process.env.NVIDIA_API_KEY || null
    }
  }

  const shouldRefresh = async (): Promise<boolean> => {
    try {
      const config = await (options.getConfigSnapshot?.() ?? defaultGetConfigSnapshot())
      if (!config?.provider?.nim) return true
      const cache = await readCache()
      if (!cache?.lastRefresh) return true
      return Date.now() - cache.lastRefresh > CACHE_TTL_MS
    } catch {
      return true
    }
  }

  const getNextRefreshDelay = async (): Promise<number> => {
    try {
      const config = await (options.getConfigSnapshot?.() ?? defaultGetConfigSnapshot())
      if (!config?.provider?.nim) {
        return 0
      }

      const cache = await readCache()
      if (!cache?.lastRefresh) {
        return 0
      }

      return Math.max(0, CACHE_TTL_MS - (Date.now() - cache.lastRefresh))
    } catch {
      return 0
    }
  }

  const persistManagedConfigUpdates = async (
    configPath: string,
    updatedConfig: OpenCodeConfig,
    updates: Array<{
      jsonPath: Array<string | number>
      data: unknown
    }>,
    options: {
      validate?: boolean
    } = {}
  ): Promise<void> => {
    let releaseLockFn: (() => Promise<void>) | null = null
    try { releaseLockFn = await acquireLock('nim-config-update') } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown'
      console.error('[NIM-Sync] Config lock failed:', msg)
      showToast({ title: 'NVIDIA Config Lock Failed', message: msg, variant: 'error' })
      throw e
    }
    try {
      if (options.validate !== false) {
        const validation = validateOpenCodeConfig(updatedConfig)
        if (!validation.valid) {
          console.warn('[NIM-Sync] Config validation warnings:', validation.errors)
        }
      }
      await updateJSONCPaths(
        configPath,
        updates,
        { backup: true, createBackupDir: true }
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown'
      console.error('[NIM-Sync] Config update failed:', msg)
      showToast({ title: 'NVIDIA Config Update Failed', message: msg, variant: 'error' })
      throw e
    } finally {
      if (releaseLockFn) { try { await releaseLockFn() } catch (e) { console.error('[NIM-Sync] Failed to release config lock:', e) } }
    }
  }

  const removeManagedRefreshCommand = async (): Promise<boolean> => {
    const configPath = await getConfigFilePath()
    const config = await readJSONC<OpenCodeConfig>(configPath)
    const cleanup = getManagedRefreshCommandCleanup(config || {})

    if (!cleanup.removed) {
      return false
    }

    const updatedConfig: OpenCodeConfig = {
      ...(config || {})
    }

    if (cleanup.command) {
      updatedConfig.command = cleanup.command
    } else {
      delete updatedConfig.command
    }

    await persistManagedConfigUpdates(
      configPath,
      updatedConfig,
      cleanup.updates,
      { validate: false }
    )

    return true
  }

  const updateConfig = async (models: NIMModel[]): Promise<boolean> => {
    const configPath = await getConfigFilePath()
    const config = await readJSONC<OpenCodeConfig>(configPath)

    const newModels = models.reduce((acc, m) => {
      acc[m.id] = { name: m.name, options: config?.provider?.nim?.models?.[m.id]?.options || {} }
      return acc
    }, {} as Record<string, { name: string; options: Record<string, unknown> }>)
    const modelsHash = hashModels(models)
    const cache = await readCache()
    const refreshCommandCleanup = getManagedRefreshCommandCleanup(config || {})

    const updatedNIMConfig: NonNullable<OpenCodeConfig['provider']>['nim'] = {
      ...config?.provider?.nim,
      npm: '@ai-sdk/openai-compatible',
      name: 'NVIDIA NIM',
      options: {
        ...config?.provider?.nim?.options,
        baseURL: NIM_BASE_URL
      },
      models: newModels
    }
    const managedConfigChanged = !managedNIMConfigMatches(config?.provider?.nim, updatedNIMConfig)
    const managedCommandChanged = refreshCommandCleanup.removed

    if (cache?.modelsHash === modelsHash && !managedConfigChanged && !managedCommandChanged) {
      try {
        await writeCache({ ...cache, lastRefresh: Date.now(), modelsHash, baseURL: NIM_BASE_URL })
      } catch { /* non-fatal */ }
      return false
    }

    const updatedConfig: OpenCodeConfig = {
      ...(config || {}),
      provider: { ...config?.provider, nim: updatedNIMConfig }
    }

    if (refreshCommandCleanup.command) {
      updatedConfig.command = refreshCommandCleanup.command
    } else {
      delete updatedConfig.command
    }

    await persistManagedConfigUpdates(
      configPath,
      updatedConfig,
      [
        { jsonPath: ['provider', 'nim'], data: updatedNIMConfig },
        ...refreshCommandCleanup.updates
      ]
    )
    try { await writeCache({ lastRefresh: Date.now(), modelsHash, baseURL: NIM_BASE_URL }) } catch { /* non-fatal */ }
    return true
  }

  const runRefreshModels = async (force = false, source: RefreshSource = 'background'): Promise<NIMSyncRefreshResult> => {
    if (refreshInProgress) {
      if (source === 'manual') {
        showToast({
          title: 'NVIDIA Refresh In Progress',
          message: 'A model refresh is already running.',
          variant: 'info'
        })
      }
      return 'in-progress'
    }
    refreshInProgress = true
    let apiKey: string | null = null
    try {
      await removeManagedRefreshCommand()
      if (!force && !(await shouldRefresh())) return 'skipped'
      apiKey = await getAPIKey()
      if (!apiKey) {
        showToast({ title: 'NVIDIA API Key Required', message: 'Run /connect to add your NVIDIA API key', variant: 'error' })
        return 'missing-api-key'
      }
      const models = await fetchModels(apiKey)
      if (models.length === 0) {
        showToast({ title: 'No Models Available', message: 'NVIDIA API returned no models.', variant: 'error' })
        return 'failed'
      }
      const changed = await updateConfig(models)
      if (changed) {
        showToast({ title: 'NVIDIA NIM Models Updated', message: models.length + ' models synchronized', variant: 'success' })
        return 'updated'
      } else if (source === 'manual') {
        showToast({ title: 'NVIDIA NIM Already Up To Date', message: 'No model changes found.', variant: 'info' })
      }
      return 'unchanged'
    } catch (error) {
      const msg = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error', apiKey)
      console.error('[NIM-Sync] Model refresh failed:', msg)
      showToast({ title: 'NVIDIA Sync Failed', message: msg, variant: 'error' })
      try { await writeCache({ modelsHash: '', lastError: msg, baseURL: NIM_BASE_URL }) } catch { /* ignore */ }
      return 'failed'
    } finally {
      refreshInProgress = false
    }
  }

  const refreshModels = async (force = false): Promise<NIMSyncRefreshResult> => {
    return runRefreshModels(force, 'background')
  }

  const manualRefresh = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastManualRefresh < MIN_MANUAL_REFRESH_INTERVAL_MS) {
      const remainingSeconds = Math.ceil((MIN_MANUAL_REFRESH_INTERVAL_MS - (now - lastManualRefresh)) / 1000)
      showToast({ title: 'Rate Limited', message: 'Please wait ' + remainingSeconds + 's before refreshing again', variant: 'info' })
      return
    }
    const result = await runRefreshModels(true, 'manual')
    if (result === 'updated' || result === 'unchanged' || result === 'failed') {
      lastManualRefresh = now
    }
  }

  return {
    getAPIKey,
    getNextRefreshDelay,
    updateConfig,
    refreshModels,
    manualRefresh,
    shouldRefresh
  }
}
