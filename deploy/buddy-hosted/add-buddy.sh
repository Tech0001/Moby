#!/bin/bash

# Add a new buddy instance
# Usage: ./add-buddy.sh <buddy-name>
# Example: ./add-buddy.sh alice

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <buddy-name>"
  echo "Example: $0 alice"
  exit 1
fi

BUDDY_NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validate buddy name (lowercase alphanumeric + hyphens only)
if ! [[ "$BUDDY_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: Buddy name must be lowercase alphanumeric with hyphens only"
  exit 1
fi

# Create buddy directory
BUDDY_DIR="$SCRIPT_DIR/buddies/$BUDDY_NAME"
if [ -d "$BUDDY_DIR" ]; then
  echo "Error: Buddy '$BUDDY_NAME' already exists"
  exit 1
fi

mkdir -p "$BUDDY_DIR"

# Generate docker-compose for this buddy
sed "s/BUDDY_NAME/$BUDDY_NAME/g" "$SCRIPT_DIR/docker-compose.template.yml" > "$BUDDY_DIR/docker-compose.yml"

echo "Created buddy instance: $BUDDY_NAME"
echo "Directory: $BUDDY_DIR"
echo ""
echo "To start:"
echo "  cd $BUDDY_DIR"
echo "  docker compose up -d --build"
echo ""
echo "The instance will be available at: $BUDDY_NAME.\$DOMAIN"
