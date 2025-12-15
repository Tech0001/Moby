# Buddy-Hosted Deployment

Run multiple isolated Moby instances on a single server, each with its own subdomain.

## Architecture

```text
                         ┌──────────────┐
    alice.domain.com ───►│              │───► Container: moby-alice
      bob.domain.com ───►│    Caddy     │───► Container: moby-bob
  charlie.domain.com ───►│              │───► Container: moby-charlie
                         └──────────────┘
                          Single wildcard
                          SSL certificate
```

## Prerequisites

- Docker and Docker Compose
- A domain with wildcard DNS pointing to your server
- Port 80 and 443 open

## DNS Setup

Point a wildcard A record to your server:

```text
*.moby.yourdomain.com  →  YOUR_SERVER_IP
```

## SSL Certificates

**One wildcard certificate covers all users.** Caddy automatically obtains and renews a single `*.yourdomain.com` certificate from Let's Encrypt. No per-user SSL configuration needed.

## Quick Start

```bash
cd deploy/buddy-hosted

# 1. Configure your domain
cp .env.example .env
nano .env  # Set DOMAIN and ACME_EMAIL

# 2. Start the reverse proxy (one time)
./manage.sh infra-up

# 3. Create user instances
./manage.sh create alice
./manage.sh create bob
./manage.sh create charlie
```

Each user gets `https://<username>.<DOMAIN>` with automatic SSL.

## Management Commands

```bash
./manage.sh create <user>    # Create new instance
./manage.sh delete <user>    # Remove instance and data
./manage.sh list             # Show all instances with status
./manage.sh logs <user>      # View container logs
./manage.sh restart <user>   # Restart a user's instance
./manage.sh infra-up         # Start Caddy proxy
./manage.sh infra-down       # Stop Caddy proxy
```

## What Each User Gets

- Isolated Docker container
- Own SQLite database (persisted in Docker volume)
- Own subdomain with HTTPS
- First login creates their account
- They add their own Kraken API keys

## Resource Usage

| Instances | RAM (approx) | CPU |
|-----------|--------------|-----|
| 1         | 50-100 MB    | Minimal (idle most of time) |
| 15        | 1-2 GB       | Still minimal |
| 50        | 3-5 GB       | Low |

Moby is lightweight - it mostly sleeps between poll intervals.

## Directory Structure

```text
deploy/buddy-hosted/
├── docker-compose.infra.yml   # Caddy reverse proxy
├── docker-compose.template.yml # Template for user instances
├── manage.sh                  # Management script
├── .env                       # Your config (DOMAIN, ACME_EMAIL)
└── users/                     # Generated compose files per user
    ├── alice.yml
    ├── bob.yml
    └── ...
```

## Backup

User data is stored in Docker volumes named `moby-<username>-data`. To backup:

```bash
# Backup all user volumes
for user in users/*.yml; do
  name=$(basename "$user" .yml)
  docker run --rm -v moby-${name}-data:/data -v $(pwd)/backups:/backup \
    alpine tar czf /backup/${name}-$(date +%Y%m%d).tar.gz -C /data .
done
```

## Troubleshooting

**SSL not working:**

- Ensure wildcard DNS is configured correctly
- Check Caddy logs: `docker logs caddy`
- Let's Encrypt needs ports 80/443 open

**Container not starting:**

- Check logs: `./manage.sh logs <username>`
- Verify the image built: `docker images | grep moby`

**User can't access their instance:**

- Verify DNS resolves: `dig <username>.<domain>`
- Check container is running: `./manage.sh list`
