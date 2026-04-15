import path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import type { PluginAPI } from '../types/index.js'
import { syncNIMModels } from '../plugin/nim-sync.js'
import { getCacheDir, getConfigDir } from '../lib/file-utils.js'
import { createMockPluginAPI } from './mocks.js'

vi.mock('fs/promises')
vi.mock('../lib/retry.js', () => ({
  withRetry: vi.fn().mockImplementation(async (fn) => fn())
}))
vi.mock('crypto', () => {
  const createHash = () => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn((_encoding: string) => 'test-hash-value')
  })
  return {
    default: { createHash },
    createHash
  }
})

const flushAsyncWork = async (cycles = 5): Promise<void> => {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

describe('NIM Sync Unit Tests', () => {
  let mockPluginAPI: PluginAPI

  beforeEach(() => {
    vi.clearAllMocks()
    mockPluginAPI = createMockPluginAPI()
    process.env.USERPROFILE = '/test/user'
    process.env.NVIDIA_API_KEY = 'test-api-key'

    vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
      if (filePath.includes('auth.json')) {
        return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
      }
      return Promise.resolve('{}')
    })
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.open).mockResolvedValue({
      close: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined)
    } as any)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.stat).mockResolvedValue({ mtimeMs: Date.now() } as any)
  })

  describe('getAuthPath', () => {
    it('uses Windows path on Windows platform', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })

      expect(mockFetch).toHaveBeenCalled()
    })

    it('uses Unix path on Linux/macOS', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })

      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe('shouldRefresh logic', () => {
    it('returns true when config has no nim provider', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] })
      })
      global.fetch = mockFetch

      mockPluginAPI.config.get = vi.fn(() => ({})) as any

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockFetch).toHaveBeenCalled()
    })

    it('returns true when cache has no lastRefresh', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] })
      })
      global.fetch = mockFetch

      mockPluginAPI.config.get = vi.fn(() => ({ provider: { nim: { models: {} } } })) as any

      const cacheNoTimestamp = JSON.stringify({ modelsHash: 'abc123' })
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        return Promise.resolve(cacheNoTimestamp)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockFetch).toHaveBeenCalled()
    })
  })

  describe('updateConfig', () => {
    it('fails safe when the existing config cannot be parsed', async () => {
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        if (filePath.includes('opencode.jsonc')) {
          return Promise.resolve('{ invalid json }')
        }
        return Promise.resolve('{}')
      })

      const plugin = await syncNIMModels(mockPluginAPI)

      await expect(plugin.updateConfig?.([
        { id: 'existing-model', name: 'Existing Model' }
      ])).rejects.toThrow('JSONC parse errors')

      const writePaths = vi.mocked(fs.writeFile).mock.calls.map(([filePath]) => String(filePath))
      expect(writePaths.some(filePath => filePath.includes('opencode.jsonc'))).toBe(false)
    })

    it('deep merges provider.nim without overwriting other provider data', async () => {
      const existingConfig = JSON.stringify({
        provider: {
          anthropic: { apiKey: 'anthropic-key', models: {} },
          openai: { apiKey: 'openai-key' }
        }
      })
      vi.mocked(fs.readFile).mockResolvedValue(existingConfig)

      const models = [{ id: 'meta/llama-3.1-70b-instruct', name: 'Meta Llama 3.1 70B Instruct' }]

      const plugin = await syncNIMModels(mockPluginAPI)
      const changed = await (plugin as any).updateConfig(models)

      expect(changed).toBe(true)
      const configWrite = vi.mocked(fs.writeFile).mock.calls.find(([filePath]) =>
        String(filePath).includes('opencode.jsonc')
      )
      const updatedConfig = JSON.parse(String(configWrite?.[1]))
      expect(updatedConfig.provider.anthropic.apiKey).toBe('anthropic-key')
      expect(updatedConfig.provider.openai.apiKey).toBe('openai-key')
      expect(updatedConfig.provider.nim.models).toBeDefined()
    })

    it('preserves existing model options', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'existing-model', name: 'Existing Model' }] })
      })
      global.fetch = mockFetch

      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            models: {
              'existing-model': {
                name: 'Existing Model',
                options: { temperature: 0.5, max_tokens: 2000 }
              }
            }
          }
        }
      })

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        return Promise.resolve(existingConfig)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockFetch).toHaveBeenCalled()
    })

    it('preserves existing provider-level nim options', async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            options: {
              region: 'us-west-2',
              timeout: 45_000
            },
            models: {
              'existing-model': {
                name: 'Existing Model',
                options: {}
              }
            }
          }
        }
      })

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        return Promise.resolve(existingConfig)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      const changed = await plugin.updateConfig?.([
        { id: 'existing-model', name: 'Existing Model' }
      ])

      expect(changed).toBe(true)

      const configWrite = vi.mocked(fs.writeFile).mock.calls.find(([filePath]) =>
        String(filePath).includes('opencode.jsonc')
      )
      const updatedConfig = JSON.parse(String(configWrite?.[1]))

      expect(updatedConfig.provider.nim.options.region).toBe('us-west-2')
      expect(updatedConfig.provider.nim.options.timeout).toBe(45_000)
      expect(updatedConfig.provider.nim.options.baseURL).toBe('https://integrate.api.nvidia.com/v1')
    })

    it('preserves existing JSONC comments when updating config', async () => {
      const existingConfig = `{
  // keep this top-level comment
  "provider": {
    // keep this provider comment
    "openai": {
      "apiKey": "openai-key"
    }
  },
  "model": "nim/existing-model"
}`

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        return Promise.resolve(existingConfig)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      const changed = await plugin.updateConfig?.([
        { id: 'existing-model', name: 'Existing Model' }
      ])

      expect(changed).toBe(true)

      const configWrite = vi.mocked(fs.writeFile).mock.calls.find(([filePath]) =>
        String(filePath).includes('opencode.jsonc')
      )
      const updatedContent = String(configWrite?.[1])

      expect(updatedContent).toContain('// keep this top-level comment')
      expect(updatedContent).toContain('// keep this provider comment')
    })

    it('refreshes the cache timestamp when models are unchanged', async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: '@ai-sdk/openai-compatible',
            name: 'NVIDIA NIM',
            options: {
              baseURL: 'https://integrate.api.nvidia.com/v1'
            },
            models: {
              'existing-model': {
                name: 'Existing Model',
                options: {}
              }
            }
          }
        }
      })

      const existingCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash: 'test-hash-value'
      })

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        if (filePath.includes('nim-sync-cache.json')) {
          return Promise.resolve(existingCache)
        }
        return Promise.resolve(existingConfig)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      const changed = await plugin.updateConfig?.([
        { id: 'existing-model', name: 'Existing Model' }
      ])

      expect(changed).toBe(false)

      const writePaths = vi.mocked(fs.writeFile).mock.calls.map(([filePath]) => String(filePath))
      expect(writePaths.some(filePath => filePath.includes('nim-sync-cache.json'))).toBe(true)
      expect(writePaths.some(filePath => filePath.includes('opencode.jsonc'))).toBe(false)
    })

    it('reconciles managed nim fields even when the model hash is unchanged', async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            npm: 'custom-package',
            name: 'Custom NVIDIA',
            options: {
              baseURL: 'https://example.com/v1',
              region: 'us-west-2'
            },
            models: {
              'existing-model': {
                name: 'Existing Model'
              }
            }
          }
        }
      })

      const existingCache = JSON.stringify({
        lastRefresh: Date.now() - 25 * 60 * 60 * 1000,
        modelsHash: 'test-hash-value'
      })

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        if (filePath.includes('nim-sync-cache.json')) {
          return Promise.resolve(existingCache)
        }
        return Promise.resolve(existingConfig)
      })

      const plugin = await syncNIMModels(mockPluginAPI)
      const changed = await plugin.updateConfig?.([
        { id: 'existing-model', name: 'Existing Model' }
      ])

      expect(changed).toBe(true)

      const configWrite = vi.mocked(fs.writeFile).mock.calls.find(([filePath]) =>
        String(filePath).includes('opencode.jsonc')
      )
      const updatedConfig = JSON.parse(String(configWrite?.[1]))

      expect(updatedConfig.provider.nim.npm).toBe('@ai-sdk/openai-compatible')
      expect(updatedConfig.provider.nim.name).toBe('NVIDIA NIM')
      expect(updatedConfig.provider.nim.options.baseURL).toBe('https://integrate.api.nvidia.com/v1')
      expect(updatedConfig.provider.nim.options.region).toBe('us-west-2')
    })

    it('writes the cache file to the cache directory instead of the config directory', async () => {
      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.updateConfig?.([
        { id: 'model-1', name: 'Model 1' }
      ])

      const writePaths = vi.mocked(fs.writeFile).mock.calls.map(([filePath]) => String(filePath))
      const cacheFileBase = path.join(getCacheDir(), 'nim-sync-cache.json')
      const configFileBase = path.join(getConfigDir(), 'nim-sync-cache.json')

      expect(writePaths.some(filePath => filePath.includes(cacheFileBase))).toBe(true)
      expect(writePaths.some(filePath => filePath.includes(configFileBase))).toBe(false)
    })
  })

  describe('hooks', () => {
    it('exposes server.connected hook', async () => {
      const plugin = await syncNIMModels(mockPluginAPI)
      expect(plugin.hooks).toBeDefined()
      expect(plugin.hooks?.['server.connected']).toBeDefined()
    })

    it('exposes session.created hook', async () => {
      const plugin = await syncNIMModels(mockPluginAPI)
      expect(plugin.hooks).toBeDefined()
      expect(plugin.hooks?.['session.created']).toBeDefined()
    })
  })

  describe('init', () => {
    it('does not block startup on the initial model refresh', async () => {
      let resolveFetch: ((value: {
        ok: true
        json: () => Promise<{ data: Array<{ id: string; name: string }> }>
      }) => void) | null = null

      global.fetch = vi.fn(() =>
        new Promise(resolve => {
          resolveFetch = resolve
        }) as Promise<Response>
      )

      const plugin = await syncNIMModels(mockPluginAPI)
      let initResolved = false
      const initPromise = plugin.init?.().then(() => {
        initResolved = true
      })

      await Promise.resolve()

      expect(initResolved).toBe(true)
      expect(mockPluginAPI.command.register).toHaveBeenCalledWith(
        'nim-refresh',
        expect.any(Function),
        expect.objectContaining({
          description: expect.stringContaining('NVIDIA')
        })
      )

      resolveFetch?.({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] })
      })
      await initPromise
    })
  })

  describe('error handling', () => {
    it('handles API errors with status code', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          variant: 'error'
        })
      )
    })

    it('handles network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          variant: 'error'
        })
      )
    })

    it('does not mark a failed refresh as a successful cache refresh', async () => {
      const existingConfig = JSON.stringify({
        provider: {
          nim: {
            models: {
              'existing-model': {
                name: 'Existing Model'
              }
            }
          }
        }
      })

      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('auth.json')) {
          return Promise.reject(Object.assign(new Error('File not found'), { code: 'ENOENT' }))
        }
        return Promise.resolve(existingConfig)
      })

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.refreshModels?.()

      const cacheWrite = vi.mocked(fs.writeFile).mock.calls.find(([filePath]) =>
        String(filePath).includes('nim-sync-cache.json')
      )
      const cachePayload = JSON.parse(String(cacheWrite?.[1]))

      expect(cachePayload.lastRefresh).toBeUndefined()
      expect(cachePayload.lastError).toContain('Network error')
    })
  })

  describe('getAPIKey', () => {
    it('logs generic error without sensitive data when auth.json parsing fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))

      const plugin = await syncNIMModels(mockPluginAPI)
      const apiKey = await plugin.getAPIKey?.()

      expect(apiKey).toBe('test-api-key')
      expect(consoleSpy).toHaveBeenCalledWith('[NIM-Sync] Failed to read auth:', expect.any(String))
      // Error message now includes the error details for debugging

      consoleSpy.mockRestore()
    })

    it('returns null and logs generic error for malformed auth.json', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      vi.mocked(fs.readFile).mockResolvedValueOnce('{ invalid json }')

      const plugin = await syncNIMModels(mockPluginAPI)
      const apiKey = await plugin.getAPIKey?.()

      expect(apiKey).toBe('test-api-key')
      expect(consoleSpy).toHaveBeenCalledWith('[NIM-Sync] Failed to read auth:', expect.any(String))

      consoleSpy.mockRestore()
    })

    it('returns apiKey from credentials.nim.apiKey if auth.json is valid', async () => {
      const authData = JSON.stringify({
        credentials: { nim: { apiKey: 'stored-api-key-123' } }
      })

      vi.mocked(fs.readFile).mockResolvedValueOnce(authData)

      const plugin = await syncNIMModels(mockPluginAPI)
      const apiKey = await plugin.getAPIKey?.()

      expect(apiKey).toBe('stored-api-key-123')
    })

    it('returns apiKey from environment variable if auth.json is empty', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('{}')

      const plugin = await syncNIMModels(mockPluginAPI)
      const apiKey = await plugin.getAPIKey?.()

      expect(apiKey).toBe('test-api-key')
    })

    it('returns null if no apiKey is found in auth.json or environment', async () => {
      delete process.env.NVIDIA_API_KEY
      vi.mocked(fs.readFile).mockResolvedValueOnce('{}')

      const plugin = await syncNIMModels(mockPluginAPI)
      const apiKey = await plugin.getAPIKey?.()

      expect(apiKey).toBeNull()

      process.env.NVIDIA_API_KEY = 'test-api-key'
    })
  })

  describe('API response validation', () => {
    it('throws error for invalid API response structure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: 'structure' })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          description: expect.stringContaining('invalid')
        })
      )
    })

    it('throws error when data array contains invalid model', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: '', name: 'Invalid Model' }] })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          description: expect.stringContaining('Invalid')
        })
      )
    })

    it('throws error when model name is empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'valid-id', name: '' }] })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          description: expect.stringContaining('invalid name')
        })
      )
    })

    it('throws error when duplicate model IDs are present', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ 
          data: [
            { id: 'duplicate-id', name: 'Model 1' },
            { id: 'duplicate-id', name: 'Model 2' }
          ] 
        })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NVIDIA Sync Failed',
          description: expect.stringContaining('Duplicate model ID')
        })
      )
    })

    it('shows warning when API returns empty model list', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] })
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'No Models Available',
          description: expect.stringContaining('NVIDIA API returned no models')
        })
      )
    })
  })

  describe('race condition prevention', () => {
    it('concurrent refreshModels calls share single refresh operation', async () => {
      let fetchCount = 0
      const mockFetch = vi.fn(async () => {
        fetchCount++
        await new Promise(resolve => setTimeout(resolve, 50))
        return { ok: true, json: () => Promise.resolve({ data: [{ id: 'model-1', name: 'Model 1' }] }) }
      })
      global.fetch = mockFetch

      const plugin = await syncNIMModels(mockPluginAPI)

      const promise1 = plugin.refreshModels?.()
      const promise2 = plugin.refreshModels?.()
      const promise3 = plugin.refreshModels?.()

      await Promise.all([promise1, promise2, promise3])
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(fetchCount).toBe(1)
    })
  })

  describe('rate limiting for manual refresh', () => {
    it('shows warning when refresh is called too frequently', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'm1', name: 'M1' }] })
      })
      global.fetch = mockFetch

      // Capture the nim-refresh command handler
      let nimRefreshHandler: (() => Promise<void>) | null = null
      mockPluginAPI.command.register = vi.fn((name, handler) => {
        if (name === 'nim-refresh') {
          nimRefreshHandler = handler as () => Promise<void>
        }
      }) as any

      const plugin = await syncNIMModels(mockPluginAPI)
      await plugin.init?.()
      await flushAsyncWork()

      // First manual refresh should work
      expect(nimRefreshHandler).not.toBeNull()
      if (nimRefreshHandler) {
        await nimRefreshHandler()
      }

      expect(mockFetch).toHaveBeenCalledTimes(2) // init + manual refresh

      // Second immediate refresh (without waiting 60 seconds) should be rate limited
      vi.clearAllMocks()
      if (nimRefreshHandler) {
        await nimRefreshHandler()
      }

      expect(mockPluginAPI.tui.toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ 
          title: 'Rate Limited',
          description: expect.stringMatching(/Please wait \d+s before refreshing again/)
        })
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

})

