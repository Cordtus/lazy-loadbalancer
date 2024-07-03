# Load Balancer for Cosmos SDK RPC Endpoints

Set up a load balancer for many IBC networks' API endpoints using Node.js and Caddy. It dynamically fetches and caches RPC endpoint data for different chains and can be easily configured to do the same for REST or other API endpoints.

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

4. Start the Node.js server:

```bash
yarn start
```

5. Configure Caddy

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

6. Reload Caddy to apply the new configuration:

```bash
caddy reload --config /path/to/your/Caddyfile
```

7. Run Caddy:

```bash
caddy run --config /path/to/Caddyfile
```

## Usage

You can now access the load balancer by making a request to your Caddy server. Here are some example commands to run the various functions:

### Adding a New Chain

To add

 a new chain, send a POST request to the `/add-chain` endpoint:

```bash
curl -X POST http://lb.example.com/add-chain -H "Content-Type: application/json" -d '{"chainName": "akash"}'
```

### Updating Chain Data

To update the data for a specific chain, send a POST request to the `/update-chain-data` endpoint:

```bash
curl -X POST http://lb.example.com/update-chain-data -H "Content-Type: application/json" -d '{"chainName": "akash"}'
```

### Updating Endpoint Data

To update the endpoint data for a specific chain, send a POST request to the `/update-endpoint-data` endpoint:

```bash
curl -X POST http://lb.example.com/update-endpoint-data -H "Content-Type: application/json" -d '{"chainName": "akash"}'
```

### Running a Speed Test

To run a speed test, send a GET request to the `/speed-test/<chainName>` endpoint:

```bash
curl http://lb.example.com/speed-test/akash
```

### Load Balancing RPC Requests

To send a load-balanced RPC request, send a GET request to the `/rpc-lb/<chainName>/<endpoint>` endpoint:

```bash
curl http://lb.example.com/rpc-lb/akash/status
```
