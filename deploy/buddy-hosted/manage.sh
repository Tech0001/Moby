#!/bin/bash
set -e

# Moby buddy-hosted management script
# Usage:
#   ./manage.sh create <username>   - Create a new user instance
#   ./manage.sh delete <username>   - Delete a user instance
#   ./manage.sh list                - List all user instances
#   ./manage.sh logs <username>     - View logs for a user
#   ./manage.sh restart <username>  - Restart a user instance
#   ./manage.sh infra-up            - Start the infrastructure (Caddy)
#   ./manage.sh infra-down          - Stop the infrastructure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERS_DIR="$SCRIPT_DIR/users"
TEMPLATE="$SCRIPT_DIR/docker-compose.template.yml"

# Load environment
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
fi

# Validate required env vars
check_env() {
    if [ -z "$DOMAIN" ]; then
        echo "Error: DOMAIN not set. Create .env file with DOMAIN=yourdomain.com"
        exit 1
    fi
}

# Ensure users directory exists
mkdir -p "$USERS_DIR"

case "$1" in
    create)
        check_env
        USERNAME="$2"
        if [ -z "$USERNAME" ]; then
            echo "Usage: $0 create <username>"
            exit 1
        fi

        # Validate username (alphanumeric and hyphens only)
        if ! [[ "$USERNAME" =~ ^[a-z0-9-]+$ ]]; then
            echo "Error: Username must be lowercase alphanumeric with hyphens only"
            exit 1
        fi

        USER_FILE="$USERS_DIR/$USERNAME.yml"

        if [ -f "$USER_FILE" ]; then
            echo "Error: User $USERNAME already exists"
            exit 1
        fi

        echo "Creating instance for $USERNAME..."
        sed "s/BUDDY_NAME/$USERNAME/g" "$TEMPLATE" > "$USER_FILE"

        # Build image if needed
        docker compose -f "$USER_FILE" build

        # Start the container
        docker compose -f "$USER_FILE" up -d

        echo "Done! Instance available at https://$USERNAME.$DOMAIN"
        echo "User will need to complete setup at first login."
        ;;

    delete)
        USERNAME="$2"
        if [ -z "$USERNAME" ]; then
            echo "Usage: $0 delete <username>"
            exit 1
        fi

        USER_FILE="$USERS_DIR/$USERNAME.yml"

        if [ ! -f "$USER_FILE" ]; then
            echo "Error: User $USERNAME not found"
            exit 1
        fi

        echo "Stopping and removing instance for $USERNAME..."
        docker compose -f "$USER_FILE" down -v
        rm "$USER_FILE"

        echo "Done! Instance for $USERNAME has been removed."
        ;;

    list)
        echo "Active user instances:"
        echo "----------------------"
        for f in "$USERS_DIR"/*.yml 2>/dev/null; do
            if [ -f "$f" ]; then
                username=$(basename "$f" .yml)
                status=$(docker ps --filter "name=moby-$username" --format "{{.Status}}" 2>/dev/null || echo "unknown")
                if [ -z "$status" ]; then
                    status="stopped"
                fi
                printf "  %-20s %s\n" "$username" "$status"
            fi
        done

        if [ ! "$(ls -A "$USERS_DIR" 2>/dev/null)" ]; then
            echo "  (no instances)"
        fi
        ;;

    logs)
        USERNAME="$2"
        if [ -z "$USERNAME" ]; then
            echo "Usage: $0 logs <username>"
            exit 1
        fi

        USER_FILE="$USERS_DIR/$USERNAME.yml"

        if [ ! -f "$USER_FILE" ]; then
            echo "Error: User $USERNAME not found"
            exit 1
        fi

        docker compose -f "$USER_FILE" logs -f
        ;;

    restart)
        USERNAME="$2"
        if [ -z "$USERNAME" ]; then
            echo "Usage: $0 restart <username>"
            exit 1
        fi

        USER_FILE="$USERS_DIR/$USERNAME.yml"

        if [ ! -f "$USER_FILE" ]; then
            echo "Error: User $USERNAME not found"
            exit 1
        fi

        docker compose -f "$USER_FILE" restart
        echo "Restarted instance for $USERNAME"
        ;;

    infra-up)
        check_env
        echo "Starting infrastructure..."
        docker compose -f "$SCRIPT_DIR/docker-compose.infra.yml" up -d
        echo "Caddy reverse proxy is running"
        echo "Listening on ports 80 and 443"
        ;;

    infra-down)
        echo "Stopping infrastructure..."
        docker compose -f "$SCRIPT_DIR/docker-compose.infra.yml" down
        echo "Infrastructure stopped"
        ;;

    *)
        echo "Moby Buddy-Hosted Management"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  create <username>   Create a new user instance"
        echo "  delete <username>   Delete a user instance (with data!)"
        echo "  list                List all user instances"
        echo "  logs <username>     View logs for a user"
        echo "  restart <username>  Restart a user instance"
        echo "  infra-up            Start Caddy reverse proxy"
        echo "  infra-down          Stop Caddy reverse proxy"
        echo ""
        echo "Environment:"
        echo "  Create .env file with:"
        echo "    DOMAIN=moby.yourdomain.com"
        echo "    ACME_EMAIL=you@email.com"
        ;;
esac
