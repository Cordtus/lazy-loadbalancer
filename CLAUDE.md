# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lazy Load Balancer is an optimized load balancer for Cosmos SDK RPC endpoints. It dynamically fetches, caches, and crawls RPC endpoints across multiple blockchain chains, providing a unified load balancing interface through a single endpoint.

**Runtime**: Bun (v1.1+)
**Framework**: Hono

## Commands

```bash
bun start         # Run the application
bun run dev       # Development mode with watch
bun run build     # Build for production
bun run lint      # Biome lint check
bun run format    # Biome format
bun test          # Run tests
```

## Architecture

### Request Flow
```
Client Request
    -> Hono Middleware (CORS, Compress, SecureHeaders)
    -> Routes: /api/* (REST API) or /lb/:chain/* (Load Balancer)
    -> LoadBalancer (strategy selection, endpoint filtering)
    -> CircuitBreaker check
    -> Bun fetch -> CacheManager -> Response
```

### Core Modules

| Module | Role |
|--------|------|
| `index.ts` | Hono server setup, route registration, startup |
| `balancer.ts` | Load balancing with strategies (round-robin, weighted, least-connections, random, ip-hash), sticky sessions |
| `crawler.ts` | RPC endpoint discovery via peer crawling, port extraction |
| `dataService.ts` | Data access layer (file-based), GitHub chain registry fetching |
| `cacheManager.ts` | Four-tier Map-based cache (main/persistent/session/metrics) |
| `circuitBreaker.ts` | Fault tolerance via CLOSED/OPEN/HALF_OPEN states |
| `config.ts` | File-based config with hot-reload support |
| `scheduler.ts` | setInterval-based task scheduling |
| `utils.ts` | File I/O helpers, IP validation, URL normalization |
| `logger.ts` | Lightweight logger with file rotation |
| `types.ts` | TypeScript interfaces |

### Storage

- **Primary**: JSON files in `/data` directory (per-chain files, metadata in `/data/metadata/`)
- **Config**: JSON files in `/config` directory (global.json, chains/*.json)
- **Cache Tiers**: Main (60s), Persistent (1h), Session (5min), Metrics (1min)

### Key Patterns

- Singleton services: ConfigService, DataService
- Strategy pattern for load balancing algorithms
- Circuit breaker for fault tolerance
- ES Modules with `.ts` extensions in imports
- Bun-native fetch, file I/O, and serve APIs

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info and status |
| `/health` | GET | Detailed health check |
| `/stats` | GET | Load balancer stats |
| `/api/chain-list` | GET | List all chains |
| `/api/chains-summary` | GET | Chains with endpoint counts |
| `/api/rpc-list/:chain` | GET | RPC endpoints for a chain |
| `/api/update-chain/:chain` | POST | Crawl and update chain |
| `/api/update-all-chains` | POST | Crawl all chains |
| `/lb/:chain/*` | ALL | Proxy to chain RPC endpoints |
| `/config/global` | GET/PUT | Global config |
| `/config/chain/:name` | GET/PUT | Per-chain config |

## Configuration

Key environment variables:
- `PORT` - Server port (default: 3000)
- `GITHUB_PAT` - GitHub Personal Access Token for chain registry
- `REQUEST_TIMEOUT`, `CRAWLER_TIMEOUT`, `CRAWLER_RETRIES`

Timeouts: Crawler 3000ms, Balancer 12000ms, Circuit Breaker reset 30s

## Code Style

- TypeScript strict mode, ESNext target
- camelCase naming, single quotes, trailing commas
- Tab indentation, 100 char width
- Biome for linting and formatting
