# Vector Practice

A local vector search application with document ingestion, semantic retrieval, reranking, and AI-powered answering.

---

## Prerequisites

### Podman (or Docker)

**Podman** must be installed and running before starting any containerized services.

**On Fedora/RHEL/CentOS:**
```bash
sudo dnf install podman
podman system service --time=0 &
```

**On Ubuntu/Debian:**
```bash
sudo apt install podman
podman system service --time=0 &
```

> **Docker users:** All commands below work with `docker` instead of `podman`. Replace `podman` → `docker` where applicable.

---

## Dependencies & Setup

### 1. Node.js

Install Node.js (v18+ recommended):

```bash
# Using nvm
nvm install 20
nvm use 20

# Then install project dependencies
cd /home/emir/Documents/code/vector-practice
npm install
```

Start the Express server:

```bash
node app.js
# Server running on http://localhost:3000
```

---

### 2. PostgreSQL (pgvector) — Vector Database

Run PostgreSQL with the `pgvector` extension via Podman (or Docker):

```bash
podman run -d \
  --name postgres-vector \
  -p 5434:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=vectordb \
  -v pgvector-data:/var/lib/postgresql/data \
  docker.io/docker.io/library/pgvector/pgvector:pg17


When running existing: 
podman run -d --name postgres -p 5434:5432 -v pgvector-data:/var/lib/postgresql -e POSTGRES_PASSWORD=postgres docker.io/pgvector/pgvector:pg18


podman exec -it postgres createdb -U postgres vectordb

run this to install vector
podman exec -it postgres psql -U postgres -d vectordb -c "SELECT extname, extversion FROM pg_extension;"

# Docker equivalent:
# docker run -d \
#   --name postgres-vector \
#   -p 5434:5432 \
#   -e POSTGRES_PASSWORD=postgres \
#   -e POSTGRES_DB=vectordb \
#   -v pgvector-data:/var/lib/postgresql/data \
#   docker.io/docker.io/library/pgvector/pgvector:pg17
```

| Setting      | Value               |
|--------------|---------------------|
| Host         | `127.0.0.1`         |
| Port         | `5434`              |
| Database     | `vectordb`          |
| User         | `postgres`          |
| Password     | `postgres`          |
| Vector dim   | **768**             |

The `documents` table schema:

```sql
CREATE TABLE documents (
  id        BIGSERIAL PRIMARY KEY,
  title     TEXT,
  content   TEXT NOT NULL,
  metadata  JSONB,
  embedding VECTOR(768)
);
```

---

### 3. Apache Tika — Document Parsing

Run Apache Tika for PDF, DOCX, XLSX, PPTX, and other file format parsing via Podman (or Docker):

```bash
podman run -d \
  --name tika \
  -p 9998:9998 \
  docker.io/apache/tika:latest-full

# Docker equivalent:
# docker run -d \
#   --name tika \
#   -p 9998:9998 \
#   docker.io/apache/tika:latest-full
```

| Setting | Value              |
|---------|--------------------|
| Host    | `127.0.0.1`        |
| Port    | `9998`             |
| Endpoint| `/tika`            |

---

### 4. llama.cpp Servers

All three models run via `llama-server` from the llama.cpp build.

#### 4a. Embedding Model — EmbeddingGemma 300M

```bash
MODEL_DIR="$(dirname "$(find "$HOME" -type f -name 'embeddinggemma-300M-Q8_0.gguf' -print -quit)")" && \
echo "Using model directory: $MODEL_DIR" && \
./build/bin/llama-server \
  --model "$(find "$HOME" -type f -name 'embeddinggemma-300M-Q8_0.gguf' -print -quit)" \
  --device CUDA0 \
  -ngl 999 \
  --embedding \
  --ctx-size 8192 \
  -ub 2048 \
  --pooling mean \
  --host 127.0.0.1 \
  -b 2048 \
  --port 8081
```

| Setting      | Value                              |
|--------------|------------------------------------|
| Model        | `embeddinggemma-300M-Q8_0.gguf`    |
| Host         | `127.0.0.1`                        |
| Port         | `8081`                             |
| Context      | 8192                               |
| Batch size   | 2048                               |
| Pooling      | `mean`                             |

#### 4b. Reranker Model — Ettin Reranker 150M v1

```bash
MODEL_DIR="$(dirname "$(find "$HOME" -type f -name 'ettin-reranker-150m-v1-q8_0.gguf' -print -quit)")" && \
echo "Using model directory: $MODEL_DIR" && \
./build/bin/llama-server \
  --model "$(find "$HOME" -type f -name 'ettin-reranker-150m-v1-q8_0.gguf' -print -quit)" \
  --device CUDA0 \
  -ngl 999 \
  --reranking \
  --ctx-size 4096 \
  --host 127.0.0.1 \
  --port 8082
```

| Setting      | Value                                    |
|--------------|------------------------------------------|
| Model        | `ettin-reranker-150m-v1-q8_0.gguf`       |
| Host         | `127.0.0.1`                              |
| Port         | `8082`                                   |
| Context      | 4096                                     |

#### 4c. Answer Model — Qwen3.5 4B

```bash
MODEL_DIR="$(dirname "$(find "$HOME" -type f -name 'Qwen3.5-4B-Q4_K_M.gguf' -print -quit)")" && \
echo "Using model directory: $MODEL_DIR" && \
./build/bin/llama-server \
  --model "$(find "$HOME" -type f -name 'Qwen3.5-4B-Q4_K_M.gguf' -print -quit)" \
  --device CUDA0 \
  -ngl 999 \
  --embedding \
  --ctx-size 16384 \
  --pooling last \
  --host 127.0.0.1 \
  --port 8083
```

| Setting      | Value                              |
|--------------|------------------------------------|
| Model        | `Qwen3.5-4B-Q4_K_M.gguf`           |
| Host         | `127.0.0.1`                        |
| Port         | `8083`                             |
| Context      | 16384                              |
| Pooling      | `last`                             |

---

## Port Summary

| Service              | Port  | Purpose                     |
|----------------------|-------|-----------------------------|
| Express (web UI)     | `3000`| Main application server     |
| PostgreSQL + pgvector| `5434`| Vector database             |
| Apache Tika          | `9998`| Document parsing            |
| EmbeddingGemma       | `8081`| Semantic embeddings         |
| Ettin Reranker       | `8082`| Cross-encoder reranking     |
| Qwen3.5 4B           | `8083`| Answer generation           |

---

## Quick Start

```bash
# 1. Start all backend services (PostgreSQL, Tika, llama-servers)
# 2. Install Node.js dependencies
cd /home/emir/Documents/code/vector-practice
npm install

# 3. Start the application
node app.js
```

Then open http://localhost:3000 in your browser.
