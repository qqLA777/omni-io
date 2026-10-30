/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import { AgentDiffManager } from "./agentDiffManager.js";

export class OmenAgentsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.agentsView";
	private _view?: vscode.WebviewView;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _diffManager: AgentDiffManager,
	) {
		void this._context;
		this._diffManager.onDidUpdateSessions(() => {
			this._postState();
		});
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
				case "selectAgent": {
					this._diffManager.selectSession(msg.sessionId);
					const session = this._diffManager.sessions.find(
						(s) => s.id === msg.sessionId,
					);
					if (session && session.status !== "running") {
						await this._diffManager.showDiff(session);
					}
					break;
				}
				case "viewDiff": {
					const session = this._diffManager.sessions.find(
						(s) => s.id === msg.sessionId,
					);
					if (session) {
						await this._diffManager.showDiff(session);
					}
					break;
				}
				case "acceptDiff": {
					await this._diffManager.acceptSessionDiff(msg.sessionId);
					break;
				}
				case "rejectDiff": {
					await this._diffManager.rejectSessionDiff(msg.sessionId);
					break;
				}
				case "newAgentPrompt": {
					const activeDoc = vscode.window.activeTextEditor?.document;
					const fileName = activeDoc
						? activeDoc.uri.path.split("/").pop()
						: undefined;
					const prompt = await vscode.window.showInputBox({
						prompt: fileName
							? `Describe task for Agent on "${fileName}"`
							: "Describe the task for the Agent to execute on your code",
						placeHolder: fileName
							? `e.g. Refactor ${fileName} to add validation and clean typing`
							: "e.g. Refactor components/admin/admin-sidebar.tsx to add route guards",
					});
					if (prompt && prompt.trim()) {
						void this._diffManager.executeRealAgent(
							prompt.trim(),
							activeDoc?.uri,
						);
					}
					break;
				}
				case "runStarterTask": {
					if (msg.prompt) {
						const activeDoc = vscode.window.activeTextEditor?.document;
						void this._diffManager.executeRealAgent(
							msg.prompt,
							activeDoc?.uri,
						);
					}
					break;
				}
				case "loadDemo": {
					this._diffManager.loadDemoSession();
					break;
				}
				case "setApiKey": {
					await vscode.commands.executeCommand("omen.setApiKey");
					break;
				}
			}
		});

		this._postState();
	}

	private _postState(): void {
		if (!this._view) {
			return;
		}
		this._view.webview.postMessage({
			type: "state",
			sessions: this._diffManager.sessions,
			selectedSessionId: this._diffManager.selectedSession?.id,
		});
	}

	private _getHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
	:root {
		--bg: #161616;
		--card-bg: #1C1C1C;
		--card-active: #272727;
		--border: #222222;
		--border-focus: #3A3A3A;
		--fg: #E6E6E6;
		--muted: #858585;
		--btn-bg: #262626;
		--btn-border: #333333;
		--btn-hover: #303030;
		--green: #27C93F;
		--amber: #FFBD2E;
		--red: #FF5F56;
		--blue: #38BDF8;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 8px 10px;
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
		font-size: 11.5px;
		color: var(--fg);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		gap: 8px;
		user-select: none;
	}
	.header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}
	.header-title {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.badge-count {
		background: #272727;
		color: #EDEDED;
		padding: 1px 6px;
		border-radius: 10px;
		font-size: 10px;
		font-weight: 600;
	}
	.btn-new {
		background: var(--btn-bg);
		color: var(--fg);
		border: 1px solid var(--btn-border);
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 4px;
		transition: background 0.15s ease;
	}
	.btn-new:hover {
		background: var(--btn-hover);
		color: #FFF;
	}
	.session-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.session-card {
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 6px;
		transition: all 0.15s ease;
	}
	.session-card:hover {
		border-color: var(--border-focus);
		background: #202020;
	}
	.session-card.active {
		background: var(--card-active);
		border-color: #383838;
	}
	.session-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 6px;
	}
	.status-pill {
		font-size: 9.5px;
		font-weight: 700;
		padding: 2px 6px;
		border-radius: 4px;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}
	.status-running {
		background: rgba(56, 189, 248, 0.15);
		color: var(--blue);
		border: 1px solid rgba(56, 189, 248, 0.3);
		animation: pulse 1.5s infinite;
	}
	.status-review {
		background: rgba(255, 189, 46, 0.15);
		color: var(--amber);
		border: 1px solid rgba(255, 189, 46, 0.3);
	}
	.status-completed {
		background: rgba(39, 201, 63, 0.15);
		color: var(--green);
		border: 1px solid rgba(39, 201, 63, 0.3);
	}
	.status-rejected {
		background: rgba(133, 133, 133, 0.15);
		color: var(--muted);
		border: 1px solid rgba(133, 133, 133, 0.3);
	}
	.status-error {
		background: rgba(255, 95, 86, 0.15);
		color: var(--red);
		border: 1px solid rgba(255, 95, 86, 0.3);
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.55; }
	}
	.session-time {
		font-size: 10px;
		color: var(--muted);
	}
	.session-title {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--fg);
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.session-file-badge {
		font-family: monospace;
		font-size: 10px;
		color: #CFCFCF;
		background: rgba(0, 0, 0, 0.3);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 4px;
		padding: 3px 6px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.diff-stat {
		color: var(--green);
		font-weight: 600;
	}
	.session-actions {
		display: flex;
		gap: 4px;
		margin-top: 2px;
	}
	.btn-action {
		flex: 1;
		background: #242424;
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 6px;
		font-size: 10.5px;
		font-weight: 500;
		cursor: pointer;
		text-align: center;
		transition: background 0.15s ease;
	}
	.btn-action:hover:not(:disabled) {
		background: #2E2E2E;
		color: #FFF;
	}
	.btn-action:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.btn-accept {
		color: #4ADE80;
		border-color: rgba(39, 201, 63, 0.3);
	}
	.btn-accept:hover {
		background: rgba(39, 201, 63, 0.2);
	}
	.btn-reject {
		color: #F87171;
		border-color: rgba(255, 95, 86, 0.3);
	}
	.btn-reject:hover {
		background: rgba(255, 95, 86, 0.2);
	}
	.empty-box {
		background: #191919;
		border: 1px dashed var(--border-focus);
		border-radius: 6px;
		padding: 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.empty-title {
		font-weight: 600;
		font-size: 11px;
		color: var(--fg);
	}
	.empty-desc {
		color: var(--muted);
		font-size: 10.5px;
		line-height: 1.4;
	}
	.starter-task {
		background: #212121;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 6px 8px;
		color: #D4D4D4;
		font-size: 11px;
		cursor: pointer;
		display: flex;
		justify-content: space-between;
		align-items: center;
		transition: all 0.15s ease;
	}
	.starter-task:hover {
		background: #282828;
		border-color: #383838;
		color: #FFF;
	}
	.starter-task span:last-child {
		color: var(--muted);
		font-size: 12px;
	}
	.starter-demo {
		border-color: rgba(56, 189, 248, 0.3);
		color: #93C5FD;
	}
	.starter-demo:hover {
		background: rgba(56, 189, 248, 0.1);
	}
	.activity-section {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.activity-title {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--muted);
	}
	.activity-step {
		font-size: 10.5px;
		color: #CFCFCF;
		display: flex;
		gap: 6px;
		line-height: 1.35;
	}
	.step-time {
		color: var(--muted);
		font-family: monospace;
		font-size: 9.5px;
		flex-shrink: 0;
	}
	.step-error {
		color: var(--red);
	}
	.step-success {
		color: #4ADE80;
	}
</style>
</head>
<body>
	<div class="header">
		<div class="header-title">
			<span>Agents</span>
			<span id="agentCount" class="badge-count">0</span>
		</div>
		<button class="btn-new" onclick="newAgent()">+ New Agent</button>
	</div>

	<div id="sessionList" class="session-list"></div>

	<div id="starterBox" class="empty-box">
		<div class="empty-title">Starter Agent Actions</div>
		<div class="empty-desc">Click any task below to run a real agent on your active file:</div>
		<div class="starter-task" onclick="runStarter('Refactor current component to improve modularity and clean structure')">
			<span>Refactor active file</span>
			<span>→</span>
		</div>
		<div class="starter-task" onclick="runStarter('Add typed error handling, input validation, and guard clauses')">
			<span>Add validation & guards</span>
			<span>→</span>
		</div>
		<div class="starter-task" onclick="runStarter('Add TypeScript type definitions, strict interfaces, and docstrings')">
			<span>Type definitions & comments</span>
			<span>→</span>
		</div>
		<div class="starter-task starter-demo" onclick="loadDemo()">
			<span>Preview Demo Diff (Simulation)</span>
			<span>→</span>
		</div>
	</div>

	<div id="activityBox" class="activity-section" style="display: none;">
		<div class="activity-title">Selected Agent Activity</div>
		<div id="activitySteps"></div>
	</div>

<script>
	const vscode = acquireVsCodeApi();
	let state = { sessions: [], selectedSessionId: null };

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			state.sessions = msg.sessions || [];
			state.selectedSessionId = msg.selectedSessionId;
			render();
		}
	});

	function newAgent() {
		vscode.postMessage({ type: 'newAgentPrompt' });
	}

	function runStarter(prompt) {
		vscode.postMessage({ type: 'runStarterTask', prompt });
	}

	function loadDemo() {
		vscode.postMessage({ type: 'loadDemo' });
	}

	function setApiKey(e) {
		e.stopPropagation();
		vscode.postMessage({ type: 'setApiKey' });
	}

	function selectSession(sessionId) {
		vscode.postMessage({ type: 'selectAgent', sessionId });
	}

	function viewDiff(e, sessionId) {
		e.stopPropagation();
		vscode.postMessage({ type: 'viewDiff', sessionId });
	}

	function acceptDiff(e, sessionId) {
		e.stopPropagation();
		vscode.postMessage({ type: 'acceptDiff', sessionId });
	}

	function rejectDiff(e, sessionId) {
		e.stopPropagation();
		vscode.postMessage({ type: 'rejectDiff', sessionId });
	}

	function render() {
		const countEl = document.getElementById('agentCount');
		const listEl = document.getElementById('sessionList');
		const starterEl = document.getElementById('starterBox');
		const activityBox = document.getElementById('activityBox');
		const activitySteps = document.getElementById('activitySteps');

		countEl.textContent = state.sessions.length;

		if (state.sessions.length === 0) {
			listEl.innerHTML = '';
			starterEl.style.display = 'flex';
			activityBox.style.display = 'none';
			return;
		}

		starterEl.style.display = 'none';
		listEl.innerHTML = state.sessions.map(s => {
			const isActive = s.id === state.selectedSessionId ? 'active' : '';
			const firstFile = s.filesChanged[0];
			const fileName = firstFile ? firstFile.filePath.split('/').pop() : 'Files';
			const diffStat = firstFile && (firstFile.additions > 0 || firstFile.deletions > 0)
				? \`+\${firstFile.additions} -\${firstFile.deletions}\`
				: '';
			const statusClass = 'status-' + s.status;
			const statusLabel = s.status === 'running'
				? 'Running...'
				: s.status === 'review'
				? 'Review'
				: s.status === 'completed'
				? 'Done'
				: s.status === 'error'
				? 'Failed'
				: 'Discarded';

			let actionsHtml = '';
			if (s.status === 'running') {
				actionsHtml = \`
					<div class="session-actions">
						<button class="btn-action" disabled>⚡ Streaming Agent Diff...</button>
					</div>
				\`;
			} else if (s.status === 'review') {
				actionsHtml = \`
					<div class="session-actions">
						<button class="btn-action" onclick="viewDiff(event, '\${s.id}')">⎘ Diff</button>
						<button class="btn-action btn-accept" onclick="acceptDiff(event, '\${s.id}')">✓ Accept</button>
						<button class="btn-action btn-reject" onclick="rejectDiff(event, '\${s.id}')">✕ Reject</button>
					</div>
				\`;
			} else if (s.status === 'error') {
				actionsHtml = \`
					<div class="session-actions">
						<button class="btn-action btn-reject" onclick="setApiKey(event)">Set API Key</button>
					</div>
				\`;
			} else {
				actionsHtml = \`
					<div class="session-actions">
						<button class="btn-action" onclick="viewDiff(event, '\${s.id}')">⎘ View Diff</button>
					</div>
				\`;
			}

			return \`
				<div class="session-card \${isActive}" onclick="selectSession('\${s.id}')">
					<div class="session-top">
						<span class="status-pill \${statusClass}">\${statusLabel}</span>
						<span class="session-time">\${s.timestamp}</span>
					</div>
					<div class="session-title">\${s.title}</div>
					\${firstFile ? \`
						<div class="session-file-badge">
							<span>📄 \${fileName}</span>
							\${diffStat ? \`<span class="diff-stat">\${diffStat}</span>\` : ''}
						</div>
					\` : ''}
					\${actionsHtml}
				</div>
			\`;
		}).join('');

		const active = state.sessions.find(s => s.id === state.selectedSessionId) || state.sessions[0];
		if (active && active.activityLog && active.activityLog.length > 0) {
			activityBox.style.display = 'flex';
			activitySteps.innerHTML = active.activityLog.map(step => {
				const stepClass = step.kind === 'error' ? 'step-error' : step.kind === 'success' ? 'step-success' : '';
				return \`
					<div class="activity-step \${stepClass}">
						<span class="step-time">[\${step.time}]</span>
						<span>\${step.text}</span>
					</div>
				\`;
			}).join('');
		} else {
			activityBox.style.display = 'none';
		}
	}
</script>
</body>
</html>`;
	}
}
