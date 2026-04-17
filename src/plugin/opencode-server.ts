import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import { createNIMSyncService } from './nim-sync-service.js'

const BACKGROUND_RETRY_DELAYS_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000
]

const server: Plugin = async (input) => {
  const service = createNIMSyncService({
    showToast: async ({ title, message, variant }) => {
      await input.client.tui.showToast({
        body: {
          title,
          message,
          variant
        }
      })
    }
  })
  let scheduledRefresh: ReturnType<typeof setTimeout> | undefined
  let failureCount = 0

  const clearScheduledRefresh = (): void => {
    if (!scheduledRefresh) {
      return
    }

    clearTimeout(scheduledRefresh)
    scheduledRefresh = undefined
  }

  const scheduleRefresh = (delayMs: number): void => {
    clearScheduledRefresh()
    scheduledRefresh = setTimeout(() => {
      void runRefreshCycle()
    }, Math.max(0, delayMs))
  }

  const scheduleNextStaleRefresh = async (): Promise<void> => {
    failureCount = 0
    scheduleRefresh(await service.getNextRefreshDelay())
  }

  const scheduleRetryRefresh = (): void => {
    const retryDelay = BACKGROUND_RETRY_DELAYS_MS[
      Math.min(failureCount, BACKGROUND_RETRY_DELAYS_MS.length - 1)
    ]

    failureCount = Math.min(failureCount + 1, BACKGROUND_RETRY_DELAYS_MS.length - 1)
    scheduleRefresh(retryDelay)
  }

  const runRefreshCycle = async (): Promise<void> => {
    const result = await service.refreshModels()

    if (result === 'failed') {
      scheduleRetryRefresh()
      return
    }

    if (result === 'missing-api-key') {
      clearScheduledRefresh()
      return
    }

    if (result === 'in-progress') {
      return
    }

    await scheduleNextStaleRefresh()
  }

  return {
    event: async ({ event }) => {
      if (event.type === 'server.connected' || event.type === 'session.created') {
        await runRefreshCycle()
      }
    }
  }
}

const plugin: PluginModule = {
  id: 'nim-sync',
  server
}

export default plugin
