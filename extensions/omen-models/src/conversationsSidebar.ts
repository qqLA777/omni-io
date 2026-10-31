/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as crypto from "crypto";
import { AgentDiffManager } from "./agentDiffManager.js";

export class OmenConversationsSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.conversationsView";
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
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready": {
					this._postState();
					break;
				}
				case "newConversation": {
					await vscode.commands.executeCommand("omen.openAgentHub");
					break;
				}
				case "selectConversation": {
					const session = this._diffManager.sessions.find(
						(s) => s.id === msg.sessionId,
					);
					if (session) {
						this._diffManager.selectSession(session.id);
						if (session.status !== "running") {
							await this._diffManager.showDiff(session);
						}
					}
					break;
				}
				case "openAutomations": {
					vscode.window.showInformationMessage(
						"Automations portal (No active cron jobs).",
					);
					break;
				}
				case "openCustomizations": {
					vscode.window.showInformationMessage(
						"Customizations portal (Open extensions/settings).",
					);
					break;
				}
				case "openSettings": {
					await vscode.commands.executeCommand("workbench.action.openSettings");
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
		void this._view.webview.postMessage({
			type: "state",
			sessions: this._diffManager.sessions,
			selectedSessionId: this._diffManager.selectedSession?.id,
		});
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
		--bg-sidebar: #1a1a1a;
		--btn-card: #222222;
		--btn-hover: #2a2a2a;
		--border-subtle: #2b2b2b;
		--fg-primary: #EDEDED;
		--fg-muted: #8E8E8E;
		--font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px 10px 4px 10px;
		font-family: var(--font);
		font-size: 11.5px;
		color: var(--fg-primary);
		background: var(--bg-sidebar);
		display: flex;
		flex-direction: column;
		height: 100vh;
		user-select: none;
	}
	.btn-new-conv {
		background: var(--btn-card);
		color: var(--fg-primary);
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		padding: 7px 10px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: all 0.15s ease;
	}
	.btn-new-conv:hover {
		background: var(--btn-hover);
		color: #FFF;
	}
	.nav-link {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 4px;
		color: #BDBDBD;
		cursor: pointer;
		margin-top: 4px;
		transition: background 0.12s ease;
	}
	.nav-link:hover {
		background: #242424;
		color: #FFF;
	}
	.section-divider {
		margin-top: 14px;
		margin-bottom: 6px;
		padding: 0 4px;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--fg-muted);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.thread-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		overflow-y: auto;
	}
	.thread-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 8px;
		border-radius: 4px;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.thread-item:hover, .thread-item.active {
		background: #242424;
	}
	.thread-title {
		font-size: 11.5px;
		color: #CCCCCC;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 140px;
	}
	.thread-item:hover .thread-title, .thread-item.active .thread-title {
		color: #FFF;
	}
	.thread-time {
		font-size: 10px;
		color: #707070;
		flex-shrink: 0;
	}
	.empty-hint {
		color: var(--fg-muted);
		font-size: 11px;
		text-align: center;
		padding: 24px 8px;
		line-height: 1.4;
	}
	.sidebar-footer {
		margin-top: auto;
		padding: 8px 4px 12px 4px;
		border-top: 1px solid var(--border-subtle);
		display: flex;
		align-items: center;
		gap: 6px;
		color: #8E8E8E;
		cursor: pointer;
	}
	.sidebar-footer:hover {
		color: #FFF;
	}
</style>
</head>
<body>
	<button class="btn-new-conv" data-action="newConversation">+ New Conversation</button>

	<div class="nav-link" data-action="openAutomations">
		<span>⏱</span>
		<span>Automations</span>
	</div>
	<div class="nav-link" data-action="openCustomizations">
		<span>🎛</span>
		<span>Customizations</span>
	</div>

	<div class="section-divider">
		<span>Conversations</span>
		<span id="convCount">0</span>
	</div>

	<div id="threadList" class="thread-list"></div>

	<div class="sidebar-footer" data-action="openSettings">
		<span>⚙</span>
		<span>Settings</span>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	let state = { sessions: [], selectedSessionId: null };

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
			state.sessions = msg.sessions || [];
			state.selectedSessionId = msg.selectedSessionId;
			render();
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		const sessionId = actionEl.getAttribute('data-session-id');

		if (action === 'newConversation') {
			vscode.postMessage({ type: 'newConversation' });
		} else if (action === 'openAutomations') {
			vscode.postMessage({ type: 'openAutomations' });
		} else if (action === 'openCustomizations') {
			vscode.postMessage({ type: 'openCustomizations' });
		} else if (action === 'openSettings') {
			vscode.postMessage({ type: 'openSettings' });
		} else if (action === 'selectConversation' && sessionId) {
			vscode.postMessage({ type: 'selectConversation', sessionId });
		}
	});

	function render() {
		const countEl = document.getElementById('convCount');
		const listEl = document.getElementById('threadList');

		countEl.textContent = String(state.sessions.length);

		if (state.sessions.length === 0) {
			listEl.innerHTML = '<div class="empty-hint">No active conversations.<br>Click <b>+ New Conversation</b> to open Agent Mode.</div>';
			return;
		}

		listEl.innerHTML = state.sessions.map(s => {
			const isActive = s.id === state.selectedSessionId ? 'active' : '';
			const safeId = escapeHtml(s.id);
			const safeTitle = escapeHtml(s.title);
			const safeTime = escapeHtml(s.timestamp);
			return \`
				<div class="thread-item \${isActive}" data-action="selectConversation" data-session-id="\${safeId}">
					<span class="thread-title">\${safeTitle}</span>
					<span class="thread-time">\${safeTime}</span>
				</div>
			\`;
		}).join('');
	}

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
