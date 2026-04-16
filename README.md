# OpenCode NVIDIA NIM Sync Plugin

A global OpenCode plugin that automatically synchronizes NVIDIA NIM models with your OpenCode configuration on startup.

## Features

- **Automatic Sync**: On OpenCode startup, fetches the latest NVIDIA model catalog
- **Config Management**: Updates `provider.nim.models` in your OpenCode config
- **TTL Cache**: Only refreshes models if last refresh was >24 hours ago
- **Manual Refresh**: `/nim-refresh` command for force updates
- **Atomic Operations**: Safe file writes with backups and locking
- **Error Handling**: Graceful fallback when offline or missing API key

## Installation

The simplest install path is OpenCode's built-in plugin installer:

```bash
opencode plugin nim-sync -g
```

That is the supported path. It installs both the server and TUI plugin targets into your global OpenCode config, so background sync and `/nim-refresh` autocomplete are available after restart.

You can also install through the Plugins dialog in OpenCode.

You do not need to edit `opencode.json` manually when you use the installer. It updates the OpenCode config files for you.

Ensure you have an NVIDIA API key either:
   - Set `NVIDIA_API_KEY` environment variable
   - Run `/connect` in OpenCode to add NVIDIA credentials

On startup, the server plugin refreshes the NVIDIA model catalog in the background.
The TUI plugin registers `/nim-refresh` for manual updates.

## Configuration

The plugin manages this subtree in your OpenCode config:

```json
{
  "provider": {
    "nim": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA NIM",
      "options": {
        "baseURL": "https://integrate.api.nvidia.com/v1"
      },
      "models": {
        "meta/llama-3.1-70b-instruct": {
          "name": "Meta Llama 3.1 70B Instruct"
        }
      }
    }
  }
}
```

## User Ownership

The plugin ONLY manages:
- `provider.nim.npm`
- `provider.nim.name`
- `provider.nim.options.baseURL`
- `provider.nim.models`

You retain control over:
- Top-level `model` selection
- `small_model` setting
- Per-model option overrides
- Any unrelated providers

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test -- --run

# Run tests with coverage
npm run test:coverage -- --run

# Build the bundled plugin artifact
npm run build

# Type check
npm run typecheck

# Lint
npm run lint
```

### Local Testing

`npm run build` now produces:
- `dist/server.mjs` for the OpenCode server runtime
- `dist/tui.mjs` for the OpenCode TUI runtime

If you are testing from this repository instead of npm, point OpenCode at the local package so both targets are available.

## Release Automation

This repository includes [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which publishes to npm whenever you push a `v*` tag.
On tag pushes, the workflow verifies that the tag matches `package.json`, then runs `npm ci`, tests, lint, typecheck, build, and `npm publish`.
If you click `Run workflow` in GitHub Actions manually, the run is validation-only: it skips tag verification and skips publishing.
The publish workflow uses Node 24 because npm trusted publishing requires Node 22.14.0 or higher.

### Current Status

`nim-sync` is already published on npm and a GitHub Actions `Trusted Publisher` is already configured for this repository.

Current trusted publisher settings:
- Owner/user: `EthanBerlant`
- Repository: `nim-sync`
- Workflow filename: `publish.yml`

If you cloned the repository before the rename, update your local remote:

```bash
git remote set-url origin https://github.com/EthanBerlant/nim-sync.git
```

To verify the trusted publisher from the CLI:

```bash
npm trust list nim-sync
```

If a GitHub Actions publish run fails with `E404`, check these two things first:
- The workflow is using Node 22.14.0 or higher
- The npm Trusted Publisher still exactly matches `EthanBerlant` / `nim-sync` / `publish.yml`

### Releasing a New Version

The easiest flow is:

```bash
npm version patch
git push origin HEAD --follow-tags
```

Use `npm version minor` or `npm version major` when appropriate.

If you prefer to create the tag manually instead of using `npm version`, this works too:

```bash
npm version --no-git-tag-version 1.0.1
git add package.json package-lock.json
git commit -m "Release 1.0.1"
git tag v1.0.1
git push origin HEAD
git push origin v1.0.1
```

### What the Workflow Does

On every pushed `v*` tag, GitHub Actions:
- Verifies the pushed tag matches `package.json`
- Installs dependencies with `npm ci`
- Runs the test suite
- Runs lint and typecheck
- Builds the package
- Publishes the package to npm using GitHub OIDC trusted publishing

## Test-Driven Development

This project follows strict TDD principles:

1. **Tests First**: All functionality has failing tests written first
2. **80%+ Coverage**: Unit, integration, and user journey tests
3. **User Journeys**: Tests based on actual user scenarios
4. **Red-Green-Refactor**: Standard TDD workflow

## Architecture

### File Structure
```
src/
├── plugin/nim-sync.ts       # Legacy test-facing wrapper for the shared sync service
├── plugin/nim-sync-service.ts# Shared NIM sync service
├── plugin/opencode-server.ts# Official OpenCode server entrypoint
├── plugin/opencode-tui.ts   # Official OpenCode TUI entrypoint
├── lib/file-utils.ts        # File operations with JSONC support
├── types/index.ts          # TypeScript definitions
└── __tests__/              # Test suites

scripts/
├── clean.mjs                # Cross-platform dist cleanup
└── bundle.mjs               # Dual-target OpenCode bundling
```

### Key Components
- **Server Plugin**: Runs background refresh on OpenCode lifecycle events
- **TUI Plugin**: Registers `/nim-refresh` for slash autocomplete
- **Shared Sync Service**: Holds the API, cache, and config update logic
- **Credential Resolution**: Checks `/connect` auth or env var
- **NVIDIA API Client**: Fetches `/v1/models` endpoint
- **Config Management**: Atomically updates OpenCode config
- **Cache System**: 24-hour TTL to avoid excessive API calls

## License

MIT
