import type { PluginAPI } from '../types/index.js'
import { createNIMSyncService } from './nim-sync-service.js'

/**
 * Legacy test-facing wrapper around the shared NIM sync service.
 *
 * The production OpenCode entrypoints use `opencode-server.ts` and
 * `opencode-tui.ts` directly. This wrapper stays around so the existing
 * unit and user-journey tests can keep exercising the core behavior through
 * the original lightweight API surface.
 */
export async function syncNIMModels(api: PluginAPI): Promise<{
  init?: () => Promise<void>
  hooks?: Record<string, () => Promise<void>>
  getAPIKey?: () => Promise<string | null>
  getNextRefreshDelay?: () => Promise<number>
  updateConfig?: (models: import('../types/index.js').NIMModel[]) => Promise<boolean>
  refreshModels?: (force?: boolean) => Promise<import('./nim-sync-service.js').NIMSyncRefreshResult>
  manualRefresh?: () => Promise<void>
  shouldRefresh?: () => Promise<boolean>
}> {
  const safeShowToast = (options: { title: string; description: string; variant: 'success' | 'error' | 'default' }): void => {
    try { api.tui.toast.show(options) } catch { return }
  }

  const service = createNIMSyncService({
    getConfigSnapshot: () => api.config.get(),
    showToast: ({ title, message, variant }) => {
      safeShowToast({
        title,
        description: message,
        variant: variant === 'success' ? 'success' : variant === 'error' ? 'error' : 'default'
      })
    }
  })

  const init = async (): Promise<void> => {
    try {
      api.command.register('nim-refresh', service.manualRefresh, { description: 'Force refresh NVIDIA NIM models' })
    } catch (e) { console.error('[NIM-Sync] Failed to register command:', e) }
    void service.refreshModels().catch((e) => { console.error('[NIM-Sync] Init failed:', e) })
  }

  const hooks = {
    'server.connected': async () => { try { await service.refreshModels() } catch (e) { console.error('[NIM-Sync] Hook failed:', e) } },
    'session.created': async () => { try { await service.refreshModels() } catch (e) { console.error('[NIM-Sync] Hook failed:', e) } }
  }

  return {
    init,
    hooks,
    getAPIKey: service.getAPIKey,
    getNextRefreshDelay: service.getNextRefreshDelay,
    updateConfig: service.updateConfig,
    refreshModels: service.refreshModels,
    manualRefresh: service.manualRefresh,
    shouldRefresh: service.shouldRefresh
  }
}

export default syncNIMModels
