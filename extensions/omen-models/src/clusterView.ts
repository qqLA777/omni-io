/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as os from "os";
import * as http from "http";

export type ComputeBackendMode =
	| "local-cluster"
	| "local-single"
	| "modal-cloud"
	| "external-api";

export interface ClusterNode {
	id: string;
	name: string;
	role: "host" | "worker";
	ip: string;
	gpuName: string;
	vramGb: number;
	cpuThreads: number;
	status: "online" | "paired";
}

export interface ClusterState {
	backend: ComputeBackendMode;
	pairingPin: string;
	pairingPort: number;
	pairingActive: boolean;
	hostIp: string;
	hostVramGb: number;
	workerVramGb: number;
	hostThreads: number;
	workerThreads: number;
	storageOffload: boolean;
	modalGpuType: "T4" | "A10G" | "A100" | "H100";
	nodes: ClusterNode[];
}

export class OmenClusterViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.clusterView";
	private _view?: vscode.WebviewView;
	private _server?: http.Server;
	private _state: ClusterState;

	private readonly _onDidChangeState = new vscode.EventEmitter<ClusterState>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	constructor(private readonly _context: vscode.ExtensionContext) {
		const saved = this._context.globalState.get<ClusterState>(
			"omen.cluster.state",
		);
		const hostIp = this._getLocalLanIp();
		const pin = Math.floor(1000 + Math.random() * 9000).toString();

		this._state = saved ?? {
			backend: "local-cluster",
			pairingPin: pin,
			pairingPort: 50050,
			pairingActive: false,
			hostIp,
			hostVramGb: 12,
			workerVramGb: 4,
			hostThreads: 8,
			workerThreads: 12,
			storageOffload: true,
			modalGpuType: "A10G",
			nodes: [
				{
					id: "node-host-m4",
					name: "Apple M4 Workstation (Host)",
					role: "host",
					ip: hostIp,
					gpuName: "Apple M4 Metal Unified",
					vramGb: 12,
					cpuThreads: 8,
					status: "online",
				},
				{
					id: "node-worker-nitro5",
					name: "Acer Nitro 5 (LAN Worker)",
					role: "worker",
					ip: "192.168.1.108",
					gpuName: "NVIDIA GeForce RTX 3050",
					vramGb: 4,
					cpuThreads: 12,
					status: "paired",
				},
			],
		};
		this._state.hostIp = hostIp;
	}

	public get state(): ClusterState {
		return this._state;
	}

	public getStatusSummary(): string {
		switch (this._state.backend) {
			case "local-cluster": {
				const totalVram =
					this._state.hostVramGb +
					(this._state.nodes.length > 1 ? this._state.workerVramGb : 0);
				const totalThreads =
					this._state.hostThreads +
					(this._state.nodes.length > 1 ? this._state.workerThreads : 0);
				return `$(server-process) Omen Cluster: ${totalVram}GB VRAM • ${totalThreads}T`;
			}
			case "local-single":
				return `$(device-desktop) Omen Local: M4 (${this._state.hostVramGb}GB • ${this._state.hostThreads}T)`;
			case "modal-cloud":
				return `$(cloud) Omen Modal: ${this._state.modalGpuType} Serverless`;
			case "external-api":
				return `$(sparkle) Omen Cloud API (BYOK)`;
		}
	}

	private _getLocalLanIp(): string {
		const nets = os.networkInterfaces();
		for (const name of Object.keys(nets)) {
			for (const net of nets[name] ?? []) {
				if (net.family === "IPv4" && !net.internal) {
					return net.address;
				}
			}
		}
		return "127.0.0.1";
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready":
					this._postState();
					break;
				case "setBackend":
					this._state.backend = msg.backend;
					await this._saveAndNotify();
					break;
				case "updateHardware":
					this._state.hostVramGb = Number(msg.hostVramGb);
					this._state.workerVramGb = Number(msg.workerVramGb);
					this._state.hostThreads = Number(msg.hostThreads);
					this._state.workerThreads = Number(msg.workerThreads);
					this._state.storageOffload = Boolean(msg.storageOffload);
					await this._saveAndNotify();
					break;
				case "setModalGpu":
					this._state.modalGpuType = msg.gpu;
					await this._saveAndNotify();
					break;
				case "togglePairingPortal":
					if (this._state.pairingActive) {
						this._stopPairingServer();
					} else {
						this._startPairingServer();
					}
					await this._saveAndNotify();
					break;
				case "addNitroWorker":
					if (!this._state.nodes.some((n) => n.role === "worker")) {
						this._state.nodes.push({
							id: `node-worker-${Date.now()}`,
							name: "Acer Nitro 5 (LAN Worker)",
							role: "worker",
							ip: "192.168.1.108",
							gpuName: "NVIDIA GeForce RTX 3050",
							vramGb: this._state.workerVramGb,
							cpuThreads: this._state.workerThreads,
							status: "paired",
						});
						await this._saveAndNotify();
					}
					break;
				case "removeWorker":
					this._state.nodes = this._state.nodes.filter(
						(n) => n.id !== msg.nodeId,
					);
					await this._saveAndNotify();
					break;
				case "manageModels":
					await vscode.commands.executeCommand("omen.manageModels");
					break;
				case "setApiKey":
					await vscode.commands.executeCommand("omen.setApiKey");
					break;
			}
		});
	}

	private _startPairingServer(): void {
		if (this._server) {
			return;
		}
		this._state.pairingPin = Math.floor(1000 + Math.random() * 9000).toString();
		this._server = http.createServer((req, res) => {
			if (req.method === "POST" && req.url === "/pair") {
				let body = "";
				req.on("data", (chunk) => (body += chunk));
				req.on("end", () => {
					try {
						const data = JSON.parse(body);
						if (data.pin === this._state.pairingPin) {
							const remoteIp =
								req.socket.remoteAddress?.replace("::ffff:", "") ??
								"192.168.1.108";
							if (!this._state.nodes.some((n) => n.ip === remoteIp && n.role === "worker")) {
								this._state.nodes.push({
									id: `worker-${Date.now()}`,
									name: data.deviceName || "Acer Nitro 5 (RTX 3050)",
									role: "worker",
									ip: remoteIp,
									gpuName: "NVIDIA CUDA + Intel H-Series",
									vramGb: this._state.workerVramGb,
									cpuThreads: this._state.workerThreads,
									status: "paired",
								});
								void this._saveAndNotify();
							}
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ ok: true }));
							return;
						}
					} catch {
						// Invalid payload
					}
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Invalid PIN" }));
				});
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!DOCTYPE html><html><head><title>Omen Web Pairing Portal</title>
			<style>body{background:#141414;color:#E6E6E6;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
			.box{background:#161616;padding:28px;border-radius:10px;border:1px solid #242424;max-width:360px;text-align:center}
			input{padding:10px;font-size:18px;width:140px;text-align:center;letter-spacing:6px;border-radius:6px;border:1px solid #2E2E2E;background:#212121;color:#EDEDED;margin:12px 0}
			button{background:#262626;color:#EDEDED;border:1px solid #333333;padding:10px 18px;font-weight:600;border-radius:6px;cursor:pointer;width:100%}</style></head>
			<body><div class="box"><h2>Omen Zero-Install Worker Portal</h2><p>Enter the 4-digit PIN displayed in your Omen IDE to pool CPU/GPU threads:</p>
			<input id="pin" maxlength="4" placeholder="0000" /><br/>
			<button onclick="pair()">Pair Secondary Device & Download Worker</button><p id="msg"></p></div>
			<script>async function pair(){const pin=document.getElementById('pin').value;const r=await fetch('/pair',{method:'POST',body:JSON.stringify({pin,deviceName:navigator.platform+' Worker'})});const j=await r.json();document.getElementById('msg').textContent=j.ok?'Paired with Omen Host! You may close this tab.':'Invalid 4-digit PIN.';}</script></body></html>`);
		});

		this._server.on("error", () => {
			// Port busy fallback
			this._state.pairingPort = 50051;
		});

		try {
			this._server.listen(this._state.pairingPort, "0.0.0.0", () => {
				this._state.pairingActive = true;
				this._postState();
			});
		} catch {
			this._state.pairingActive = false;
		}
	}

	private _stopPairingServer(): void {
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
		this._state.pairingActive = false;
	}

	private async _saveAndNotify(): Promise<void> {
		await this._context.globalState.update("omen.cluster.state", this._state);
		this._onDidChangeState.fire(this._state);
		this._postState();
	}

	private _postState(): void {
		if (!this._view) {
			return;
		}
		this._view.webview.postMessage({
			type: "state",
			state: this._state,
		});
	}

	public dispose(): void {
		this._stopPairingServer();
		this._onDidChangeState.dispose();
	}

	private _getHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
	:root {
		--bg: transparent;
		--fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
		--border: var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.1));
		--btn-bg: var(--vscode-button-background);
		--btn-fg: var(--vscode-button-foreground);
		--accent: var(--vscode-textLink-foreground, #EDEDED);
		--card-bg: #212121;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px;
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
		font-size: 12px;
		color: var(--fg);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.card {
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
	}
	.card-title {
		font-weight: 600;
		font-size: 12px;
		margin-bottom: 8px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.backend-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}
	.backend-card {
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 8px;
		cursor: pointer;
		background: rgba(0,0,0,0.12);
	}
	.backend-card.active {
		border-color: #3A3A3A;
		background: #272727;
	}
	.backend-name {
		font-weight: 600;
		font-size: 11.5px;
		margin-bottom: 3px;
	}
	.backend-desc {
		font-size: 10px;
		opacity: 0.75;
		line-height: 1.3;
	}
	.portal-box {
		background: #1C1C1C;
		border: 1px dashed #333333;
		border-radius: 6px;
		padding: 9px;
		margin-top: 6px;
	}
	.pin-badge {
		font-family: monospace;
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 3px;
		color: var(--accent);
		background: rgba(0,0,0,0.25);
		padding: 2px 8px;
		border-radius: 4px;
	}
	.slider-row {
		margin-bottom: 8px;
	}
	.slider-header {
		display: flex;
		justify-content: space-between;
		font-size: 11px;
		margin-bottom: 3px;
	}
	input[type="range"] {
		width: 100%;
		accent-color: var(--accent);
	}
	.node-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 8px;
		border-radius: 4px;
		background: rgba(0,0,0,0.15);
		margin-top: 5px;
	}
	.btn {
		background: var(--btn-bg);
		color: var(--btn-fg);
		border: none;
		border-radius: 4px;
		padding: 5px 9px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
	}
	.btn-secondary {
		background: rgba(255,255,255,0.08);
		color: var(--fg);
	}
	.badge-online {
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 10px;
		background: rgba(16, 185, 129, 0.2);
		color: #34d399;
	}
</style>
</head>
<body>
	<!-- 1. The 4 Pluggable Compute Backends -->
	<div class="card">
		<div class="card-title">
			<span>Pluggable Compute Backend</span>
			<span id="activeBackendLabel" class="badge-online">Local Cluster</span>
		</div>
		<div class="backend-grid">
			<div id="be-local-cluster" class="backend-card" onclick="selectBackend('local-cluster')">
				<div class="backend-name">1. Multi-Device Cluster</div>
				<div class="backend-desc">Mac M4 + RTX 3050 + LAN CPU threads</div>
			</div>
			<div id="be-local-single" class="backend-card" onclick="selectBackend('local-single')">
				<div class="backend-name">2. Local Single-Device</div>
				<div class="backend-desc">Host Mac M4 Ollama / llama.cpp</div>
			</div>
			<div id="be-modal-cloud" class="backend-card" onclick="selectBackend('modal-cloud')">
				<div class="backend-name">3. Modal Cloud GPU</div>
				<div class="backend-desc">Serverless T4 / A10G / A100 / H100</div>
			</div>
			<div id="be-external-api" class="backend-card" onclick="selectBackend('external-api')">
				<div class="backend-name">4. External Cloud API</div>
				<div class="backend-desc">DeepSeek, OpenAI, Meta (BYOK)</div>
			</div>
		</div>
	</div>

	<!-- 2. Flagship Web Pairing Portal -->
	<div class="card" id="clusterSection">
		<div class="card-title">
			<span>3-Step LAN Web Pairing Portal</span>
			<button id="portalToggleBtn" class="btn" onclick="togglePortal()">Start Portal</button>
		</div>
		<div class="portal-box">
			<div style="display:flex; justify-content:space-between; align-items:center;">
				<div>
					<div style="font-size:10.5px; opacity:0.8;">Pairing URL (Open on Acer Nitro 5):</div>
					<code id="pairingUrlText" style="color:var(--accent); font-weight:600;">http://127.0.0.1:50050</code>
				</div>
				<div style="text-align:right;">
					<div style="font-size:10px; opacity:0.8;">4-Digit PIN</div>
					<span id="pinText" class="pin-badge">4829</span>
				</div>
			</div>
		</div>
		<div style="margin-top:8px;">
			<div style="display:flex; justify-content:space-between; align-items:center;">
				<strong style="font-size:11px;">Pooled Cluster Nodes</strong>
				<button class="btn btn-secondary" onclick="addNitroWorker()" style="font-size:10px; padding:3px 7px;">+ Link Nitro 5 RTX 3050</button>
			</div>
			<div id="nodesList"></div>
		</div>
	</div>

	<!-- 3. Hardware & Thread Allocation -->
	<div class="card">
		<div class="card-title">
			<span>GPU Layer & CPU Thread Allocation</span>
			<span id="pooledTotals" style="font-size:11px; color:var(--accent);">16 GB VRAM • 20 Threads</span>
		</div>
		<div class="slider-row">
			<div class="slider-header">
				<span>Host Apple M4 Unified Memory</span>
				<strong id="hostVramVal">12 GB</strong>
			</div>
			<input type="range" id="hostVramSlider" min="4" max="24" value="12" oninput="onHardwareInput()" />
		</div>
		<div class="slider-row">
			<div class="slider-header">
				<span>Secondary Acer Nitro RTX 3050 VRAM</span>
				<strong id="workerVramVal">4 GB</strong>
			</div>
			<input type="range" id="workerVramSlider" min="0" max="12" value="4" oninput="onHardwareInput()" />
		</div>
		<div class="slider-row">
			<div class="slider-header">
				<span>Host Apple M4 CPU Threads</span>
				<strong id="hostThreadsVal">8 Threads</strong>
			</div>
			<input type="range" id="hostThreadsSlider" min="2" max="14" value="8" oninput="onHardwareInput()" />
		</div>
		<div class="slider-row">
			<div class="slider-header">
				<span>Secondary Intel Core H-Series CPU Threads</span>
				<strong id="workerThreadsVal">12 Threads</strong>
			</div>
			<input type="range" id="workerThreadsSlider" min="0" max="20" value="12" oninput="onHardwareInput()" />
		</div>
		<label style="display:flex; align-items:center; gap:6px; font-size:11px; cursor:pointer; margin-top:4px;">
			<input type="checkbox" id="storageOffloadCheck" checked onchange="onHardwareInput()" />
			Offload .gguf weights & vector indexes to secondary SSD (<code>C:\.omen-cache\</code>)
		</label>
	</div>

	<!-- 4. Quick Model & API Actions -->
	<div class="card" style="display:flex; gap:6px;">
		<button class="btn" style="flex:1;" onclick="vscode.postMessage({type:'manageModels'})">Manage Ollama Models</button>
		<button class="btn btn-secondary" style="flex:1;" onclick="vscode.postMessage({type:'setApiKey'})">Configure API Keys</button>
	</div>

<script>
	const vscode = acquireVsCodeApi();

	function selectBackend(backend) {
		vscode.postMessage({ type: 'setBackend', backend });
	}

	function togglePortal() {
		vscode.postMessage({ type: 'togglePairingPortal' });
	}

	function addNitroWorker() {
		vscode.postMessage({ type: 'addNitroWorker' });
	}

	function removeWorker(nodeId) {
		vscode.postMessage({ type: 'removeWorker', nodeId });
	}

	function onHardwareInput() {
		const hostVramGb = Number(document.getElementById('hostVramSlider').value);
		const workerVramGb = Number(document.getElementById('workerVramSlider').value);
		const hostThreads = Number(document.getElementById('hostThreadsSlider').value);
		const workerThreads = Number(document.getElementById('workerThreadsSlider').value);
		const storageOffload = document.getElementById('storageOffloadCheck').checked;

		document.getElementById('hostVramVal').textContent = hostVramGb + ' GB';
		document.getElementById('workerVramVal').textContent = workerVramGb + ' GB';
		document.getElementById('hostThreadsVal').textContent = hostThreads + ' Threads';
		document.getElementById('workerThreadsVal').textContent = workerThreads + ' Threads';
		document.getElementById('pooledTotals').textContent =
			(hostVramGb + workerVramGb) + ' GB VRAM • ' + (hostThreads + workerThreads) + ' Threads';

		vscode.postMessage({
			type: 'updateHardware',
			hostVramGb,
			workerVramGb,
			hostThreads,
			workerThreads,
			storageOffload
		});
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			const s = msg.state;
			document.querySelectorAll('.backend-card').forEach(el => el.classList.remove('active'));
			const activeEl = document.getElementById('be-' + s.backend);
			if (activeEl) activeEl.classList.add('active');

			const labels = {
				'local-cluster': 'Local Multi-Device Cluster',
				'local-single': 'Single-Device (Mac M4)',
				'modal-cloud': 'Modal Serverless GPU',
				'external-api': 'External Cloud API'
			};
			document.getElementById('activeBackendLabel').textContent = labels[s.backend] || s.backend;

			document.getElementById('pairingUrlText').textContent = 'http://' + s.hostIp + ':' + s.pairingPort;
			document.getElementById('pinText').textContent = s.pairingPin;
			document.getElementById('portalToggleBtn').textContent = s.pairingActive ? 'Stop Portal (Live)' : 'Start Portal';

			document.getElementById('hostVramSlider').value = s.hostVramGb;
			document.getElementById('workerVramSlider').value = s.workerVramGb;
			document.getElementById('hostThreadsSlider').value = s.hostThreads;
			document.getElementById('workerThreadsSlider').value = s.workerThreads;
			document.getElementById('storageOffloadCheck').checked = s.storageOffload;

			document.getElementById('hostVramVal').textContent = s.hostVramGb + ' GB';
			document.getElementById('workerVramVal').textContent = s.workerVramGb + ' GB';
			document.getElementById('hostThreadsVal').textContent = s.hostThreads + ' Threads';
			document.getElementById('workerThreadsVal').textContent = s.workerThreads + ' Threads';
			document.getElementById('pooledTotals').textContent =
				(s.hostVramGb + s.workerVramGb) + ' GB VRAM • ' + (s.hostThreads + s.workerThreads) + ' Threads';

			const list = document.getElementById('nodesList');
			list.innerHTML = '';
			(s.nodes || []).forEach(n => {
				const div = document.createElement('div');
				div.className = 'node-item';
				div.innerHTML =
					'<div><strong>' + n.name + '</strong><div style="font-size:10px;opacity:0.75;">' +
					n.gpuName + ' • ' + n.ip + '</div></div>' +
					(n.role === 'worker'
						? '<button class="btn btn-secondary" style="font-size:10px;padding:3px 6px;" onclick="removeWorker(\\'' + n.id + '\\')">Unpair</button>'
						: '<span class="badge-online">Host</span>');
				list.appendChild(div);
			});
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}

