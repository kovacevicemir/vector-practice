#!/usr/bin/env bash
# setup.sh — Bootstrap vector-practice: install podman, start containers, verify services
set -euo pipefail

# ── helpers ────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # no color

ok()    { echo -e "  ${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "  ${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "  ${RED}[✗]${NC} $1"; }
info()  { echo -e "  [i] $1"; }

# ── 1. Check / install podman ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Vector Practice — Setup & Health Check"
echo "═══════════════════════════════════════════════════════"
echo ""

info "Checking podman…"
if command -v podman &>/dev/null; then
    ok "podman is installed ($(podman --version))"
else
    info "podman not found — installing…"
    if command -v dnf &>/dev/null; then
        sudo dnf install -y podman
    elif command -v apt-get &>/dev/null; then
        sudo apt-get update
        sudo apt-get install -y podman
    elif command -v yum &>/dev/null; then
        sudo yum install -y podman
    else
        fail "No supported package manager found. Please install podman manually."
        echo ""
        read -rp "Press Enter to exit…" 
        exit 1
    fi
    ok "podman installed"
fi

# ── 2. Start containers (never recreate) ───────────────────────────────────
echo ""
info "Checking containers…"

# ── PostgreSQL ─────────────────────────────────────────────────────────────
PG_NAME="postgres-vector"
PG_IMAGE="docker.io/pgvector/pgvector:pg18"
PG_PORT=5434

if podman ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    if podman ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
        ok "PostgreSQL container '$PG_NAME' is already running"
    else
        info "PostgreSQL container exists but is stopped — starting it…"
        podman start "$PG_NAME"
        ok "PostgreSQL container started"
    fi
else
    info "Creating PostgreSQL container…"
    podman run -d \
        --name "$PG_NAME" \
        -p "${PG_PORT}:5432" \
        -e POSTGRES_PASSWORD=postgres \
        -e POSTGRES_DB=vectordb \
        -v pgvector-data:/var/lib/postgresql/data \
        "$PG_IMAGE"
    ok "PostgreSQL container created and started"
fi

# Wait for PostgreSQL to be ready (max 30 s)
info "Waiting for PostgreSQL to be ready…"
for i in $(seq 1 30); do
    if podman exec "$PG_NAME" pg_isready -U postgres &>/dev/null; then
        ok "PostgreSQL is ready after ${i}s"
        break
    fi
    sleep 1
done

# Create tables if they don't exist
info "Ensuring 'documents' table exists…"
podman exec "$PG_NAME" psql -U postgres -d vectordb -c \
    "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true

TABLE_EXISTS=$(podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_name='documents' LIMIT 1;" 2>/dev/null || echo "0")

if [ "$TABLE_EXISTS" = "0" ]; then
    podman exec "$PG_NAME" psql -U postgres -d vectordb -c \
        "CREATE TABLE documents (
            id        BIGSERIAL PRIMARY KEY,
            title     TEXT,
            content   TEXT NOT NULL,
            metadata  JSONB,
            embedding VECTOR(768)
        );"
    ok "Created 'documents' table"
else
    ok "'documents' table already exists"
fi

# ── Apache Tika ────────────────────────────────────────────────────────────
TIKA_NAME="tika"
TIKA_IMAGE="docker.io/apache/tika:latest-full"
TIKA_PORT=9998

if podman ps -a --format '{{.Names}}' | grep -qx "$TIKA_NAME"; then
    if podman ps --format '{{.Names}}' | grep -qx "$TIKA_NAME"; then
        ok "Tika container '$TIKA_NAME' is already running"
    else
        info "Tika container exists but is stopped — starting it…"
        podman start "$TIKA_NAME"
        ok "Tika container started"
    fi
else
    info "Creating Tika container…"
    podman run -d \
        --name "$TIKA_NAME" \
        -p "${TIKA_PORT}:9998" \
        "$TIKA_IMAGE"
    ok "Tika container created and started"
fi

# ── 3. Health checks (ping ports) ─────────────────────────────────────────
echo ""
info "Running health checks…"
ALL_OK=true

health_check() {
    local name="$1" host="$2" port="$3" timeout="${4:-5}"
    if curl -sf --max-time "$timeout" "http://${host}:${port}/" >/dev/null 2>&1 \
        || curl -sf --max-time "$timeout" "http://${host}:${port}" >/dev/null 2>&1; then
        ok "${name} — port ${port} is UP"
    else
        # fallback: just check TCP connectivity
        if (echo > /dev/tcp/"${host}"/"${port}") 2>/dev/null; then
            ok "${name} — port ${port} is OPEN (TCP)"
        else
            fail "${name} — port ${port} is NOT responding"
            ALL_OK=false
        fi
    fi
}

health_check "PostgreSQL" 127.0.0.1 "$PG_PORT" 5
health_check "Apache Tika" 127.0.0.1 "$TIKA_PORT" 5

# ── 4. npm install ────────────────────────────────────────────────────────
echo ""
info "Running npm install…"
if [ -f package.json ]; then
    npm install --prefer-offline 2>&1 | tail -5
    ok "npm install completed"
else
    fail "package.json not found — skipping npm install"
    ALL_OK=false
fi

# ── 5. Check model servers (ports 8081-8083) ──────────────────────────────
echo ""
info "Checking model servers…"

health_check "EmbeddingGemma (8081)" 127.0.0.1 8081 3
health_check "Reranker (8082)"      127.0.0.1 8082 3
health_check "Qwen3.5 4B (8083)"    127.0.0.1 8083 3

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$ALL_OK" = true ]; then
    echo -e "  ${GREEN}[✓] ALL CHECKS PASSED — everything is up and running!${NC}"
else
    echo -e "  ${RED}[✗] SOME CHECKS FAILED — review the output above${NC}"
fi
echo "═══════════════════════════════════════════════════════"
echo ""
info "Ports summary:"
echo "  PostgreSQL (pgvector) : 127.0.0.1:${PG_PORT}"
echo "  Apache Tika           : 127.0.0.1:${TIKA_PORT}"
echo "  EmbeddingGemma        : 127.0.0.1:8081"
echo "  Ettin Reranker        : 127.0.0.1:8082"
echo "  Qwen3.5 4B            : 127.0.0.1:8083"
echo ""
info "To start the app:  node app.js"
echo ""
read -rp "Press Enter to close…"
