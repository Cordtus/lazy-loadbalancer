# Load Balancer for Cosmos SDK RPC Endpoints

Set up a load balancer for many IBC networks' API endpoints using Node.js and Caddy. It dynamically fetches and caches RPC endpoint data for different chains.
Can be easily configured to do the same for REST, or other API endpoints.

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
  yarn add express node-fetch && yarn install
```

3. Start the Node.js server:

```bash
  yarn start
```

4. Configure Caddy

 ### Creating a `Caddyfile` 
 
 If this is your fisrt time using Caddy, you'll have to create a `Caddyfile`[webserver config file] like the following example:

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

`  import /path/to/lb.caddyfile`

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
import /etc/caddy/load_balancer.caddyfile
```

*Replace /path/to with the actual path to the load_balancer.caddyfile.*

- Reload Caddy to apply the new configuration:

```shell
  addy reload --config /path/to/your/Caddyfile

```
5. Run Caddy.

```bash
  caddy run --config /path/to/Caddyfile
```


  ## Usage

You can now access the load balancer by making a request to your Caddy server. For example:

```bash
  curl -s http://rpc-lb.akash.example.com/status
```

This will return the JSON data for the akash chain and update the chains.json file if the data is stale or does not yet exist for this chain.
Caddy will now include the load balancer ontop of your existing config. This keeps your configs separate and easier to manage.