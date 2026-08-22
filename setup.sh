#!/usr/bin/env bash
# setup.sh — Bootstrap vector-practice
#
# Installs podman, starts containers (PostgreSQL/pgvector + Apache Tika),
# creates docs/ and .env, runs npm install, checks model servers, and
# optionally launches the app.
#
# Usage:  bash setup.sh
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

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Vector Practice — Setup & Health Check"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1a. Check / install podman ─────────────────────────────────────────────
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
        fail "No supported package manager found."
        echo "  See: https://podman.io/docs/installation"
        echo ""
        read -rp "Press Enter to exit…"
        exit 1
    fi
    ok "podman installed"
fi

# Podman machine (macOS / Windows only — no-op on Linux)
if podman machine list 2>/dev/null | grep -q '^[^ ]\+\s'; then
    MACHINE_RUNNING=$(podman machine list --format '{{.Running}}' 2>/dev/null || echo "false")
    if [ "$MACHINE_RUNNING" != "true" ]; then
        info "Starting podman machine…"
        podman machine start 2>/dev/null || podman machine init 2>/dev/null || true
    fi
    ok "podman machine is running"
fi

# ── 1b. Check Node.js ──────────────────────────────────────────────────────
info "Checking Node.js…"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
        ok "Node.js $(node --version) (>=18)"
    else
        fail "Node.js $(node --version) is too old. Need >=18."
        echo "  Install via: https://nodejs.org/"
        read -rp "Press Enter to exit…"
        exit 1
    fi
else
    fail "Node.js not found. Please install Node.js >=18."
    echo "  Install via: https://nodejs.org/"
    read -rp "Press Enter to exit…"
    exit 1
fi

# ── 2. Start containers (never recreate) ────────────────────────────────────
echo ""
info "Checking containers…"

# ── PostgreSQL (pgvector) ──────────────────────────────────────────────────
PG_NAME="postgres"
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

# Enable pgvector extension (the pgvector/pgvector image ships with it built-in)
info "Installing pgvector extension…"
podman exec "$PG_NAME" psql -U postgres -d vectordb -c \
    "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || {
    fail "Failed to install pgvector extension"
    ALL_OK=false
}

# Verify the extension actually registered
EXT_CHECK=$(podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc \
    "SELECT 1 FROM pg_extension WHERE extname='vector' LIMIT 1;" 2>/dev/null || echo "0")
if [ "$EXT_CHECK" = "1" ]; then
    ok "pgvector extension is installed"
    
    # Verify VECTOR type works with the correct dimension (768)
    DIM_CHECK=$(podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc \
        "SELECT typtype FROM pg_type WHERE typname='vector';" 2>/dev/null || echo "")
    if [ -n "$DIM_CHECK" ]; then
        ok "VECTOR(768) data type is available"
    else
        warn "VECTOR type not found — app.js will create it on startup if needed"
    fi
else
    fail "pgvector extension is NOT installed — check container logs: podman logs $PG_NAME"
    ALL_OK=false
fi

# Check the documents table exists with the correct VECTOR(768) dimension
# (app.js creates this on first start, but verify it for early feedback)
TABLE_CHECK=$(podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_name='documents' LIMIT 1;" 2>/dev/null || echo "0")
if [ "$TABLE_CHECK" = "1" ]; then
    # Verify the embedding column uses VECTOR(768)
    COL_CHECK=$(podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc \
        "SELECT data_type || '(' || COALESCE(domain_name::text, '768') || ')' FROM information_schema.columns WHERE table_name='documents' AND column_name='embedding';" 2>/dev/null || echo "")
    if echo "$COL_CHECK" | grep -qi 'vector'; then
        ok "documents table exists with VECTOR(768) column"
    else
        info "documents table exists but dimension not verified (app.js will handle it)"
    fi
else
    info "documents table not yet created — app.js creates it automatically on first start"
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
        # fallback: just check TCP connectivity (bash-specific)
        if (echo > /dev/tcp/"${host}"/"${port}") 2>/dev/null; then
            ok "${name} — port ${port} is OPEN (TCP)"
        else
            fail "${name} — port ${port} is NOT responding"
            ALL_OK=false
        fi
    fi
}

health_check "PostgreSQL (pgvector)" 127.0.0.1 "$PG_PORT" 5
health_check "Apache Tika"          127.0.0.1 "$TIKA_PORT" 5

# ── 4. Create docs/ and .env ──────────────────────────────────────────────
echo ""
info "Creating project directories…"
mkdir -p docs
ok "docs/ directory ready"

if [ ! -f .env ]; then
    info "Creating .env file with defaults…"
    cat > .env << 'EOF'
# Vector Practice — Environment Configuration
# Copy this to .env and adjust as needed.

# PostgreSQL (pgvector)
DB_HOST=127.0.0.1
DB_PORT=5434
DB_NAME=vectordb
DB_USER=postgres
DB_PASSWORD=postgres

# Apache Tika
TIKA_URL=http://127.0.0.1:9998
TIKA_OCR_LANG=eng

# Embedding / Reranker / Answer (llama.cpp servers)
EMBED_MAX_TOKENS=512
CHUNK_MAX_TOKENS=400

# Docs folder (where uploaded files are stored)
DOCS_FOLDER=./docs
EOF
    ok ".env file created (edit if needed)"
else
    ok ".env file already exists"
fi

# ── 5. npm install ────────────────────────────────────────────────────────
echo ""
info "Running npm install…"
if [ -f package.json ]; then
    npm install 2>&1 | tail -5
    ok "npm install completed"
else
    fail "package.json not found — skipping npm install"
    ALL_OK=false
fi

# ── 6. Check model servers (ports 8081-8083) ──────────────────────────────
echo ""
info "Checking model servers (llama.cpp)…"
echo "  These must be started separately — see below for commands."

health_check "EmbeddingGemma (8081)" 127.0.0.1 8081 3
health_check "Ettin Reranker (8082)" 127.0.0.1 8082 3
health_check "Qwen3.5 4B (8083)"    127.0.0.1 8083 3

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$ALL_OK" = true ]; then
    echo -e "  ${GREEN}[✓] ALL CHECKS PASSED — everything is up and running!${NC}"
else
    echo -e "  ${RED}[✗] SOME CHECKS FAILED — review the output above${NC}"
    echo ""
    echo "  Non-critical failures (model servers) are expected if you haven't"
    echo "  started llama.cpp yet. The app will still start, but search/answer"
    echo "  won't work until the models are running."
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
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │  Start llama.cpp servers (in separate terminals):           │"
echo "  │                                                             │"
echo "  │  Embedding:                                                 │"
echo "  │    ./llama-server -m models/embedding.gguf -c 8192          │"
echo "  │               -ub 512 --port 8081 --embedding               │"
echo "  │                                                             │"
echo "  │  Reranker:                                                  │"
echo "  │    ./llama-server -m models/reranker.gguf --port 8082       │"
echo "  │               --reranking -c 8192                           │"
echo "  │                                                             │"
echo "  │  Answer:                                                    │"
echo "  │    ./llama-server -m models/qwen.gguf --port 8083 -c 32768  │"
echo "  │                                                             │"
echo "  └─────────────────────────────────────────────────────────────┘"
echo ""

# ── 7. Launch the app ─────────────────────────────────────────────────────
read -rp "Start the app now? [Y/n] " START_APP
if [[ "$START_APP" =~ ^[Yy]?$ ]]; then
    info "Starting: node app.js"
    echo ""
    node app.js
else
    info "To start manually:  node app.js"
    echo ""
    read -rp "Press Enter to close…"
fi
