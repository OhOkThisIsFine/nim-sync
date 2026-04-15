import crypto from 'crypto'
import path from 'path'
import type { PluginAPI, NIMModel, OpenCodeConfig, CacheData, AuthConfig } from '../types/index.js'
import { NVIDIAApiError } from '../types/index.js'
import { validateOpenCodeConfig } from '../types/schema.js'
import { withRetry } from '../lib/retry.js'
import {
  readJSONC,
  writeJSONC,
  updateJSONCPath,
  acquireLock,
  getConfigDir,
  getCacheDir,
  getDataDir,
  API_TIMEOUT_MS,
  CACHE_TTL_MS,
  MIN_MANUAL_REFRESH_INTERVAL_MS
} from '../lib/file-utils.js'

const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const CACHE_FILE_NAME = 'nim-sync-cache.json'
const CONFIG_FILE_NAME = 'opencode.jsonc'

const ALLOWED_MODEL_PROPERTIES = new Set([
  'id', 'name', 'description', 'model_type', 'quantization',
  'created', 'owned_by', 'object', 'root', 'parent', 'permission'
])

/**
 * Creates a NVIDIA NIM model synchronization plugin for OpenCode.
 * 
 * This plugin automatically fetches available models from NVIDIA's API and updates
 * the OpenCode configuration with the latest model list. It provides:
 * - Automatic sync on startup with 24-hour TTL caching
 * - Manual refresh via `/nim-refresh` command with rate limiting (60s cooldown)
 * - Atomic file operations with lock-based concurrency control
 * - Graceful error handling with user-friendly toast notifications
 * 
 * @param api - Plugin API provided by OpenCode framework
 * @returns Plugin instance with lifecycle methods and exposed utilities
 * 
 * @example
 * ```typescript
 * // Plugin is automatically loaded by OpenCode
 * const plugin = await syncNIMModels(api)
 * await plugin.init?.()
 * 
 * // Manual refresh via command
 * await plugin.refreshModels?.(true)
 * ```
 * 
 * @remarks
 * - Requires NVIDIA API key in `auth.json` or `NVIDIA_API_KEY` environment variable
 * - Updates `provider.nim.models` in `opencode.jsonc`
 * - Cache stored in `nim-sync-cache.json` with 24-hour TTL
 * - Prevents concurrent refreshes with in-memory flag
 */
