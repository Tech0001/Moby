# Buddy-Hosted Deployment (Nginx)

Run multiple isolated Moby instances on a single VPS with Nginx reverse proxy.

## Architecture

```
                         ┌──────────────┐
  moby1.domain.com ─────►│              │───► Container: moby-moby1 (:3010)
  moby2.domain.com ─────►│    Nginx     │───► Container: moby-moby2 (:3011)
  moby3.domain.com ─────►│              │───► Container: moby-moby3 (:3012)
                         └──────────────┘
                          SSL via certbot
```

## Prerequisites

- VPS with Docker and Docker Compose
- Nginx installed and running
- Certbot installed (`apt install certbot python3-certbot-nginx`)
- Domain with DNS A records pointing to your VPS

## DNS Setup (Cloudflare or other)

Add A records for each instance:

| Type | Name  | Content        | Proxy    |
|------|-------|----------------|----------|
| A    | moby1 | YOUR_VPS_IP    | DNS only |
| A    | moby2 | YOUR_VPS_IP    | DNS only |
| A    | moby3 | YOUR_VPS_IP    | DNS only |

## Quick Start

```bash
# 1. Clone the repo to your VPS
git clone <repo> ~/moby
cd ~/moby/deploy/buddy-hosted

# 2. Configure
cp .env.example .env
nano .env  # Set DOMAIN=freedombridge.xyz

# 3. Create instances
./manage.sh create moby1
./manage.sh create moby2
./manage.sh create moby3

# 4. Enable HTTPS for each
./manage.sh ssl moby1
./manage.sh ssl moby2
./manage.sh ssl moby3
```

Each user gets `https://moby1.freedombridge.xyz`, etc.

## Management Commands

```bash
./manage.sh create <name>   # Create new instance
./manage.sh delete <name>   # Remove instance and data
./manage.sh list            # Show all instances with status
./manage.sh logs <name>     # View container logs
./manage.sh restart <name>  # Restart an instance
./manage.sh stop <name>     # Stop an instance
./manage.sh start <name>    # Start an instance
./manage.sh ssl <name>      # Get/renew SSL certificate
```

## What Each User Gets

- Isolated Docker container
- Own SQLite database (persisted in Docker volume)
- Own subdomain with HTTPS
- First login creates their account
- They add their own Kraken API keys

## Port Allocation

Instances are assigned ports starting at 3010:
- moby1 → :3010
- moby2 → :3011
- moby3 → :3012
- etc.

## Resource Usage

| Instances | RAM (approx) | CPU |
|-----------|--------------|-----|
| 1         | 50-100 MB    | Minimal |
| 5         | 250-500 MB   | Minimal |
| 15        | 1-2 GB       | Low |

Moby is lightweight - it mostly sleeps between poll intervals.

## File Structure

```
deploy/buddy-hosted/
├── docker-compose.yml        # All moby services
├── manage.sh                 # Management script
├── .env                      # Your config (DOMAIN)
└── nginx/
    └── moby.conf.template    # Nginx server block template
```

## Backup

User data is stored in Docker volumes. To backup:

```bash
# Backup a specific user
docker run --rm \
  -v buddy-hosted_moby-moby1-data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/moby1-$(date +%Y%m%d).tar.gz -C /data .
```

## Troubleshooting

**Container not starting:**
```bash
./manage.sh logs moby1
docker ps -a | grep moby
```

**SSL not working:**
```bash
# Check certbot logs
cat /var/log/letsencrypt/letsencrypt.log

# Verify DNS resolves
dig moby1.freedombridge.xyz
```

**Nginx errors:**
```bash
nginx -t
systemctl status nginx
```
