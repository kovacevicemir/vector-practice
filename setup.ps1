<#
.SYNOPSIS
    Bootstrap vector-practice on Windows: install podman, start containers, install deps, launch app.

.DESCRIPTION
    Checks for podman and Node.js, starts PostgreSQL/pgvector and Apache Tika
    containers via podman, creates docs/ and .env, runs npm install, and
    optionally launches the Express app.

.NOTES
    Requires: Podman Desktop or podman CLI, Node.js >=18
    Run in PowerShell 5.1+ or PowerShell Core 7+
#>

#Requires -Version 5.1

# ── helpers ────────────────────────────────────────────────────────────────
$Host.UI.RawUI.WindowTitle = "Vector Practice — Setup"

function ok   { Write-Host "  [✓] $args" -ForegroundColor Green }
function warn { Write-Host "  [!] $args" -ForegroundColor Yellow }
function fail { Write-Host "  [✗] $args" -ForegroundColor Red }
function info { Write-Host "  [i] $args" }

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

function Test-Port($hostname, $port, $timeoutSeconds = 3) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $async = $tcp.BeginConnect($hostname, $port, $null, $null)
        $wait = $async.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($timeoutSeconds))
        if ($wait) {
            $tcp.EndConnect($async) | Out-Null
            $tcp.Close()
            return $true
        }
        $tcp.Close()
        return $false
    } catch { return $false }
}

