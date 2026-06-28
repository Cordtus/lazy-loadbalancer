# Load Balancer for Cosmos SDK RPC and REST Endpoints

Dynamically fetches, caches, and crawls Cosmos SDK RPC and REST endpoints on all supported chains. The service acts as a round-robin load balancer using the generated endpoint lists to provide one reliable interface for chain research, IBC tooling, and multi-chain API calls.

Inspired by the work of Jacob Gadikian and [Eco-stake](https://ecologi.com/ecostake), this tool combines [Notional](https://notional.ventures/)'s [RPC crawler](https://github.com/notional-labs) logic, and the [cosmos.directory](https://cosmos.directory) Load balanced proxy endpoint created by "Tom". 
It is intended as a personal load balancer / unified endpoint for multiple Cosmos-SDK / IBC chain API endpoints. 



## Prerequisites

- Bun (>=1.1.0)


## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/Cordtus/lazy-loadbalancer.git
   cd lazy-loadbalancer
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create a `.env` file with your GitHub personal access token:
   ```bash
   echo "GITHUB_PAT=your_github_personal_access_token" > .env
   ```

4. Build the project:
   ```bash
   bun run build
   ```

5. Start the server:
   ```bash
   bun run start
   ```

## Development Commands

```bash
bun run dev       # Start the Hono server with watch mode
bun test          # Run Bun tests with vitest-style test APIs
bun run lint      # Run Biome checks for src and tests
bun run format    # Format src and tests with Biome
bun run build     # Bundle src/index.ts for Bun
```

## Usage

### Chain Management

1. Fetch registry data and update all chains:
   ```bash
   curl -X POST http://localhost:3000/api/update-all-chains
   ```

2. Crawl and update a specific chain:
   ```bash
   curl -X POST http://localhost:3000/api/update-chain/osmosis
   ```

### Chain Information

1. Get a list of all chains:
   ```bash
   curl http://localhost:3000/api/chain-list
   ```

2. Get a summary of all chains with RPC and REST endpoint counts:
   ```bash
   curl http://localhost:3000/api/chains-summary
   ```

3. Resolve IBC channel links between two chains by chain name or chain ID:
   ```bash
   curl 'http://localhost:3000/api/ibc-links?source=genesis_29-2&destination=osmosis-1'
   ```

   The response is sorted with preferred live registry links first and includes
   source-side channel/port, counterparty channel/port, connection, client, and
   chain ID metadata.

4. Get endpoint lists for a specific chain:
   ```bash
   curl http://localhost:3000/api/rpc-list/osmosis
   ```

### Universal Load-Balancing Requests

To send a load-balanced RPC or REST request to any chain, use the following format:

```bash
curl -X [METHOD] http://localhost:3000/lb/[CHAIN]/[ENDPOINT]
```

For example, to get the status of the Osmosis chain:

```bash
curl http://localhost:3000/lb/osmosis/status
```

For a Cosmos SDK REST call, use the REST path directly:

```bash
curl http://localhost:3000/lb/cosmoshub/ibc/apps/transfer/v1/channels/channel-141/ports/transfer/escrow_address
```

The load balancer routes known Tendermint RPC method paths to `rpcAddresses` and Cosmos SDK REST paths such as `cosmos/...`, `ibc/...`, and `cosmwasm/...` to `restAddresses`.

## Logging

Logs are stored in the `./logs` directory, with separate files for each module (balancer, crawler, api).

## Directory Structure

- `src/`: Source code
  - `balancer.ts`: Main load balancing logic
  - `crawler.ts`: Network crawling and RPC/REST endpoint discovery
  - `index.ts`: Hono server, API routes, and load-balancer route
  - `dataService.ts`: Registry fetch and JSON persistence
  - `utils.ts`: Utility functions
  - `types.ts`: TypeScript type definitions
  - `logger.ts`: Logging configuration
- `data/`: JSON files for chain data and IP lists
- `logs/`: Log files
- `tests/`: Bun tests using vitest-style APIs

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
