/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import * as os from "os";
import * as http from "http";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { LlamaCppManager } from "./llamacppManager.js";

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

export interface LlamaCppClusterStatus {
	running: boolean;
	baseUrl: string;
	modelPath: string;
	rpcServers: string;
	models: string[];
	lastError?: string;
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
	llamacpp: LlamaCppClusterStatus;
}

export class OmenClusterViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = "omen.clusterView";
	private _view?: vscode.WebviewView;
	private _server?: http.Server;
	private _state: ClusterState;
	private _llamacpp?: LlamaCppManager;

	public setLlamaCppManager(manager: LlamaCppManager): void {
		this._llamacpp = manager;
		void this.refreshLlamaCppStatus();
	}

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

		const llamacppConfig = LlamaCppManager.getConfig();
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
			llamacpp: {
				running: false,
				baseUrl: llamacppConfig.baseUrl,
				modelPath: llamacppConfig.modelPath,
				rpcServers: llamacppConfig.rpcServers,
				models: [],
			},
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

	public getActiveWorker():
		| {
				name: string;
				ip: string;
				port: number;
				gpuName: string;
				models: string[];
				online: boolean;
		  }
		| undefined {
		const worker = this.getVerifiedWorkerNodes()[0];
		if (!worker) {
			return undefined;
		}
		return {
			name: worker.name,
			ip: worker.ip,
			port: 11434,
			gpuName: worker.gpuName,
			models:
				worker.installedModels && worker.installedModels.length > 0
					? worker.installedModels
					: ["qwen2.5-coder:7b"],
			online: worker.status === "paired" || worker.status === "online",
		};
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
					void this.refreshLlamaCppStatus();
					break;
				}
				case "refreshHardware": {
					await this.refreshHardware();
					break;
				}
				case "llamacppStart": {
					await vscode.commands.executeCommand("omen.llamacpp.start");
					await this.refreshLlamaCppStatus();
					break;
				}
				case "llamacppStop": {
					await vscode.commands.executeCommand("omen.llamacpp.stop");
					await this.refreshLlamaCppStatus();
					break;
				}
				case "llamacppSetModel": {
					await vscode.commands.executeCommand("omen.llamacpp.setModel");
					await this.refreshLlamaCppStatus();
					break;
				}
				case "llamacppSetWorker": {
					const worker = typeof msg.worker === "string" ? msg.worker.trim() : "";
					await vscode.workspace
						.getConfiguration("omen.providers.llamacpp")
						.update("rpcServers", worker, vscode.ConfigurationTarget.Global);
					await this.refreshLlamaCppStatus();
					break;
				}
				case "pairNewWorker": {
					await this.pairWorker();
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
				case "backToChat": {
					await vscode.commands.executeCommand("omen.openAgentHub");
					break;
				}
				case "toggleSidebar": {
					await vscode.commands.executeCommand(
						"workbench.action.toggleSidebarVisibility",
					);
					break;
				}
			}
		});

		this._postState();
	}

	public async refreshLlamaCppStatus(): Promise<void> {
		const config = LlamaCppManager.getConfig();
		let running = this._llamacpp?.isRunning() ?? false;
		let models: string[] = [];
		let lastError: string | undefined;
		try {
			if (this._llamacpp) {
				const status = await this._llamacpp.getStatus();
				running = status.running;
				models = status.models;
				lastError = status.lastError;
			} else {
				models = await LlamaCppManager.fetchModels(config.baseUrl);
				running = models.length > 0;
			}
		} catch {
			// Keep cached values
		}
		this._state.llamacpp = {
			running,
			baseUrl: config.baseUrl,
			modelPath: config.modelPath,
			rpcServers: config.rpcServers,
			models,
			lastError,
		};
		this._saveAndNotify();
	}

	/** Re-reads host hardware and re-probes every paired worker. Bound to the view title `refresh` action. */
	public async refreshHardware(): Promise<void> {
		this._postBusy(true);
		try {
			await this._refreshHardwareInfo();
			await this.refreshLlamaCppStatus();
		} finally {
			this._postBusy(false);
		}
	}

	/** Prompts for a worker IP and pairs it. Bound to the view title `add` action. */
	public async pairWorker(): Promise<void> {
		const ip = await vscode.window.showInputBox({
			title: "Pair LAN Worker",
			prompt: "Enter the LAN IP address of a machine running Ollama",
			placeHolder: "192.168.1.150",
			ignoreFocusOut: true,
		});
		if (ip && ip.trim()) {
			this._postBusy(true);
			try {
				await this._addWorkerNode(ip.trim());
			} finally {
				this._postBusy(false);
			}
		}
	}

	private _postBusy(busy: boolean): void {
		if (this._view) {
			void this._view.webview.postMessage({ type: "busy", busy });
		}
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
				`Connected to LAN worker at ${ip}. Discovered ${discoveredModels.length} model(s), now available in the model picker.`,
			);
		} else {
			vscode.window.showWarningMessage(
				`Could not reach Ollama at http://${ip}:11434. Make sure 'OLLAMA_HOST=0.0.0.0:11434 ollama serve' is running on the worker.`,
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
		/* Derive every color from the active theme so the view matches the workbench */
		--fg: var(--vscode-foreground, #cccccc);
		--muted: var(--vscode-descriptionForeground, rgba(204,204,204,0.6));
		--surface: color-mix(in srgb, var(--fg) 4%, transparent);
		--surface-hover: color-mix(in srgb, var(--fg) 7%, transparent);
		--border: color-mix(in srgb, var(--fg) 9%, transparent);
		--accent: var(--vscode-button-background, #4f8cff);
		--accent-fg: var(--vscode-button-foreground, #ffffff);
		--accent-hover: var(--vscode-button-hoverBackground, #3d7bf0);
		--ok: var(--vscode-testing-iconPassed, #3fb950);
		--warn: var(--vscode-editorWarning-foreground, #d29922);
		--focus: var(--vscode-focusBorder, #4f8cff);
		--mono: var(--vscode-editor-font-family, "SF Mono", Menlo, monospace);
		--radius: 8px;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px 10px 14px;
		font-family: var(--vscode-font-family, -apple-system, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--fg);
		display: flex;
		flex-direction: column;
		gap: 11px;
		user-select: none;
		-webkit-font-smoothing: antialiased;
	}
	body::-webkit-scrollbar { width: 4px; }
	body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 4px; }
	svg { width: 16px; height: 16px; flex-shrink: 0; }

	/* Summary tiles */
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 5px;
	}
	.stat {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 6px 8px;
		min-width: 0;
	}
	.stat-value {
		font-size: 15px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}
	.stat-value small { font-size: 10.5px; font-weight: 500; color: var(--muted); margin-left: 2px; }
	.stat-label { font-size: 10.5px; color: var(--muted); margin-top: 2px; }

	/* Sections */
	.section { display: flex; flex-direction: column; gap: 6px; }
	.section-head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 20px;
	}
	.section-title {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.count {
		font-size: 10px;
		font-weight: 600;
		min-width: 16px;
		padding: 0 5px;
		line-height: 15px;
		text-align: center;
		border-radius: 999px;
		background: var(--vscode-badge-background, var(--surface-hover));
		color: var(--vscode-badge-foreground, var(--fg));
	}
	.spacer { flex: 1; }

	/* Node rows */
	.list { display: flex; flex-direction: column; gap: 6px; }
	.node {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		column-gap: 8px;
		row-gap: 6px;
		align-items: center;
		padding: 8px 10px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		transition: background 120ms ease, border-color 120ms ease;
	}
	.node:hover { background: var(--surface-hover); }
	.node-icon {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.node-icon.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
	.node-text { min-width: 0; }
	.node-name {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.node-name span { overflow: hidden; text-overflow: ellipsis; }
	.tag {
		font-size: 10px;
		font-weight: 600;
		padding: 0 5px;
		line-height: 15px;
		border-radius: 4px;
		color: var(--muted);
		border: 1px solid var(--border);
		flex-shrink: 0;
	}
	.node-sub {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
		margin-top: 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.node-trail { display: flex; align-items: center; gap: 2px; }
	.meta {
		grid-column: 2 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.chip {
		font-size: 10.5px;
		padding: 1px 6px;
		border-radius: 4px;
		color: var(--muted);
		background: var(--surface);
		border: 1px solid var(--border);
		white-space: nowrap;
	}

	/* Status pill */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10.5px;
		font-weight: 500;
		padding: 1px 7px 1px 6px;
		border-radius: 999px;
		color: var(--ok);
		background: color-mix(in srgb, var(--ok) 12%, transparent);
		white-space: nowrap;
	}
	.pill::before {
		content: "";
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 25%, transparent);
	}
	.pill.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }

	/* Buttons */
	.icon-btn {
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--surface-hover)); color: var(--fg); }
	.node .icon-btn.reveal { opacity: 0; transition: opacity 120ms ease; }
	.node:hover .icon-btn.reveal, .node:focus-within .icon-btn.reveal { opacity: 1; }
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		padding: 4px 10px;
		border: 0;
		border-radius: 5px;
		background: var(--accent);
		color: var(--accent-fg);
		cursor: pointer;
	}
	.btn-primary:hover { background: var(--accent-hover); }
	.btn-primary svg { width: 14px; height: 14px; }
	button:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: inherit;
		font-size: 11.5px;
		font-weight: 500;
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface);
		color: var(--fg);
		cursor: pointer;
	}
	.btn-secondary:hover { background: var(--surface-hover); }
	.form-row { display: flex; gap: 6px; margin-top: 6px; }
	.text-input {
		flex: 1;
		min-width: 0;
		font-family: var(--mono);
		font-size: 11px;
		padding: 4px 8px;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--surface);
		color: var(--fg);
	}
	.text-input:focus { outline: 1px solid var(--focus); outline-offset: 0; border-color: var(--focus); }
	.hint { font-size: 11px; line-height: 1.4; color: var(--muted); }
	.btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

	/* Empty state */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 4px;
		padding: 12px 10px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
	}
	.empty-icon {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--muted);
		background: var(--surface-hover);
		margin-bottom: 2px;
	}
	.empty-title { font-size: 12px; font-weight: 600; }
	.empty-desc { font-size: 11px; line-height: 1.4; color: var(--muted); max-width: 220px; margin-bottom: 4px; }

	/* Busy indicator */
	.progress {
		position: fixed;
		top: 0; left: 0; right: 0;
		height: 2px;
		overflow: hidden;
		opacity: 0;
		transition: opacity 150ms ease;
	}
	.progress.active { opacity: 1; }
	.progress::after {
		content: "";
		position: absolute;
		inset: 0;
		width: 30%;
		background: var(--vscode-progressBar-background, var(--accent));
		animation: slide 1.1s ease-in-out infinite;
	}
	@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(400%); } }
	@media (prefers-reduced-motion: reduce) {
		.progress::after { animation: none; width: 100%; }
	}
