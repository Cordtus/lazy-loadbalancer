## Lazy Load Balancer — Quick AI Agent Guide

This file helps AI coding agents get productive fast. Keep answers actionable and reference files.

Core facts:
- Runtime: Bun (>=1.1.0). Prefer `bun` CLI; `package.json` uses Bun scripts.
- Server: Hono; entry is `src/index.ts` (routes + boot).
- Data storage: `data/` and `data/metadata/` (per-chain JSONs, ports, ip lists).

Architecture snapshot:
- `index.ts`: Hono app, routes (/api, /lb/:chain/*, /config, /cache), bootstraps Scheduler.
- `balancer.ts`: route configs, per-chain/route LoadBalancer, proxyWithCaching(), circuit breakers.
- `crawler.ts`: peer discovery (status/net_info), port extraction, recursive crawl.
- `dataService.ts` + `utils.ts`: persistent JSON storage and helpers (ports, chain list, IP lists).
- `config.ts`: `config.service` singleton, global + per-chain config, watchers (dev-only hot reload).
- `cacheManager.ts`: 4-tier Map TTL cache (main/persistent/session/metrics).

Developer flows (commands):
- Start: `bun run src/index.ts`
- Dev: `bun run --watch src/index.ts`
- Build: `bun build src/index.ts --outdir dist --target bun`
- Tests: `bun test` (tests import vitest-style APIs)
- Lint/format: `bunx @biomejs/biome check src/` and `bunx @biomejs/biome format --write src/`

Patterns & conventions (practical):
- Use `config.service.getEffectiveRouteConfig(chain, path)` for route-specific behavior.
- For persistent data changes, call `dataService.fetchChainsFromGitHub()` then `initChainsData()`.
- Use `cacheManager` API (`get/set/flush/stats`) and respect cache selection by key patterns.
- Circuit breaker: `CircuitBreaker` protects endpoints; tests should assert open/closed transitions.
- Types in `src/types.ts`; prefer `import type { ... }` when only using types.

Testing tips (specific):
- Mock external services: `vi.mock('../src/dataService')`, `vi.mock('../src/logger')`, `vi.mock('../src/cacheManager')`.
- Export small test-only helpers (e.g., `_test_extractPeerInfo`) rather than duplicate logic in tests.
- Test the balancer via `proxyWithCaching` + mocks for `fetch` and `circuitBreaker` behavior.

Quick examples & debug commands:
- Trigger crawl: `curl -X POST http://localhost:3000/api/update-all-chains`
- Get a chain RPC: `curl http://localhost:3000/lb/osmosis/status`
- Flush cache: `curl -X DELETE http://localhost:3000/cache/osmosis/` 
- Health: `curl http://localhost:3000/health` and `curl http://localhost:3000/stats`

Common gotchas:
- README may show Yarn/Node; prefer Bun commands and adjust docs if you modify runtime.
- `utils.normalizeUrl()` strips a single trailing slash; tests may expect different behavior—keep them in sync.
- The crawler treats `001.002.003.004` style addresses as valid due to its IPv4 regex (keep in mind).

Authoritative files to read first:
- `src/index.ts`, `src/balancer.ts`, `src/crawler.ts`, `src/dataService.ts`, `src/config.ts`, `src/cacheManager.ts`, `src/utils.ts`, `src/types.ts`.

If unclear, ask: (1) which module to change, (2) whether the change affects persisted data, (3) CI/test constraints.
## Lazy Load Balancer — AI Agent Instructions

This document summarizes the essential knowledge and conventions to help AI coding agents be productive in this repository.

Key facts (short):
- Runtime: Bun (>=1.1.0) — the repo is a Bun-first project; use `bun` commands.
- Server framework: Hono (HTTP + middleware routing).
- Entry: `src/index.ts` (registers routes, bootstraps services).
- Primary modules: `balancer.ts`, `crawler.ts`, `dataService.ts`, `cacheManager.ts`, `config.ts`, `scheduler.ts`, `logger.ts`, `utils.ts`, and `types.ts`.
- Data: `data/` and `data/metadata/` JSON files (chain files, ports, IP lists).

1) Big-picture architecture
- `index.ts` sets up the server and routes. The `/lb/:chain/*` routes proxy to `balancer.proxyWithCaching()`.
- `balancer.ts` is where load balancing strategies, per-route balancers, stats, and circuit breakers are implemented.
- `crawler.ts` collects RPC endpoints by crawling peers (`/status`, `/net_info`), extracting `remote_ip`, `listen_addr`, and RPC ports.
- `dataService.ts` converts GitHub chain-registry JSONs to `ChainEntry` objects and stores/loads them (via `utils.ts` file helpers).
- `config.ts` loads `config/global.json` and `config/chains/*.json` and exposes `config.service` to access route and chain configs.

2) Build, run, test, and lint (developer flows)
- Use Bun for all runtime commands. The `package.json` includes:
  - Start: `bun run src/index.ts`
  - Dev (watch): `bun run --watch src/index.ts`
  - Build: `bun build src/index.ts --outdir dist --target bun`
  - Tests: `bun test` (the tests use vitest-style suites; mock filesystem/DI when appropriate)
  - Lint/format: `bunx @biomejs/biome check src/` and `bunx @biomejs/biome format --write src/`
- CI: no `.github/workflows` present in this branch—use `bun build` + `bun test` and Biome lint in pipelines.

3) Project-specific conventions and patterns
- Environment variables: `PORT`, `GITHUB_PAT`, `REQUEST_TIMEOUT`, `CRAWLER_TIMEOUT`, `CRAWLER_RETRIES`, `LOG_LEVEL_app|balancer|crawler`.
- Singletons: `config.service` and default exported `dataService` are shared across modules.
- Strategy pattern: Load-balancing algorithms are selected by `config.service.getEffectiveRouteConfig(chain, path)`; `LoadBalancer` instances are per-chain/per-route.
- Caching: `cacheManager` exposes `get/set/flush/stats`; TTL selection uses patterns: `tx:`, `block:`, `status`, etc.
- Circuit breaker: `CircuitBreaker` class recorded success/failure and is used to skip failing endpoints.
- Config edits: Changing `config/chains/*.json` (in non-production) is watched and reloaded. Update via the `/config` API for runtime updates.

4) File/Storage notes
- Data files: `data/` and `data/metadata/` (ports, chain list, rejected/blacklisted IPs, good IP list). `utils.ensureFilesExist()` populates defaults.
- Logs: module-specific logs in `logs/` (rotates by date).

5) Testing patterns & tips
- Tests are in `tests/` using vitest-style functions. Run them with `bun test`.
- Unit tests should stub external interactions (disk, network): use `vi.mock()` on `dataService`, `logger`, and `cacheManager` when testing `balancer` or `crawler` logic.
- Internal helpers: export test-only helper functions for complex logic (e.g., `_test_extractPeerInfo`) rather than reimplementing logic in tests.
- When adding tests for the balancer, assert `stats`, `loadBalancer` weights, and that `proxyWithCaching` respects cache TTLs & circuit breaker behavior.

6) Useful examples (copy/paste)
- Start server locally (dev):
  - `PORT=3000 bun run --watch src/index.ts`
- Trigger a network crawl:
  - `curl -X POST http://localhost:3000/api/update-all-chains`
- Load balanced RPC call (example):
  - `curl http://localhost:3000/lb/osmosis/status`
- Flush cache for chain:
  - `curl -X DELETE http://localhost:3000/cache/osmosis/abci_info`

7) Common pitfalls & project-specific gotchas
- README references Yarn/Node; this branch is Bun-first—prefer Bun commands and edit docs if you change runtime.
- `utils.normalizeUrl()` strips one trailing slash (regex `replace(/\/$/, '')`), tests might expect to strip multiple; keep the behaviour consistent or update both tests + utils.
- Some tests in `tests/` currently reimplement behavior rather than calling code-under-test; prefer importing internal helpers and avoid duplicate logic.
- The `crawler` may discover addresses with leading zeros (e.g., `001.002.003.004`) — the code treats them as valid because it uses `parseInt` for `isPrivateIP` checks and a permissive IPv4 regex.

8) When editing source code — practical checklist
- Update `types.ts` for changes to domain models; keep types imported with `import type { ... } from './types.ts'`.
- Add/modify unit tests for behavior changes in `tests/`; mock `dataService` and network calls for deterministic tests.
- Run `bun test` and `bunx @biomejs/biome check src/` before submitting PR.
- Ensure any change to endpoint handling preserves JSON validation and that `proxyWithCaching` handles non-JSON responses by recording failures.

9) Important files (authoritative reference)
- `src/index.ts` — server, routes
- `src/balancer.ts` — load balancing, circuit breaker integration, proxy logic
- `src/crawler.ts` — network discovery
- `src/dataService.ts` — GitHub chain-registry fetch & persistence
- `src/config.ts` — config management & watchers
- `src/cacheManager.ts` — cache tiers and TTL heuristics
- `src/utils.ts` — file and IP/url utilities
- `src/types.ts` — shared TS types

10) Next steps & how I can help
- Want this condensed further, or prefer explicit “code change steps” for common tasks (e.g., “Add weighted strategy test”)? Tell me which areas you want expanded and I’ll iterate.

---
This file is generated using repository introspection (CLAUDE.md, UPDATES.md, README.md, and source files). Please review to include additional details (CI, environment specifics, or conventions) that you want AI agents to follow.
