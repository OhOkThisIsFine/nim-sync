import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshModels = vi.fn()
const getNextRefreshDelay = vi.fn()
const manualRefresh = vi.fn()

vi.mock('../plugin/nim-sync-service.js', () => ({
  createNIMSyncService: vi.fn(() => ({
    refreshModels,
    getNextRefreshDelay,
    manualRefresh
  }))
}))

import plugin from '../plugin/opencode-server.js'

describe('official server plugin', () => {
  beforeEach(() => {
    vi.useRealTimers()
    refreshModels.mockReset()
    getNextRefreshDelay.mockReset()
    manualRefresh.mockReset()
    refreshModels.mockResolvedValue('unchanged')
    getNextRefreshDelay.mockResolvedValue(60_000)
  })

  it('exposes a stable plugin id', () => {
    expect(plugin.id).toBe('nim-sync')
  })

  it('refreshes on server and session lifecycle events without migration side effects', async () => {
    const showToast = vi.fn()
    const log = vi.fn()

    const hooks = await plugin.server({
      client: {
        tui: {
          showToast
        },
        app: {
          log
        }
      }
    } as any, undefined)

    expect(showToast).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()

    await hooks.event?.({ event: { type: 'server.connected' } as any })
    await hooks.event?.({ event: { type: 'session.created' } as any })

    expect(refreshModels).toHaveBeenCalledTimes(2)
    expect(getNextRefreshDelay).toHaveBeenCalledTimes(2)
  })

  it('schedules the next automatic refresh after the startup refresh completes', async () => {
    vi.useFakeTimers()

    const hooks = await plugin.server({
      client: {
        tui: {
          showToast: vi.fn()
        }
      }
    } as any, undefined)

    await hooks.event?.({ event: { type: 'server.connected' } as any })

    expect(refreshModels).toHaveBeenCalledTimes(1)
    expect(getNextRefreshDelay).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(refreshModels).toHaveBeenCalledTimes(2)
    expect(getNextRefreshDelay).toHaveBeenCalledTimes(2)
  })

  it('replaces the existing automatic refresh timer when another lifecycle refresh runs', async () => {
    vi.useFakeTimers()
    getNextRefreshDelay
      .mockResolvedValueOnce(60_000)
      .mockResolvedValueOnce(120_000)
      .mockResolvedValue(120_000)

    const hooks = await plugin.server({
      client: {
        tui: {
          showToast: vi.fn()
        }
      }
    } as any, undefined)

    await hooks.event?.({ event: { type: 'server.connected' } as any })
    await hooks.event?.({ event: { type: 'session.created' } as any })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshModels).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshModels).toHaveBeenCalledTimes(3)
  })

  it('uses a shorter retry delay after failed background refreshes', async () => {
    vi.useFakeTimers()
    refreshModels
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('unchanged')
    getNextRefreshDelay.mockResolvedValue(60_000)

    const hooks = await plugin.server({
      client: {
        tui: {
          showToast: vi.fn()
        }
      }
    } as any, undefined)

    await hooks.event?.({ event: { type: 'server.connected' } as any })

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000)
    expect(refreshModels).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshModels).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshModels).toHaveBeenCalledTimes(3)
  })

  it('does not expose a server-side /nim-refresh prompt hook', async () => {
    const hooks = await plugin.server({
      client: {
        tui: {
          showToast: vi.fn()
        }
      }
    } as any, undefined)

    expect(hooks['command.execute.before']).toBeUndefined()
    expect(manualRefresh).not.toHaveBeenCalled()
  })
})
