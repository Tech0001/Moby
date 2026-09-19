#!/bin/bash
set -e

# Moby buddy-hosted management script (Nginx version)
# Usage:
#   ./manage.sh create <name>     - Create a new instance (e.g., moby1)
#   ./manage.sh delete <name>     - Delete an instance and its data
#   ./manage.sh list              - List all instances with status
#   ./manage.sh logs <name>       - View logs for an instance
#   ./manage.sh restart <name>    - Restart an instance
#   ./manage.sh stop <name>       - Stop an instance
#   ./manage.sh start <name>      - Start an instance
#   ./manage.sh ssl <name>        - Get/renew SSL cert for an instance

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
NGINX_TEMPLATE="$SCRIPT_DIR/nginx/moby.conf.template"
NGINX_SITES="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"

# Port range for moby instances (3010-3099)
BASE_PORT=3010

# Load environment
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Validate required env vars
check_env() {
    if [ -z "$DOMAIN" ]; then
        log_error "DOMAIN not set. Create .env file with DOMAIN=freedombridge.xyz"
        exit 1
    fi
}

# Validate name (lowercase alphanumeric and hyphens)
validate_name() {
    if ! [[ "$1" =~ ^[a-z0-9-]+$ ]]; then
        log_error "Name must be lowercase alphanumeric with hyphens only"
        exit 1
    fi
}

# Check if instance exists in docker-compose.yml
instance_exists() {
    grep -q "moby-$1:" "$COMPOSE_FILE" 2>/dev/null
}

# Find next available port
find_next_port() {
    local port=$BASE_PORT
    while grep -q "\"$port:3000\"" "$COMPOSE_FILE" 2>/dev/null; do
        ((port++))
    done
    echo $port
}

# Get port for existing instance
get_instance_port() {
    grep -A5 "moby-$1:" "$COMPOSE_FILE" | grep -oP '"\K\d+(?=:3000")' | head -1
}

# Create new instance
cmd_create() {
    local NAME="$1"
    check_env
    validate_name "$NAME"

    if instance_exists "$NAME"; then
        log_error "Instance '$NAME' already exists"
        exit 1
    fi

    local PORT=$(find_next_port)
    log_info "Creating instance '$NAME' on port $PORT..."

    # Add service to docker-compose.yml using awk (portable)
    local TEMP_FILE=$(mktemp)
    awk -v name="$NAME" -v port="$PORT" '
    /^volumes:/ {
        print "  moby-" name ":"
        print "    build: ../.."
        print "    container_name: moby-" name
        print "    restart: unless-stopped"
        print "    ports:"
        print "      - \"" port ":3000\""
        print "    volumes:"
        print "      - moby-" name "-data:/app/data"
        print "    environment:"
        print "      - NODE_ENV=production"
        print "      - LOG_LEVEL=info"
        print "    healthcheck:"
        print "      test: [\"CMD\", \"wget\", \"-qO-\", \"http://localhost:3000/api/setup/status\"]"
        print "      interval: 30s"
        print "      timeout: 10s"
        print "      retries: 3"
        print "      start_period: 10s"
        print ""
        print "volumes:"
        print "  moby-" name "-data:"
        next
    }
    { print }
    ' "$COMPOSE_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$COMPOSE_FILE"

    log_info "Building and starting container..."
    cd "$SCRIPT_DIR"
    docker compose build "moby-$NAME"
    docker compose up -d "moby-$NAME"

    # Create nginx config
    log_info "Creating Nginx config..."
    sed -e "s/MOBY_NAME/$NAME/g" \
        -e "s/DOMAIN/$DOMAIN/g" \
        -e "s/MOBY_PORT/$PORT/g" \
        "$NGINX_TEMPLATE" > "$NGINX_SITES/moby-$NAME.conf"

    # Enable site
    ln -sf "$NGINX_SITES/moby-$NAME.conf" "$NGINX_ENABLED/moby-$NAME.conf"

    # Test and reload nginx
    nginx -t && systemctl reload nginx

    log_info "Instance created! HTTP available at: http://$NAME.$DOMAIN"
    log_warn "Run './manage.sh ssl $NAME' to enable HTTPS"
}

# Get SSL certificate
cmd_ssl() {
    local NAME="$1"
    check_env
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    log_info "Obtaining SSL certificate for $NAME.$DOMAIN..."

    if [ -z "$ACME_EMAIL" ]; then
        log_warn "ACME_EMAIL not set, using --register-unsafely-without-email"
        certbot --nginx -d "$NAME.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    else
        certbot --nginx -d "$NAME.$DOMAIN" --non-interactive --agree-tos -m "$ACME_EMAIL"
    fi

    log_info "SSL enabled! HTTPS available at: https://$NAME.$DOMAIN"
}

