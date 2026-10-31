# Omen Architecture Specification: Modular Agentic IDE & Hybrid Compute Orchestrator

## 1. Core Architectural Philosophy: Developer-Composable Modularity

**Omen** (`omen-dev` / `omni-io`) is a modular Agentic AI IDE and Hybrid Compute Orchestrator built on Code - OSS.

Rather than forcing a rigid, single-mode pipeline, every subsystem in Omen—compute pooling, cloud offloading, external AI APIs, and RAG vector databases—is strictly modular and optional. Developers create and customize independent Cluster Profiles and Agent Profiles by combining only the building blocks they need:

* **Example Setup A (Cloud API Agent)**: Uses an external API provider (DeepSeek or ChatGPT) for fast cloud generation, with RAG turned off (or optionally paired with a local vector database).
* **Example Setup B (Flagship Distributed Local Cluster)**: Runs local `.gguf` / Ollama LLMs across pooled local CPUs and GPUs (e.g., Apple M4 Mac + Acer Nitro 5 RTX 3050 + Intel CPU threads) over LAN to boost multi-threading, expand VRAM/RAM capacity, and query a local vector database (similar to LM Studio's local document workflow, scaled across machines).
* **Example Setup C (Elastic Cloud Burst)**: Connects to [Modal](https://modal.com) serverless cloud GPUs (T4, A10G, A100, H100) on demand for heavy 70B+ open-weight inference or batch indexing, scaling to $0 when idle.

---

## 2. The 4 Pluggable Compute Backends

Developers can assign different compute backends to different agents or switch between them at any time:

| Compute Module | How It Works | Primary Advantage |
| :--- | :--- | :--- |
| **1. Local Multi-Device Cluster (Core Flagship Feature)** | Connects secondary laptops/PCs over local Wi-Fi/Ethernet via the zero-install Web Pairing Portal (`omen-worker.exe`). Pools Apple Metal + NVIDIA CUDA + multi-device CPU threads. | Boosts inference throughput, extends combined RAM/VRAM (~19–21+ GB on M4 + Nitro 5), and stays 100% offline and free. |
| **2. Local Single-Device** | Runs local models via Ollama or embedded `llama.cpp` strictly on the host machine (Mac M4). | Zero network setup for mobile, single-laptop coding. |
| **3. Serverless Cloud Compute (Modal)** | Spins up ephemeral cloud containers with NVIDIA T4, A10G, A100, or H100 GPUs and high-core CPUs via [Modal](https://modal.com/docs/guide). | Runs massive 70B+ open models or parallel batch jobs in the cloud, billing per second and scaling to $0 when idle. |
| **4. External AI APIs (ChatGPT, DeepSeek, Meta)** | Connects to OpenAI-compatible REST endpoints using the developer's API keys (BYOK). | Instant access to frontier cloud models (`gpt-4o`, `deepseek-chat`, `deepseek-reasoner`) with zero hardware load. |

---

## 3. Flagship Feature: Multi-Device CPU & GPU Thread Pooling

When a developer enables the Local Multi-Device Cluster, Omen links the host workstation (Mac M4) with one or more secondary devices (Acer Nitro 5) using the 3-Step Web Pairing Portal:

1. **Zero-Install Pairing**: Omen displays a local pairing URL (`http://<Mac-IP>:50050`) and a 4-digit PIN. The secondary device opens the URL in a browser, enters the PIN, downloads and launches `omen-worker.exe`, and immediately closes the browser tab.
2. **Customizable Hardware & Thread Allocation**:
   * **GPU Layer Distribution**: Offload neural network layers across Mac M4 Unified Memory (~12 GB) and Acer Nitro RTX 3050 VRAM (4 GB).
   * **Distributed CPU Threading Boost**: Allocate CPU worker threads across both machines (e.g., 8 threads on Apple M4 + 12 threads on Intel Core H-Series) to accelerate prompt ingestion, tokenization, AST code parsing, and overflow layer computation.
   * **Storage Offloading**: Optionally store heavy `.gguf` weights (7B–32B) and vector indexes on the secondary device's larger SSD (`C:\.omen-cache\`), preserving the Mac M4's 256 GB SSD.

---

## 4. Optional Local Vector Database & Context Management (LM Studio Style)

RAG and context tools are completely optional and modular per agent:

* **Local Vector Database (LM Studio Style)**: Developers can create local document collections inside Omen, drag-and-drop PDFs, Markdown docs, or code folders, and index them locally using lightweight embedding models (`nomic-embed-text` or `bge-m3`).
* **Universal Model Compatibility**: Works with any compute backend—a developer can retrieve chunks from their Local Vector Database and feed them into either a Local Clustered LLM, a Modal Cloud GPU, or the DeepSeek / ChatGPT API.
* **Direct Context Injection & Live Token Meter**: Attach whole files directly into the prompt with a live Context Token & KV-Cache Meter showing real-time token consumption against the active model's context window.

---

## 5. Phased Implementation Roadmap

| Phase | Milestone | Deliverable |
| :--- | :--- | :--- |
| **Phase 1** | **Modular Provider & Agent Configurator** | Build the unified configuration schema in Omen allowing developers to create custom agents choosing between External APIs (ChatGPT/DeepSeek), Local Ollama/GGUF, or Modal Cloud. |
| **Phase 2** | **Local Multi-Device Cluster & Threading Boost** | Implement the Web Pairing Portal (4-digit PIN) and `omen-worker.exe` to pool Mac M4 + Windows RTX 3050 + multi-device CPU threads with live hardware telemetry. |
| **Phase 3** | **Optional Local Vector DB & Token Meter** | Add the LM Studio-style local document ingestion pipeline (chunking, local embeddings, vector search) and live Context Token bar, usable with both local and API models. |
| **Phase 4** | **Modal Serverless GPU Integration** | Integrate the Modal Python SDK bridge so developers can optionally burst heavy models or batch jobs to on-demand cloud GPUs. |

---

## Upstream Base & Development

This project is built on top of [Code - OSS](https://github.com/microsoft/vscode). 

### Prerequisites & Building
* **Node.js**: `v24.22.0` (as specified in `.nvmrc`)
* **Package Manager**: `npm` (< 13.0.0)

```bash
# Set Node version
nvm use 24

# Install dependencies
npm install

# Compile Omen Models extension
npm --prefix extensions/omen-models run compile

# Transpile client & launch
npm run transpile-client
./scripts/code.sh
```

### License

The original Code - OSS core is licensed under the [MIT](LICENSE.txt) license.
