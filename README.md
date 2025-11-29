# Load Balancer for Cosmos SDK RPC Endpoints

Dynamically fetches, caches, and crawls RPC endpoints on all (or specified) chains, and acts as a round-robin load balancer using the generated list to provide a single reliable interface for general work or research involving multiple chains.

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
   bun build src/index.ts --outdir dist --target bun
   ```

5. Start the server:
   ```bash
   bun run src/index.ts
   ```

## Usage

### Chain Management

1. Update data for all chains from the registry:
   ```bash
   curl -X POST http://localhost:3000/api/update-all-chains
   ```

2. Update data for a specific chain:
   ```bash
   curl -X POST http://localhost:3000/api/update-chain/osmosis
   ```

3. Crawl all chains to discover new RPC endpoints:
   ```bash
   curl -X POST http://localhost:3000/api/crawl-all-chains
   ```

4. Crawl a specific chain:
   ```bash
   curl -X POST http://localhost:3000/api/crawl-chain/osmosis
   ```

### Chain Information

1. Get a list of all chains:
   ```bash
   curl http://localhost:3000/api/chain-list
   ```

2. Get a summary of all chains (name and number of endpoints):
   ```bash
   curl http://localhost:3000/api/chains-summary
   ```

3. Get endpoints for a specific chain:
   ```bash
   curl http://localhost:3000/api/rpc-list/osmosis
   ```

### Load Balancing RPC Requests

To send a load-balanced RPC request to any chain, use the following format:

```bash
curl -X [METHOD] http://localhost:3000/lb/[CHAIN]/[ENDPOINT]
```

For example, to get the status of the Osmosis chain:

```bash
curl http://localhost:3000/lb/osmosis/status
```

The load balancer will automatically select an available RPC endpoint for the specified chain and proxy the request.

## Logging

Logs are stored in the `./logs` directory, with separate files for each module (balancer, crawler, api).

## Directory Structure

- `src/`: Source code
  - `balancer.ts`: Main load balancing logic
  - `crawler.ts`: Network crawling and endpoint discovery
  - `api.ts`: Custom API endpoints for chain management
  - `fetchChains.ts`: Functions for fetching chain data from the registry
  - `utils.ts`: Utility functions
  - `types.ts`: TypeScript type definitions
  - `logger.ts`: Logging configuration
- `data/`: JSON files for chain data and IP lists
- `logs/`: Log files

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