# Delete instance
cmd_delete() {
    local NAME="$1"
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    log_warn "This will delete the container, data, and nginx config for '$NAME'"
    read -p "Are you sure? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cancelled"
        exit 0
    fi

    log_info "Stopping and removing container..."
    cd "$SCRIPT_DIR"
    docker compose stop "moby-$NAME" 2>/dev/null || true
    docker compose rm -f "moby-$NAME" 2>/dev/null || true

    # Remove volume
    docker volume rm "buddy-hosted_moby-$NAME-data" 2>/dev/null || true

    # Remove from docker-compose.yml (service block and volume)
    # This is a bit tricky with sed, so we use a temp file approach
    local TEMP_FILE=$(mktemp)
    awk -v name="moby-$NAME" '
        BEGIN { skip=0; in_volumes=0 }
        /^  moby-'"$NAME"':/ { skip=1; next }
        /^  [a-z]/ && skip { skip=0 }
        /^volumes:/ { in_volumes=1 }
        in_volumes && /^  moby-'"$NAME"'-data:/ { next }
        !skip { print }
    ' "$COMPOSE_FILE" > "$TEMP_FILE"
    mv "$TEMP_FILE" "$COMPOSE_FILE"

    # Remove nginx config
    rm -f "$NGINX_SITES/moby-$NAME.conf"
    rm -f "$NGINX_ENABLED/moby-$NAME.conf"
    nginx -t && systemctl reload nginx 2>/dev/null || true

    log_info "Instance '$NAME' deleted"
}

# List instances
cmd_list() {
    echo "Moby instances:"
    echo "---------------"

    local found=0
    while IFS= read -r line; do
        if [[ "$line" =~ ^[[:space:]]+moby-([a-z0-9-]+): ]]; then
            local name="${BASH_REMATCH[1]}"
            local port=$(get_instance_port "$name")
            local status=$(docker ps --filter "name=moby-$name" --format "{{.Status}}" 2>/dev/null)
            [ -z "$status" ] && status="stopped"

            local ssl="HTTP"
            [ -f "/etc/letsencrypt/live/$name.$DOMAIN/fullchain.pem" ] && ssl="HTTPS"

            printf "  %-15s %-8s %-25s %s\n" "$name" ":$port" "$status" "$ssl"
            found=1
        fi
    done < "$COMPOSE_FILE"

    if [ $found -eq 0 ]; then
        echo "  (no instances)"
    fi
}

# View logs
cmd_logs() {
    local NAME="$1"
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    cd "$SCRIPT_DIR"
    docker compose logs -f "moby-$NAME"
}

# Restart instance
cmd_restart() {
    local NAME="$1"
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    cd "$SCRIPT_DIR"
    docker compose restart "moby-$NAME"
    log_info "Restarted '$NAME'"
}

# Stop instance
cmd_stop() {
    local NAME="$1"
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    cd "$SCRIPT_DIR"
    docker compose stop "moby-$NAME"
    log_info "Stopped '$NAME'"
}

# Start instance
cmd_start() {
    local NAME="$1"
    validate_name "$NAME"

    if ! instance_exists "$NAME"; then
        log_error "Instance '$NAME' does not exist"
        exit 1
    fi

    cd "$SCRIPT_DIR"
    docker compose start "moby-$NAME"
    log_info "Started '$NAME'"
}

# Main command dispatch
case "$1" in
    create)
        cmd_create "$2"
        ;;
    delete)
        cmd_delete "$2"
        ;;
    list)
        cmd_list
        ;;
    logs)
        cmd_logs "$2"
        ;;
    restart)
        cmd_restart "$2"
        ;;
    stop)
        cmd_stop "$2"
        ;;
    start)
        cmd_start "$2"
        ;;
    ssl)
        cmd_ssl "$2"
        ;;
    *)
        echo "Moby Buddy-Hosted Management (Nginx)"
        echo ""
        echo "Usage: $0 <command> [name]"
        echo ""
        echo "Commands:"
        echo "  create <name>   Create new instance (e.g., moby1, moby2)"
        echo "  delete <name>   Delete instance and all data"
        echo "  list            List all instances with status"
        echo "  logs <name>     View container logs"
        echo "  restart <name>  Restart an instance"
        echo "  stop <name>     Stop an instance"
        echo "  start <name>    Start an instance"
        echo "  ssl <name>      Get SSL certificate via certbot"
        echo ""
        echo "Environment (.env):"
        echo "  DOMAIN=freedombridge.xyz"
        echo "  ACME_EMAIL=you@email.com (optional)"
        ;;
esac