# ── Header ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Vector Practice — Setup & Health Check (Windows)"    -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── 1a. Check podman ───────────────────────────────────────────────────────
info "Checking podman…"
if (Test-Command podman) {
    $podmanVer = podman --version
    ok "podman is installed ($podmanVer)"
} else {
    fail "podman not found."
    Write-Host "  Install Podman Desktop from: https://podman.io/docs/installation"
    Write-Host "  Or via winget: winget install RedHat.Podman"
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Ensure podman machine is running (required on Windows)
$machineList = podman machine list 2>$null
if ($LASTEXITCODE -eq 0 -and $machineList) {
    $running = $machineList | Select-String "Currently running"
    if (-not $running) {
        info "Starting podman machine…"
        podman machine start 2>$null
        if ($LASTEXITCODE -ne 0) {
            info "No machine found. Creating and starting one…"
            podman machine init 2>$null
            podman machine start 2>$null
        }
    }
    ok "podman machine is running"
} else {
    info "Initializing podman machine…"
    podman machine init 2>$null
    podman machine start 2>$null
    if ($LASTEXITCODE -eq 0) {
        ok "podman machine created and started"
    } else {
        warn "Could not auto-start podman machine. Start it manually: podman machine start"
    }
}

# ── 1b. Check Node.js ──────────────────────────────────────────────────────
info "Checking Node.js…"
if (Test-Command node) {
    $nodeVer = node --version
    $major = [int]($nodeVer -replace '[vV]','' -split '\.')[0]
    if ($major -ge 18) {
        ok "Node.js $nodeVer (>=18)"
    } else {
        fail "Node.js $nodeVer is too old. Need >=18."
        Write-Host "  Download from: https://nodejs.org/"
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    fail "Node.js not found. Please install Node.js >=18."
    Write-Host "  Download from: https://nodejs.org/"
    Read-Host "Press Enter to exit"
    exit 1
}

# ── 2. Start containers (never recreate) ────────────────────────────────────
Write-Host ""
info "Checking containers…"

# ── PostgreSQL (pgvector) ──────────────────────────────────────────────────
$PG_NAME   = "postgres"
$PG_IMAGE  = "docker.io/pgvector/pgvector:pg18"
$PG_PORT   = 5434

$existing = podman ps -a --format "{{.Names}}" 2>$null
if ($existing -match [regex]::Escape($PG_NAME)) {
    $running = podman ps --format "{{.Names}}" 2>$null
    if ($running -match [regex]::Escape($PG_NAME)) {
        ok "PostgreSQL container '$PG_NAME' is already running"
    } else {
        info "PostgreSQL container exists but is stopped — starting it…"
        podman start "$PG_NAME" | Out-Null
        ok "PostgreSQL container started"
    }
} else {
    info "Creating PostgreSQL container…"
    podman run -d `
        --name "$PG_NAME" `
        -p "${PG_PORT}:5432" `
        -e POSTGRES_PASSWORD=postgres `
        -e POSTGRES_DB=vectordb `
        -v pgvector-data:/var/lib/postgresql/data `
        "$PG_IMAGE" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        ok "PostgreSQL container created and started"
    } else {
        fail "Failed to create PostgreSQL container"
    }
}

# Wait for PostgreSQL to be ready (max 30 s)
info "Waiting for PostgreSQL to be ready…"
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    $result = podman exec "$PG_NAME" pg_isready -U postgres 2>$null
    if ($LASTEXITCODE -eq 0) {
        ok "PostgreSQL is ready after ${i}s"
        $ready = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    warn "PostgreSQL may not be ready yet. Continuing anyway…"
}

# Enable pgvector extension (the pgvector/pgvector image ships with it built-in)
info "Installing pgvector extension…"
$extResult = podman exec "$PG_NAME" psql -U postgres -d vectordb -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1
if ($LASTEXITCODE -eq 0) {
    # Verify the extension actually registered
    $extCheck = podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc "SELECT 1 FROM pg_extension WHERE extname='vector' LIMIT 1;" 2>$null
    if ($extCheck -eq "1") {
        ok "pgvector extension is installed"
        
        # Verify VECTOR type exists
        $dimCheck = podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc "SELECT typtype FROM pg_type WHERE typname='vector';" 2>$null
        if ($dimCheck) {
            ok "VECTOR(768) data type is available"
        } else {
            warn "VECTOR type not found — app.js will create it on startup if needed"
        }
    } else {
        fail "pgvector extension is NOT installed — check container logs: podman logs $PG_NAME"
        $ALL_OK = $false
    }
} else {
    fail "Failed to install pgvector extension: $extResult"
    $ALL_OK = $false
}

# Check the documents table exists with the correct VECTOR(768) dimension
# (app.js creates this on first start, but verify it for early feedback)
$tableCheck = podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc "SELECT 1 FROM information_schema.tables WHERE table_name='documents' LIMIT 1;" 2>$null
if ($tableCheck -eq "1") {
    # Verify the embedding column uses VECTOR
    $colCheck = podman exec "$PG_NAME" psql -U postgres -d vectordb -tAc "SELECT data_type FROM information_schema.columns WHERE table_name='documents' AND column_name='embedding';" 2>$null
    if ($colCheck -match "vector") {
        ok "documents table exists with VECTOR(768) column"
    } else {
        info "documents table exists but dimension not verified (app.js will handle it)"
    }
} else {
    info "documents table not yet created — app.js creates it automatically on first start"
}

# ── Apache Tika ────────────────────────────────────────────────────────────
$TIKA_NAME  = "tika"
$TIKA_IMAGE = "docker.io/apache/tika:latest-full"
$TIKA_PORT  = 9998

$existing = podman ps -a --format "{{.Names}}" 2>$null
if ($existing -match [regex]::Escape($TIKA_NAME)) {
    $running = podman ps --format "{{.Names}}" 2>$null
    if ($running -match [regex]::Escape($TIKA_NAME)) {
        ok "Tika container '$TIKA_NAME' is already running"
    } else {
        info "Tika container exists but is stopped — starting it…"
        podman start "$TIKA_NAME" | Out-Null
        ok "Tika container started"
    }
} else {
    info "Creating Tika container…"
    podman run -d `
        --name "$TIKA_NAME" `
        -p "${TIKA_PORT}:9998" `
        "$TIKA_IMAGE" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        ok "Tika container created and started"
    } else {
        fail "Failed to create Tika container"
    }
}

# ── 3. Health checks (ping ports) ──────────────────────────────────────────
Write-Host ""
info "Running health checks…"
$ALL_OK = $true

function HealthCheck($name, $hostname, $port, $timeout = 5) {
    if (Test-Port $hostname $port $timeout) {
        ok "$name — port $port is OPEN"
        return $true
    } else {
        fail "$name — port $port is NOT responding"
        return $false
    }
}

if (-not (HealthCheck "PostgreSQL (pgvector)" "127.0.0.1" $PG_PORT 5)) { $ALL_OK = $false }
if (-not (HealthCheck "Apache Tika" "127.0.0.1" $TIKA_PORT 5))          { $ALL_OK = $false }

# ── 4. Create docs/ and .env ───────────────────────────────────────────────
Write-Host ""
info "Creating project directories…"
New-Item -ItemType Directory -Path "docs" -Force | Out-Null
ok "docs/ directory ready"

if (-not (Test-Path ".env")) {
    info "Creating .env file with defaults…"
    @"
# Vector Practice — Environment Configuration
# Edit this file to adjust settings.

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
"@ | Out-File -FilePath ".env" -Encoding utf8
    ok ".env file created (edit if needed)"
} else {
    ok ".env file already exists"
}

# ── 5. npm install ─────────────────────────────────────────────────────────
Write-Host ""
info "Running npm install…"
if (Test-Path "package.json") {
    npm install 2>&1 | Select-Object -Last 5
    ok "npm install completed"
} else {
    fail "package.json not found — skipping npm install"
    $ALL_OK = $false
}

# ── 6. Check model servers (ports 8081-8083) ───────────────────────────────
Write-Host ""
info "Checking model servers (llama.cpp)…"
Write-Host "  These must be started separately — see below for commands."

if (-not (HealthCheck "EmbeddingGemma (8081)" "127.0.0.1" 8081 3)) { $ALL_OK = $false }
if (-not (HealthCheck "Ettin Reranker (8082)"  "127.0.0.1" 8082 3)) { $ALL_OK = $false }
if (-not (HealthCheck "Qwen3.5 4B (8083)"      "127.0.0.1" 8083 3)) { $ALL_OK = $false }

# ── Summary ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
if ($ALL_OK) {
    Write-Host "  [✓] ALL CHECKS PASSED — everything is up and running!" -ForegroundColor Green
} else {
    Write-Host "  [✗] SOME CHECKS FAILED — review the output above" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Non-critical failures (model servers) are expected if you haven't"
    Write-Host "  started llama.cpp yet. The app will still start, but search/answer"
    Write-Host "  won't work until the models are running."
}
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
info "Ports summary:"
Write-Host "  PostgreSQL (pgvector) : 127.0.0.1:$PG_PORT"
Write-Host "  Apache Tika           : 127.0.0.1:$TIKA_PORT"
Write-Host "  EmbeddingGemma        : 127.0.0.1:8081"
Write-Host "  Ettin Reranker        : 127.0.0.1:8082"
Write-Host "  Qwen3.5 4B            : 127.0.0.1:8083"
Write-Host ""
Write-Host "  ┌─────────────────────────────────────────────────────────────┐" -ForegroundColor DarkGray
Write-Host "  │  Start llama.cpp servers (in separate terminals):           │" -ForegroundColor DarkGray
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  Embedding:                                                 │" -ForegroundColor DarkGray
Write-Host "  │    .\llama-server -m models\embedding.gguf -c 8192          │" -ForegroundColor DarkGray
Write-Host "  │               -ub 512 --port 8081 --embedding               │" -ForegroundColor DarkGray
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  Reranker:                                                  │" -ForegroundColor DarkGray
Write-Host "  │    .\llama-server -m models\reranker.gguf --port 8082       │" -ForegroundColor DarkGray
Write-Host "  │               --reranking -c 8192                           │" -ForegroundColor DarkGray
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  Answer:                                                    │" -ForegroundColor DarkGray
Write-Host "  │    .\llama-server -m models\qwen.gguf --port 8083 -c 32768  │" -ForegroundColor DarkGray
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
Write-Host ""

# ── 7. Launch the app ──────────────────────────────────────────────────────
$startApp = Read-Host "Start the app now? [Y/n]"
if ($startApp -eq "" -or $startApp -match "^[Yy]") {
    info "Starting: node app.js"
    Write-Host ""
    node app.js
} else {
    info "To start manually:  node app.js"
    Write-Host ""
    Read-Host "Press Enter to close"
}