</style>
</head>
<body>
	<div class="progress" id="progress" role="progressbar" aria-label="Working"></div>

	<div class="stats" id="stats"></div>

	<section class="section" aria-labelledby="hostTitle">
		<div class="section-head">
			<span class="section-title" id="hostTitle">This device</span>
		</div>
		<div class="list" id="hostNodeContainer"></div>
	</section>

	<section class="section" aria-labelledby="localTitle">
		<div class="section-head">
			<span class="section-title" id="localTitle">Local LLM</span>
			<span class="spacer"></span>
			<span id="llamacppPill"></span>
		</div>
		<div class="node">
			<div class="node-icon" id="llamacppIcon"></div>
			<div class="node-text">
				<div class="node-name"><span>llama-server</span></div>
				<div class="node-sub" id="llamacppBaseUrl"></div>
				<div class="hint" id="llamacppModel"></div>
			</div>
		</div>
		<div class="form-row">
			<input class="text-input" id="llamacppWorkerInput" placeholder="RPC worker 192.168.68.54:50052" aria-label="RPC worker address" />
			<button class="btn-secondary" data-action="llamacppSaveWorker">Save</button>
		</div>
		<div class="hint" id="llamacppStatus"></div>
		<div class="btn-row">
			<button class="btn-primary" data-action="llamacppStart">Start</button>
			<button class="btn-secondary" data-action="llamacppStop">Stop</button>
			<button class="btn-secondary" data-action="llamacppSetModel">Model file</button>
		</div>
	</section>

	<section class="section" aria-labelledby="workersTitle">
		<div class="section-head">
			<span class="section-title" id="workersTitle">LAN workers</span>
			<span class="count" id="workerCount">0</span>
			<span class="spacer"></span>
			<button class="icon-btn" data-action="pairWorker" title="Pair worker" aria-label="Pair worker">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>
			</button>
		</div>
		<div class="list" id="workerList"></div>
	</section>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();

	const ICONS = {
		chip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"/></svg>',
		server: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.75 4.75h.01M4.75 11.25h.01"/></svg>',
		close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
		network: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.8 7.1l4.4-2.2M5.8 8.9l4.4 2.2"/></svg>',
		plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>'
	};

	function escapeHtml(str) {
		if (str === undefined || str === null) return '';
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
		} else if (msg.type === 'busy') {
			document.getElementById('progress').classList.toggle('active', !!msg.busy);
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
		} else if (action === 'llamacppStart') {
			vscode.postMessage({ type: 'llamacppStart' });
		} else if (action === 'llamacppStop') {
			vscode.postMessage({ type: 'llamacppStop' });
		} else if (action === 'llamacppSetModel') {
			vscode.postMessage({ type: 'llamacppSetModel' });
		} else if (action === 'llamacppSaveWorker') {
			const input = document.getElementById('llamacppWorkerInput');
			vscode.postMessage({ type: 'llamacppSetWorker', worker: input ? input.value : '' });
		}
	});

	function stat(value, unit, label) {
		return '<div class="stat"><div class="stat-value">' + escapeHtml(value)
			+ (unit ? '<small>' + escapeHtml(unit) + '</small>' : '')
			+ '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
	}

	function render(state) {
		const host = state.nodes.find(n => n.role === 'host');
		const workers = state.nodes.filter(n => n.role === 'worker');
		const ready = workers.filter(w => w.status === 'paired');
		const llamacpp = state.llamacpp || { running: false, baseUrl: '', modelPath: '', rpcServers: '', models: [] };

		const pill = document.getElementById('llamacppPill');
		if (pill) {
			pill.innerHTML = '<span class="pill' + (llamacpp.running ? '' : ' warn') + '">' + (llamacpp.running ? 'Ready' : 'Stopped') + '</span>';
		}
		const icon = document.getElementById('llamacppIcon');
		if (icon) {
			icon.innerHTML = ICONS.server;
			if (!llamacpp.running) {
				icon.classList.add('warn');
			} else {
				icon.classList.remove('warn');
			}
		}
		const baseUrlEl = document.getElementById('llamacppBaseUrl');
		if (baseUrlEl) {
			baseUrlEl.textContent = llamacpp.baseUrl || 'http://127.0.0.1:8080';
		}
		const modelEl = document.getElementById('llamacppModel');
		if (modelEl) {
			const fileName = String(llamacpp.modelPath || '').split('/').pop() || 'No model selected';
			const modelNames = (llamacpp.models || []).slice(0, 2).join(', ');
			modelEl.textContent = llamacpp.modelPath ? fileName + (modelNames ? ' · ' + modelNames : '') : 'Select a .gguf file to start';
		}
		const workerInput = document.getElementById('llamacppWorkerInput');
		if (workerInput && document.activeElement !== workerInput) {
			workerInput.value = llamacpp.rpcServers || '';
		}
		const statusEl = document.getElementById('llamacppStatus');
		if (statusEl) {
			if (llamacpp.running) {
				statusEl.textContent = llamacpp.rpcServers ? 'Running with RPC worker ' + llamacpp.rpcServers : 'Running on this device';
			} else if (llamacpp.lastError) {
				statusEl.textContent = String(llamacpp.lastError).slice(0, 160);
			} else {
				statusEl.textContent = llamacpp.rpcServers ? 'Worker saved. Press Start.' : 'Optional: add an RPC worker, then press Start.';
			}
		}

		// Summary
		const totalMem = (host ? Number(host.vramGb) : 0) + ready.reduce((acc, w) => acc + Number(w.vramGb || 0), 0);
		const totalThreads = (host ? Number(host.cpuThreads) : 0) + ready.reduce((acc, w) => acc + Number(w.cpuThreads || 0), 0);
		document.getElementById('stats').innerHTML =
			stat(1 + ready.length, '', ready.length ? 'Nodes' : 'Node')
			+ stat(totalMem, 'GB', 'Memory')
			+ stat(totalThreads, '', 'Threads');

		// Host
		const hostContainer = document.getElementById('hostNodeContainer');
		if (host) {
			const hostName = String(host.name || '').replace(/\\s*\\(Host Device\\)\\s*$/, '');
			hostContainer.innerHTML = \`
				<div class="node">
					<div class="node-icon">\${ICONS.chip}</div>
					<div class="node-text">
						<div class="node-name"><span>\${escapeHtml(hostName)}</span><span class="tag">HOST</span></div>
						<div class="node-sub">\${escapeHtml(host.ip)}</div>
					</div>
					<div class="node-trail"><span class="pill">Online</span></div>
					<div class="meta">
						<span class="chip">\${Number(host.vramGb)} GB memory</span>
						<span class="chip">\${Number(host.cpuThreads)} threads</span>
					</div>
				</div>\`;
		}

		// Workers
		document.getElementById('workerCount').textContent = String(workers.length);
		const workerList = document.getElementById('workerList');
		if (workers.length === 0) {
			workerList.innerHTML = \`
				<div class="empty">
					<div class="empty-icon">\${ICONS.network}</div>
					<div class="empty-title">No workers paired</div>
					<div class="empty-desc">Pair another machine running Ollama to share models and compute over your LAN.</div>
					<button class="btn-primary" data-action="pairWorker">\${ICONS.plus}Pair worker</button>
				</div>\`;
			return;
		}

		workerList.innerHTML = workers.map(w => {
			const isReady = w.status === 'paired';
			const modelsCount = w.installedModels ? w.installedModels.length : 0;
			const models = (w.installedModels || []).slice(0, 3)
				.map(m => '<span class="chip">' + escapeHtml(m) + '</span>').join('');
			const more = modelsCount > 3 ? '<span class="chip">+' + (modelsCount - 3) + ' more</span>' : '';
			const meta = isReady
				? (modelsCount ? models + more : '<span class="chip">No models installed</span>')
				: '<span class="chip">Ollama unreachable</span>';
			return \`
				<div class="node">
					<div class="node-icon \${isReady ? '' : 'warn'}">\${ICONS.server}</div>
					<div class="node-text">
						<div class="node-name"><span>\${escapeHtml(w.name)}</span></div>
						<div class="node-sub">\${escapeHtml(w.ip)}:11434</div>
					</div>
					<div class="node-trail">
						<span class="pill \${isReady ? '' : 'warn'}">\${isReady ? 'Ready' : 'Offline'}</span>
						<button class="icon-btn reveal" data-action="removeWorker" data-node-id="\${escapeHtml(w.id)}" title="Remove worker" aria-label="Remove \${escapeHtml(w.name)}">\${ICONS.close}</button>
					</div>
					<div class="meta">\${meta}</div>
				</div>\`;
		}).join('');
	}

	window.addEventListener('keydown', e => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
			e.preventDefault();
			vscode.postMessage({ type: 'toggleSidebar' });
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