export async function syncNIMModels(api: PluginAPI): Promise<{
  /** Initialize plugin and register commands */
  init?: () => Promise<void>
  /** Hook handlers for server and session events */
  hooks?: Record<string, () => Promise<void>>
  /** Get NVIDIA API key from auth config or environment */
  getAPIKey?: () => Promise<string | null>
  /** Update OpenCode configuration with new models */
  updateConfig?: (models: NIMModel[]) => Promise<boolean>
  /** Refresh models from NVIDIA API */
  refreshModels?: (force?: boolean) => Promise<void>
  /** Check if model refresh is needed based on cache TTL */
  shouldRefresh?: () => Promise<boolean>
}> {
  let refreshInProgress = false
  let lastManualRefresh = 0

  const safeShowToast = (options: { title: string; description: string; variant: 'success' | 'error' | 'default' }): void => {
    try { api.tui.toast.show(options) } catch (e) { console.debug('[NIM-Sync] Toast display failed:', e instanceof Error ? e.message : 'Unknown') }
  }

  const sanitizeErrorMessage = (msg: string, apiKey: string | null): string => {
    if (!apiKey) return msg
    return msg.replace(apiKey, '[REDACTED]')
  }

  const getCachePath = (): string => path.join(getCacheDir(), CACHE_FILE_NAME)
  const getConfigPath = (): string => path.join(getConfigDir(), CONFIG_FILE_NAME)
  const getAuthPath = (): string => path.join(getDataDir(), 'auth.json')

  const readCache = async (): Promise<CacheData | null> => {
    try {
      const cache = await readJSONC<CacheData>(getCachePath())
      return cache?.lastRefresh ? cache : null
    } catch { return null }
  }

  const writeCache = async (cache: CacheData): Promise<void> => {
    let releaseLockFn: (() => Promise<void>) | null = null
    try {
      releaseLockFn = await acquireLock('nim-cache-write')
    } catch (lockError) {
      const msg = lockError instanceof Error ? lockError.message : 'Unknown error'
      console.error('[NIM-Sync] Cache lock failed:', msg)
      safeShowToast({ title: 'NVIDIA Sync Warning', description: 'Cache lock failed: ' + msg, variant: 'error' })
      throw lockError
    }
    try {
      await writeJSONC(getCachePath(), cache, { backup: true })
    } catch (writeError) {
      const msg = writeError instanceof Error ? writeError.message : 'Unknown error'
      console.error('[NIM-Sync] Cache write failed:', msg)
      safeShowToast({ title: 'NVIDIA Sync Failed', description: 'Failed to write cache: ' + msg, variant: 'error' })
      throw writeError
    } finally {
      if (releaseLockFn) { try { await releaseLockFn() } catch (e) { console.error('[NIM-Sync] Failed to release cache lock:', e) } }
    }
  }

  const getAPIKey = async (): Promise<string | null> => {
    // Priority order:
    // 1. First check auth.json -> credentials.nim.apiKey
    // 2. Fallback to NVIDIA_API_KEY environment variable
    // 3. Return null if neither is available
    try {
      const auth = await readJSONC<AuthConfig>(getAuthPath())
      if (!auth || Object.keys(auth).length === 0) {
        console.debug('[NIM-Sync] No auth.json found, checking env var')
        return process.env.NVIDIA_API_KEY || null
      }
      if (auth.credentials?.nim?.apiKey && typeof auth.credentials.nim.apiKey === 'string') {
        return auth.credentials.nim.apiKey
      }
      console.debug('[NIM-Sync] No credentials in auth.json, checking env var')
      return process.env.NVIDIA_API_KEY || null
    } catch (error) {
      console.error('[NIM-Sync] Failed to read auth:', error instanceof Error ? error.message : 'Unknown error')
      return process.env.NVIDIA_API_KEY || null
    }
  }

  const exposedGetAPIKey = getAPIKey

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
        id: m.id, name: m.name,
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

  const shouldRefresh = async (): Promise<boolean> => {
    try {
      const config = api.config.get<OpenCodeConfig>()
      if (!config?.provider?.nim) return true
      const cache = await readCache()
      if (!cache?.lastRefresh) return true
      return Date.now() - cache.lastRefresh > CACHE_TTL_MS
    } catch { return true }
  }

  const exposedShouldRefresh = shouldRefresh
  const updateConfig = async (models: NIMModel[]): Promise<boolean> => {
    const config = await readJSONC<OpenCodeConfig>(getConfigPath())

    const newModels = models.reduce((acc, m) => {
      acc[m.id] = { name: m.name, options: config?.provider?.nim?.models?.[m.id]?.options || {} }
      return acc
    }, {} as Record<string, { name: string; options: Record<string, unknown> }>)
    const modelsHash = hashModels(models)
    const cache = await readCache()

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

    if (cache?.modelsHash === modelsHash && !managedConfigChanged) {
      try {
        await writeCache({ ...cache, lastRefresh: Date.now(), modelsHash, baseURL: NIM_BASE_URL })
      } catch { /* non-fatal */ }
      return false
    }

    let releaseLockFn: (() => Promise<void>) | null = null
    try { releaseLockFn = await acquireLock('nim-config-update') } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown'
      console.error('[NIM-Sync] Config lock failed:', msg)
      safeShowToast({ title: 'NVIDIA Config Lock Failed', description: msg, variant: 'error' })
      throw e
    }
    try {
      const updatedConfig: OpenCodeConfig = {
        ...(config || {}),
        provider: { ...config?.provider, nim: updatedNIMConfig }
      }
      const validation = validateOpenCodeConfig(updatedConfig)
      if (!validation.valid) {
        console.warn('[NIM-Sync] Config validation warnings:', validation.errors)
      }
      await updateJSONCPath(getConfigPath(), ['provider', 'nim'], updatedNIMConfig, { backup: true, createBackupDir: true })
      try { await writeCache({ lastRefresh: Date.now(), modelsHash, baseURL: NIM_BASE_URL }) } catch { /* non-fatal */ }
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown'
      console.error('[NIM-Sync] Config update failed:', msg)
      safeShowToast({ title: 'NVIDIA Config Update Failed', description: msg, variant: 'error' })
      throw e
    } finally {
      if (releaseLockFn) { try { await releaseLockFn() } catch (e) { console.error('[NIM-Sync] Failed to release config lock:', e) } }
    }
  }

  const exposedUpdateConfig = updateConfig

  const refreshModels = async (force = false): Promise<void> => {
    if (refreshInProgress) return
    refreshInProgress = true
    let apiKey: string | null = null
    try {
      if (!force && !(await shouldRefresh())) return
      apiKey = await getAPIKey()
      if (!apiKey) { safeShowToast({ title: 'NVIDIA API Key Required', description: 'Run /connect to add your NVIDIA API key', variant: 'error' }); return }
      const models = await fetchModels(apiKey)
      if (models.length === 0) { safeShowToast({ title: 'No Models Available', description: 'NVIDIA API returned no models.', variant: 'error' }); return }
      const changed = await updateConfig(models)
      if (changed) safeShowToast({ title: 'NVIDIA NIM Models Updated', description: models.length + ' models synchronized', variant: 'success' })
    } catch (error) {
      const msg = sanitizeErrorMessage(error instanceof Error ? error.message : 'Unknown error', apiKey)
      console.error('[NIM-Sync] Model refresh failed:', msg)
      safeShowToast({ title: 'NVIDIA Sync Failed', description: msg, variant: 'error' })
      try { await writeCache({ modelsHash: '', lastError: msg, baseURL: NIM_BASE_URL }) } catch { /* ignore */ }
    } finally { refreshInProgress = false }
  }

  const init = async (): Promise<void> => {
    try {
      api.command.register('nim-refresh', async () => {
        const now = Date.now()
        if (now - lastManualRefresh < MIN_MANUAL_REFRESH_INTERVAL_MS) {
          const remainingSeconds = Math.ceil((MIN_MANUAL_REFRESH_INTERVAL_MS - (now - lastManualRefresh)) / 1000)
          safeShowToast({ title: 'Rate Limited', description: 'Please wait ' + remainingSeconds + 's before refreshing again', variant: 'default' })
          return
        }
        lastManualRefresh = now
        await refreshModels(true)
      }, { description: 'Force refresh NVIDIA NIM models' })
    } catch (e) { console.error('[NIM-Sync] Failed to register command:', e) }
    void refreshModels().catch((e) => { console.error('[NIM-Sync] Init failed:', e) })
  }

  const hooks = {
    'server.connected': async () => { try { await refreshModels() } catch (e) { console.error('[NIM-Sync] Hook failed:', e) } },
    'session.created': async () => { try { await refreshModels() } catch (e) { console.error('[NIM-Sync] Hook failed:', e) } }
  }

  const exposedRefreshModels = refreshModels
  return { init, hooks, getAPIKey: exposedGetAPIKey, updateConfig: exposedUpdateConfig, refreshModels: exposedRefreshModels, shouldRefresh: exposedShouldRefresh }
}

export default syncNIMModels
