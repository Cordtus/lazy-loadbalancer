# Load Balancer for Cosmos SDK RPC and REST Endpoints

Dynamically fetches, caches, and crawls Cosmos SDK RPC and REST endpoints on all supported chains. The service acts as a round-robin load balancer using the generated endpoint lists to provide one reliable interface for chain research, IBC tooling, and multi-chain API calls.

Inspired by the work of Jacob Gadikian and [Eco-stake](https://ecologi.com/ecostake), this tool combines [Notional](https://notional.ventures/)'s [RPC crawler](https://github.com/notional-labs) logic, and the [cosmos.directory](https://cosmos.directory) Load balanced proxy endpoint created by "Tom". 
It is intended as a personal load balancer / unified endpoint for multiple Cosmos-SDK / IBC chain API endpoints. 

## Requirements

- [Bun](https://bun.sh) >= 1.1.0

## Quick start

```bash
bun install
bun start          # or: bun run dev for watch mode
```

Runs on `http://localhost:3000` (set `PORT` to change). On startup it loads the chain list from [cosmos/chain-registry](https://github.com/cosmos/chain-registry), refreshes it every 12h, and crawls endpoints every 24h (the first crawl is 24h after startup). The registry fetch is unauthenticated, so a rate-limited first run falls back to existing `data/`.

## Load-balanced proxy

```bash
curl http://localhost:3000/lb/<chain>/<rpc-method-or-rest-path>

curl http://localhost:3000/lb/osmosis/status
curl http://localhost:3000/lb/cosmoshub/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address
```

- `/lb/:chain/*` selects from the chain's endpoint pool. The first path segment decides the pool: Tendermint RPC names (`status`, `block`, `tx`, `abci_query`, `net_info`, `validators`, ...) use `rpcAddresses`; anything else uses `restAddresses`. If the chosen pool is empty, the other one is used.
- Endpoints are chosen by weight (success rate and latency). Failed attempts retry (randomly, so an endpoint may repeat), and endpoints with an open circuit breaker are skipped.
- Only a 2xx response with a JSON body counts as success. GET requests, plus POST bodies containing `block`, `tx`, `validators`, or `status`, are cached; other requests go straight to the upstream.
- There is no authentication and it binds all interfaces; put it behind a trusted network or reverse proxy before exposing it.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info |
| GET | `/health` | Health (503 when degraded), cache stats, scheduler tasks, memory |
| GET | `/stats` | Per-chain, per-route endpoint stats |
| GET | `/stats/:chain` | Stats for one chain |
| GET | `/api/chain-list` | Chain names |
| GET | `/api/chains-summary` | Chains with RPC/REST endpoint counts |
| GET | `/api/rpc-list/:chain` | Full RPC and REST endpoint lists |
| GET | `/api/ibc-links?source=&destination=` | IBC channel links between two chains (name or chain ID) |
| POST | `/api/update-chain/:chain` | Crawl and update one chain (blocking) |
| POST | `/api/update-all-chains` | Crawl and update every chain (blocking) |
| POST | `/api/add-chain` | Add a chain (requires `chainName`, `chainId`, `bech32Prefix`, and `rpcAddresses` or `restAddresses`; 409 if it exists) |
| DELETE | `/api/remove-chain/:chain` | Remove a chain |
| POST | `/api/cleanup-blacklist` | Prune old blacklisted IPs |
| GET/PUT | `/config/global` | Global strategy, timeout, retry, and cache defaults |
| GET/PUT | `/config/chain/:chain` | Per-chain config overrides |
| DELETE | `/cache/:chain/:path?` | Flush cached responses for a chain/path |

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `REQUEST_TIMEOUT` | `12000` | Fallback proxy timeout in ms (`global.json` `defaultTimeoutMs`, default `5000`, takes precedence) |
| `CRAWLER_TIMEOUT` | `3000` | Per-request crawl timeout in ms |
| `CRAWLER_RETRIES` | `3` | Crawl request retries |
| `CRAWLER_RETRY_DELAY` | `1000` | Base retry delay in ms, capped at `1000` |
| `CRAWLER_MAX_DEPTH` | `3` | Peer-crawl depth |
| `CRAWLER_EXPANDED_PORTS` | `40` | RPC ports swept per live host during the expanded sweep; `0` disables |
| `CRAWLER_DARK_THRESHOLD` | `3` | Expanded sweep: consecutive timeouts before a host is dropped |
| `NODE_ENV` | unset | `production` disables config hot reload and hides error details |
| `LOG_LEVEL` / `LOG_LEVEL_APP` / `LOG_LEVEL_CRAWLER` / `LOG_LEVEL_BALANCER` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

PEX settings are listed under [Peer discovery](#peer-discovery). Runtime config lives in `config/global.json` and `config/chains/<chain>.json`; edits are hot-reloaded outside production.

## Peer discovery

Beyond `/net_info`'s direct peers, the crawler derives CometBFT P2P seeds from the chain registry and gossips additional peers over PEX, then probes them through the same RPC/REST scan. Discovery is breadth-first, best-effort, and bounded; it can be tuned or disabled:

```bash
PEX_ENABLED=true             # default; set false to skip
PEX_TIMEOUT=45               # seconds, default 45
PEX_MAX_QUERIES=3            # PexRequests per peer
PEX_MAX_DIALS=256            # total dial budget per crawl
PEX_DIAL_ATTEMPTS=2          # dial retries per peer
PEX_CONCURRENCY=16           # parallel dials
```

RPC hosts that stay dark on the common ports get digit substitutions and permutations of `26657` (e.g. `26607`, `36657`, `25667`), closest-first, after a TCP liveness check, clipped to `CRAWLER_EXPANDED_PORTS`.

## Development

```bash
bun run dev       # watch mode
bun test          # tests
bun run lint      # Biome check
bun run format    # Biome format
bun run build     # bundle to dist/
```

## Project layout

- `src/`: application code
- `config/`: `global.json` (tracked) and per-chain runtime config
- `data/`: generated chain data and metadata; git-ignored
- `logs/`: per-module daily logs; git-ignored
- `tests/`: tests run with `bun test`

## Contributing

Contributions are welcome. Issues and pull requests are much appreciated.

## License

This project is licensed under the MIT License.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
