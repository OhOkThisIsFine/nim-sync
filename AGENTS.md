# OpenCode NVIDIA NIM Sync Plugin - Agent Instructions

## Project Overview
A global OpenCode plugin that automatically synchronizes NVIDIA NIM models with OpenCode configuration on startup.

## Key Files
- `src/plugin/nim-sync.ts` - Main plugin implementation
- `src/lib/file-utils.ts` - File utilities with JSONC support
- `src/types/index.ts` - TypeScript definitions
- `src/__tests__/user-journeys.test.ts` - User journey tests

## Development Workflow
1. **TDD First**: Always write failing tests before implementation
2. **Run Tests**: `npm test` after every change
3. **Coverage**: Ensure 80%+ test coverage
4. **Build**: `npm run build` before committing

## Testing Commands
```bash
npm test              # Run all tests
npm run test:coverage # Run with coverage report
npm run test:watch    # Watch mode for development
npm run typecheck     # TypeScript type checking
npm run lint          # ESLint checking
```

## Plugin Architecture
- Global plugin runs at OpenCode startup
- Fetches NVIDIA `/v1/models` endpoint
- Updates `provider.nim.models` in OpenCode config
- 24-hour TTL cache to avoid excessive API calls
- `/nim-refresh` command for manual updates

## Critical Paths
1. Credential resolution (`getAPIKey()`)
2. Config file reading/writing (`readJSONC`/`writeJSONC`)
3. NVIDIA API client (`fetchModels`)
4. Atomic file operations (`acquireLock`)

## Common Issues
- Mocking `fs/promises` in tests
- Type casting for `config?.provider?.nim`
- Async plugin initialization timing
- File path resolution on Windows vs Unix

## Success Criteria
- All user journey tests pass
- 80%+ test coverage achieved
- Plugin loads without blocking OpenCode startup
- Config updates preserve user settings
- Error handling shows appropriate toasts

<!-- audit-code:begin -->
## /audit-code
When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local audit directive](.audit-code/install/audit-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- audit-code:end -->
