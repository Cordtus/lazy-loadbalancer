# Load Balancer for Cosmos SDK RPC Endpoints

This project implements a personal load balancer for IBC network API endpoints using Node.js. It dynamically fetches, caches, and crawls RPC endpoint data for different chains, providing a robust and efficient way to interact with multiple Cosmos SDK-based networks.

## Prerequisites

- Node.js (v14 or later)
- Yarn package manager

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/load-balancer.git
   cd load-balancer
   ```

2. Install dependencies:
   ```bash
   yarn install
   ```

3. Create a `.env` file with your GitHub personal access token:
   ```bash
   echo "GITHUB_PAT=your_github_personal_access_token" > .env
   ```

4. Build the project:
   ```bash
   yarn build
   ```

5. Start the Node.js server:
   ```bash
   yarn start
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
   curl http://localhost:3000/api/chain-endpoints/osmosis
   ```

4. Get total number of chains:
   ```bash
   curl http://localhost:3000/api/total-chains
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

Contributions are welcome. Please submit issues and pull requests on the project's GitHub repository.

## License

This project is licensed under the MIT License.