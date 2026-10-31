/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as os from "os";
import * as http from "http";
import * as crypto from "crypto";
import { execSync } from "child_process";

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
	status: "online" | "paired" | "unverified";
	installedModels?: string[];
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
		const hostIp = this._getLocalLanIp();
		const pin = Math.floor(1000 + Math.random() * 9000).toString();

		const realCpuThreads = os.cpus()?.length || 8;
		const realRamGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
		let realCpuBrand = "Host CPU";

		try {
			if (process.platform === "darwin") {
				const brand = execSync(
					"sysctl -n machdep.cpu.brand_string 2>/dev/null",
					{ encoding: "utf8" },
				).trim();
				if (brand) {
					realCpuBrand = brand;
				}
			}
		} catch {
			// Fallback
		}

		const hostNode: ClusterNode = {
			id: "node-host",
			name: `${realCpuBrand} (Host Device)`,
			role: "host",
			ip: hostIp,
			gpuName: `${realCpuBrand} Unified Memory`,
			vramGb: realRamGb,
			cpuThreads: realCpuThreads,
			status: "online",
		};

		const savedNodes = this._context.globalState.get<ClusterNode[]>(
			"omen.cluster.savedNodes",
		);
		const initialNodes = [hostNode];
		if (Array.isArray(savedNodes)) {
			const validWorkers = savedNodes.filter((n) => n.role === "worker");
			initialNodes.push(...validWorkers);
		}

		this._state = {
			backend: "local-single",
			pairingPin: pin,
			pairingPort: 50050,
			pairingActive: false,
			hostIp,
			hostVramGb: realRamGb,
			workerVramGb: 0,
			hostThreads: realCpuThreads,
			workerThreads: 0,
			storageOffload: false,
			modalGpuType: "A10G",
			nodes: initialNodes,
		};
	}

	public get state(): ClusterState {
		return this._state;
	}

	public getVerifiedWorkerNodes(): ClusterNode[] {
		return this._state.nodes.filter(
			(n) => n.role === "worker" && n.status === "paired",
		);
	}

	public getStatusSummary(): string {
		const host = this._state.nodes.find((n) => n.role === "host");
		const workers = this.getVerifiedWorkerNodes();
		if (workers.length > 0) {
			const totalVram =
				(host?.vramGb || 0) + workers.reduce((acc, w) => acc + w.vramGb, 0);
			return `$(server-process) Cluster: ${totalVram}GB RAM (${workers.length + 1} Nodes)`;
		}
		return `$(chip) Local Hardware: ${host?.vramGb || 0}GB RAM`;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready": {
					this._postState();
					break;
				}
				case "refreshHardware": {
					await this._refreshHardwareInfo();
					break;
				}
				case "pairNewWorker": {
					const ip = await vscode.window.showInputBox({
						prompt: "Enter LAN IP address of Nitro 5 or worker device (e.g. 192.168.1.150)",
						placeHolder: "192.168.1.xxx",
					});
					if (ip && ip.trim()) {
						await this._addWorkerNode(ip.trim());
					}
					break;
				}
				case "removeWorker": {
					if (typeof msg.nodeId === "string") {
						this._removeWorkerNode(msg.nodeId);
					}
					break;
				}
				case "setBackend": {
					this._state.backend = msg.backend;
					this._saveAndNotify();
					break;
				}
			}
		});

		this._postState();
	}

	private async _refreshHardwareInfo(): Promise<void> {
		const hostIp = this._getLocalLanIp();
		const realCpuThreads = os.cpus()?.length || 8;
		const realRamGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));

		const hostNode = this._state.nodes.find((n) => n.role === "host");
		if (hostNode) {
			hostNode.ip = hostIp;
			hostNode.vramGb = realRamGb;
			hostNode.cpuThreads = realCpuThreads;
		}
		this._state.hostIp = hostIp;
		this._state.hostVramGb = realRamGb;
		this._state.hostThreads = realCpuThreads;

		for (const worker of this._state.nodes.filter((n) => n.role === "worker")) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 2000);
				const resp = await fetch(`http://${worker.ip}:11434/api/tags`, {
					signal: controller.signal,
				});
				clearTimeout(timer);
				if (resp.ok) {
					const data = (await resp.json()) as { models?: Array<{ name: string }> };
					worker.status = "paired";
					worker.installedModels = (data.models || []).map((m) => m.name);
					worker.gpuName = `${worker.installedModels.length} models ready`;
				} else {
					worker.status = "unverified";
				}
			} catch {
				worker.status = "unverified";
			}
		}

		this._saveAndNotify();
		vscode.window.showInformationMessage("Hardware and worker nodes refreshed.");
	}

	private async _addWorkerNode(rawIp: string): Promise<void> {
		const ip = rawIp.replace(/^https?:\/\//, "").replace(/:11434\/?$/, "");
		const id = `node-worker-${Date.now()}`;
		let reachable = false;
		let discoveredModels: string[] = [];

		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 2500);
			const resp = await fetch(`http://${ip}:11434/api/tags`, {
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (resp.ok) {
				reachable = true;
				const data = (await resp.json()) as { models?: Array<{ name: string }> };
				discoveredModels = (data.models || []).map((m) => m.name);
			}
		} catch {
			reachable = false;
		}

		const newWorker: ClusterNode = {
			id,
			name: `LAN Worker (${ip})`,
			role: "worker",
			ip,
			gpuName: reachable
				? `${discoveredModels.length} model(s) installed`
				: "Endpoint Unreachable (Ollama offline or firewall active)",
			vramGb: 0,
			cpuThreads: 0,
			status: reachable ? "paired" : "unverified",
			installedModels: discoveredModels,
		};

		this._state.nodes = this._state.nodes.filter((n) => n.ip !== ip);
		this._state.nodes.push(newWorker);
		this._saveAndNotify();

		if (reachable) {
			vscode.window.showInformationMessage(
				`✓ Connected to Nitro 5 / LAN worker at ${ip}. Discovered ${discoveredModels.length} model(s). Available in Model Picker.`,
			);
		} else {
			vscode.window.showWarningMessage(
				`Could not reach Ollama at http://${ip}:11434. Make sure 'OLLAMA_HOST=0.0.0.0:11434 ollama serve' is running on your Nitro 5.`,
			);
		}
	}

	private _removeWorkerNode(nodeId: string): void {
		const node = this._state.nodes.find((n) => n.id === nodeId);
		if (node && node.role === "worker") {
			this._state.nodes = this._state.nodes.filter((n) => n.id !== nodeId);
			this._saveAndNotify();
			vscode.window.showInformationMessage(`Worker node removed: ${node.name}`);
		}
	}

	private _saveAndNotify(): void {
		const workers = this._state.nodes.filter((n) => n.role === "worker");
		void this._context.globalState.update(
			"omen.cluster.savedNodes",
			workers,
		);
		this._postState();
		this._onDidChangeState.fire(this._state);
	}

	private _postState(): void {
		if (this._view) {
			void this._view.webview.postMessage({
				type: "state",
				state: this._state,
			});
		}
	}

	private _getLocalLanIp(): string {
		const ifaces = os.networkInterfaces();
		for (const name of Object.keys(ifaces)) {
			for (const iface of ifaces[name] || []) {
				if (!iface.internal && iface.family === "IPv4") {
					return iface.address;
				}
			}
		}
		return "127.0.0.1";
	}

	public dispose(): void {
		if (this._server) {
			this._server.close();
		}
	}

	private _getHtml(): string {
		const nonce = crypto.randomBytes(16).toString("base64");

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	:root {
		--bg: #161616;
		--card-bg: #1C1C1C;
		--border: #262626;
		--fg: #E6E6E6;
		--muted: #858585;
		--accent-blue: #007acc;
		--green: #27C93F;
		--amber: #FFBD2E;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 11.5px;
		color: var(--fg);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		gap: 10px;
		user-select: none;
	}
	.header-section {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}
	.title {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--muted);
	}
	.btn-action {
		background: #242424;
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 11px;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.btn-action:hover {
		background: #2e2e2e;
		color: #FFF;
	}
	.card {
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.node-item {
		background: #212121;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.node-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.node-name {
		font-weight: 600;
		color: #EDEDED;
	}
	.status-badge {
		font-size: 9.5px;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(39, 201, 63, 0.15);
		color: var(--green);
		border: 1px solid rgba(39, 201, 63, 0.3);
	}
	.status-unverified {
		font-size: 9.5px;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(255, 189, 46, 0.15);
		color: var(--amber);
		border: 1px solid rgba(255, 189, 46, 0.3);
	}
	.node-details {
		font-size: 10.5px;
		color: var(--muted);
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.empty-hint {
		color: var(--muted);
		font-size: 11px;
		text-align: center;
		padding: 12px 0;
		line-height: 1.4;
	}
</style>
</head>
<body>
	<div class="header-section">
		<span class="title">Connected Hardware</span>
		<button class="btn-action" data-action="refreshHardware">⟳ Refresh</button>
	</div>

	<div class="card">
		<span style="font-weight: 600; font-size: 11px; color: var(--muted);">HOST SYSTEM</span>
		<div id="hostNodeContainer"></div>
	</div>

	<div class="header-section" style="margin-top: 4px;">
		<span class="title">LAN Worker Nodes</span>
		<button class="btn-action" data-action="pairWorker">+ Pair Worker</button>
	</div>

	<div id="workerList" style="display: flex; flex-direction: column; gap: 6px;"></div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();

	function escapeHtml(str) {
		if (!str) return '';
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			render(msg.state);
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		const nodeId = actionEl.getAttribute('data-node-id');

		if (action === 'refreshHardware') {
			vscode.postMessage({ type: 'refreshHardware' });
		} else if (action === 'pairWorker') {
			vscode.postMessage({ type: 'pairNewWorker' });
		} else if (action === 'removeWorker' && nodeId) {
			vscode.postMessage({ type: 'removeWorker', nodeId });
		}
	});

	function render(state) {
		const hostContainer = document.getElementById('hostNodeContainer');
		const workerList = document.getElementById('workerList');

		const host = state.nodes.find(n => n.role === 'host');
		if (host) {
			hostContainer.innerHTML = \`
				<div class="node-item">
					<div class="node-top">
						<span class="node-name">\${escapeHtml(host.name)}</span>
						<span class="status-badge">ONLINE</span>
					</div>
					<div class="node-details">
						<span>IP: \${escapeHtml(host.ip)}</span>
						<span>RAM: \${Number(host.vramGb)} GB</span>
						<span>Threads: \${Number(host.cpuThreads)}</span>
					</div>
				</div>
			\`;
		}

		const workers = state.nodes.filter(n => n.role === 'worker');
		if (workers.length === 0) {
			workerList.innerHTML = '<div class="empty-hint">No external LAN workers connected.<br>Click "+ Pair Worker" to connect your Nitro 5.</div>';
		} else {
			workerList.innerHTML = workers.map(w => {
				const badgeClass = w.status === 'paired' ? 'status-badge' : 'status-unverified';
				const badgeText = w.status === 'paired' ? 'VERIFIED' : 'UNVERIFIED';
				const modelsCount = w.installedModels ? w.installedModels.length : 0;
				const specsText = w.status === 'paired'
					? \`<span>Models: \${modelsCount} ready</span>\`
					: \`<span>\${escapeHtml(w.gpuName)}</span>\`;
				return \`
					<div class="node-item">
						<div class="node-top">
							<span class="node-name">\${escapeHtml(w.name)}</span>
							<div style="display: flex; gap: 6px; align-items: center;">
								<span class="\${badgeClass}">\${badgeText}</span>
								<button class="btn-action" style="padding: 1px 6px; font-size: 10px;" data-action="removeWorker" data-node-id="\${escapeHtml(w.id)}">✕</button>
							</div>
						</div>
						<div class="node-details">
							<span>IP: \${escapeHtml(w.ip)}:11434</span>
							\${specsText}
						</div>
					</div>
				\`;
			}).join('');
		}
	}

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
