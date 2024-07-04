# Load Balancer for Cosmos SDK RPC Endpoints

This project was inspired largely by Jacob Gadikian of [Notional](https://notional.ventures/)'s [RPC crawler](https://github.com/notional-labs) logic, and the [cosmos.directory](https://cosmos.directory) Load balanced proxy endpoint created by [Eco-stake](https://ecologi.com/ecostake), and by the desperate need of actually somewhat useful infrastructure on almost every existing IBC network. I give huge respect to the ones that offer reasonable access (you know who you are).

This is intended for personal use only, and is intended to reduce the overall load on the most commonly used infrastructure. It is a personal load balancer for many IBC networks' API endpoints using Node.js and Caddy. It dynamically fetches and caches RPC endpoint data for different chains and can be easily configured to do the same for REST or other API endpoints.

## Prerequisites

- Node.js
- Caddy

## Setup

1. Clone the repository:

```bash
git clone https://github.com/yourusername/load-balancer.git
cd load-balancer
```

2. Install the Node.js dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

4. Create a `.env` file with your GitHub personal access token (GITHUB_PAT):

```bash
echo "GITHUB_PAT=your_github_personal_access_token" > .env
```

5. Start the Node.js server:

```bash
yarn start
```

6. Configure Caddy

### Creating a `Caddyfile`

If this is your first time using Caddy, you'll have to create a `Caddyfile` (webserver config file) like the following example:

```shell
{
  servers {
    listener_wrappers {
      proxy_protocol {
        timeout 2s
        allow 127.0.0.1/24
      }
    }
    automatic_https {
      disable_redirects
    }
  }
}

http://rpc-lb.*.example.com {
  reverse_proxy http://localhost:3000
}
```

*Replace example.com with your domain.*

### Adding Load Balancer Configuration to an Existing Caddyfile

If you already have a Caddyfile and want to add the load balancer configuration, follow these steps:

- Create a new file called `lb.caddyfile`:

```shell
http://lb.example.com {
  reverse_proxy /rpc-lb/*/* http://localhost:3000
  reverse_proxy /add-chain http://localhost:3000
  reverse_proxy /update-chain-data http://localhost:3000
  reverse_proxy /update-endpoint-data http://localhost:3000
  reverse_proxy /speed-test/* http://localhost:3000
}
```

- In the existing `Caddyfile`, add the following line to import the new config:

```shell
import /path/to/lb.caddyfile
```

Your Caddyfile should look something like this:

```shell
# Your existing Caddy configuration
{
  email you@example.com
  acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}

example.com {
  root * /var/www/html
  file_server
}

# Import the load balancer configuration
import /etc/caddy/lb.caddyfile
```

*Replace /path/to with the actual path to the lb.caddyfile.*

7. Reload Caddy to apply the new configuration:

```bash
caddy reload --config /path/to/your/Caddyfile
```

8. Run Caddy:

```bash
caddy run --config /path/to/Caddyfile
```

## Usage

### You can now access the load balancer by making a request to your Caddy server. Here are some example commands to run the various functions:

`/update-all-chains`
This endpoint updates the data for all chains.

**Request**:

```bash
curl -X POST http://localhost:3000/update-all-chains
```

**Response**:

 - A message indicating that all chain data has been updated.

`/<chain>/update-chain`
This endpoint updates the data for a specific chain.

**Request**:

```bash
curl -X POST http://localhost:3000/<chain>/update-chain
Replace <chain> with the name of the chain you want to update.
```

**Response**:

 - A message indicating that the specified chain data has been updated.


`/crawl-all-chains`
This endpoint starts the network crawl for all chains.

**Request**:

```bash
curl -X POST http://localhost:3000/crawl-all-chains
```

**Response**:

 - A message indicating that the network crawl has started for all chains.


`/<chain>/crawl-chain`
This endpoint starts the network crawl for a specific chain.

**Request**:

```bash
curl -X POST http://localhost:3000/<chain>/crawl-chain
```


Replace `<chain>` with the name of the chain you want to crawl.

**Response**:

A message indicating that the network crawl has started for the specified chain.
Example Usage
Update All Chains:

```bash
curl -X POST http://localhost:3000/update-all-chains
```

Update a Specific Chain:

```bash
curl -X POST http://localhost:3000/akash/update-chain
```

Crawl All Chains:

```bash
curl -X POST http://localhost:3000/crawl-all-chains
```

Crawl a Specific Chain:

```bash
curl -X POST http://localhost:3000/akash/crawl-chain
```

```bash
curl http://localhost:3000/speed-test/akash
```

### Load Balancing RPC Requests

To send a load-balanced RPC request, send a GET request to the `/rpc-lb/<chainName>/<endpoint>` endpoint:

```bash
curl http://localhost:3000/akash/status
```

## Logging

Logs are stored in the `./logs` directory. Each module (balancer, crawler, fetchChains) has its own log file. You can check these logs for detailed information about the application's operations.

## Directory Structure

- `src/`: Contains the source code for the application.
  - `balancer.ts`: The main server code for the load balancer.
  - `crawler.ts`: Contains the logic for crawling and validating RPC endpoints.
  - `fetchChains.ts`: Contains the logic for fetching chain data from GitHub.
  - `utils.ts`: Contains utility functions for file operations and logging.
  - `types.ts`: Contains TypeScript type definitions.
- `data/`: Contains the JSON files for chain data and rejected IPs.
  - `chains.json`: Stores the chain data.
  - `rejected_ips.json`: Stores the list of rejected IPs.
  - `good_ips.json`: Stores the list of good IPs and their last crawled time.
- `logs/`: Contains the log files for different modules.

## Contributing

If you want to contribute to this project, feel free to submit issues and pull requests. Contributions are welcome!

## License

This project is licensed under the MIT License.