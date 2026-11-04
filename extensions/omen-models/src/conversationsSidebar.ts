/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import * as crypto from "crypto";
import { AgentDiffManager } from "./agentDiffManager.js";
import { SecretManager } from "./secretManager.js";

export class OmenConversationsSidebarProvider
	implements vscode.WebviewViewProvider
{
	public static readonly viewType = "omen.conversationsView";
	private _view?: vscode.WebviewView;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _diffManager: AgentDiffManager,
		private readonly _secretManager?: SecretManager,
	) {
		void this._context;
		void this._secretManager;
		this._diffManager.onDidUpdateSessions(() => {
			void this._postState();
		});
		this._diffManager.onDidChangeSelectedModel(() => {
			void this._postState();
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
					await this._postState();
					break;
				}
				case "newConversation": {
					this._diffManager.selectSession("");
					await vscode.commands.executeCommand("omen.openAgentHub");
					void this._postState();
					break;
				}
				case "selectConversation": {
					if (typeof msg.sessionId === "string") {
						this._diffManager.selectSession(msg.sessionId);
						await vscode.commands.executeCommand("omen.openAgentHub");
						void this._postState();
					}
					break;
				}
				case "deleteConversation": {
					if (typeof msg.sessionId === "string") {
						this._diffManager.deleteSession(msg.sessionId);
					}
					break;
				}
				case "openClusterHub": {
					await vscode.commands.executeCommand("omen.openClusterHub");
					break;
				}
				case "openDocsHub": {
					await vscode.commands.executeCommand("omen.openDocsHub");
					break;
				}
				case "openSettings": {
					await vscode.commands.executeCommand("omen.openSettingsHub");
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

		void this._postState();
	}

	private async _postState(): Promise<void> {
		if (!this._view) {
			return;
		}
		const workspaceName =
			vscode.workspace.workspaceFolders?.[0]?.name || "omen";

		void this._view.webview.postMessage({
			type: "state",
			sessions: this._diffManager.sessions,
			selectedSessionId: this._diffManager.selectedSession?.id || null,
			workspaceName,
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
		/* Backgrounds (3 levels only) */
		--bg-app:      #0f0f10;
		--bg-sidebar:  #141415;
		--bg-elevated: #1a1a1c;

		/* Borders: nearly invisible */
		--border:      rgba(255,255,255,0.06);
		--border-focus: rgba(255,255,255,0.16);

		/* Text */
		--text-primary:   rgba(255,255,255,0.92);
		--text-secondary: rgba(255,255,255,0.55);
		--text-tertiary:  rgba(255,255,255,0.35);

		/* One accent, used sparingly */
		--accent: #4f8cff;

		/* Shape and type */
		--radius-sm: 6px;
		--radius-md: 8px;
		--radius-lg: 12px;
		--font-ui: Inter, -apple-system, sans-serif;
		--font-code: "JetBrains Mono", "SF Mono", monospace;
	}
	* {
		box-sizing: border-box;
	}
	html, body {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		font-family: var(--font-ui);
		font-size: 13px;
		color: var(--text-primary);
		background: var(--bg-sidebar);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		user-select: none;
		-webkit-font-smoothing: antialiased;
	}

	/* Top New Chat Button (30px height, modern spring transition) */
	.top-cta-wrap {
		padding: 8px 8px 4px 8px;
		flex-shrink: 0;
	}
	.btn-new-chat {
		width: 100%;
		height: 30px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-primary);
		padding: 0 10px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: space-between;
		transition: background 160ms cubic-bezier(0.22, 1, 0.36, 1),
			border-color 160ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 120ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.btn-new-chat:hover {
		border-color: var(--border-focus);
	}
	.btn-new-chat:active {
		transform: scale(0.985);
	}
	.new-shortcut {
		font-size: 11px;
		color: var(--text-tertiary);
		font-weight: 400;
	}

	/* Primary Navigation Rows (30px rows, zero icons) */
	.nav-section {
		padding: 2px 8px 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.sidebar-row {
		height: 30px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--text-secondary);
		font-size: 13px;
		cursor: pointer;
		position: relative;
		transition: background 150ms cubic-bezier(0.22, 1, 0.36, 1),
			color 150ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 150ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.sidebar-row:hover {
		background: var(--bg-elevated);
		color: var(--text-primary);
	}
	.sidebar-row.selected {
		background: var(--bg-elevated);
		color: var(--text-primary);
	}
	.sidebar-row.selected::before {
		content: "";
		position: absolute;
		left: 0;
		top: 7px;
		bottom: 7px;
		width: 2px;
		border-radius: 2px;
		background: var(--accent);
	}

	/* Scrollable Date-Grouped Thread List */
	.threads-scroll {
		flex: 1;
		overflow-y: auto;
		padding: 8px 8px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.threads-scroll::-webkit-scrollbar {
		width: 4px;
	}
	.threads-scroll::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.08);
		border-radius: 4px;
	}

	.date-group {
		display: flex;
		flex-direction: column;
		gap: 1px;
		animation: fadeIn 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.date-header {
		height: 24px;
		padding: 0 10px;
		display: flex;
		align-items: center;
		font-size: 11px;
		font-weight: 500;
		color: var(--text-tertiary);
		letter-spacing: 0.01em;
	}
	.row-title {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}
	.row-meta {
		font-size: 11px;
		color: var(--text-tertiary);
		flex-shrink: 0;
	}
	.btn-delete {
		display: none;
		background: transparent;
		border: none;
		color: var(--text-tertiary);
		font-family: var(--font-ui);
		font-size: 12px;
		cursor: pointer;
		padding: 0 4px;
		line-height: 1;
		border-radius: 4px;
		transition: color 120ms ease;
	}
	.btn-delete:hover {
		color: var(--text-primary);
	}
	.sidebar-row:hover .btn-delete {
		display: inline-block;
	}
	.sidebar-row:hover .row-meta {
		display: none;
	}

	.empty-state {
		padding: 8px 10px;
		font-size: 12px;
		color: var(--text-tertiary);
	}

	/* Bottom Settings Footer (30px row, zero icons) */
	.sidebar-footer {
		padding: 6px 8px;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(2px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
</head>
<body>
	<div class="top-cta-wrap">
		<button class="btn-new-chat" data-action="newConversation">
			<span>New Chat</span>
			<span class="new-shortcut">Cmd+N</span>
		</button>
	</div>

	<div class="nav-section">
		<div class="sidebar-row" data-action="openDocsHub">
			<span class="row-title">Docs &amp; RAG</span>
		</div>
		<div class="sidebar-row" data-action="openClusterHub">
			<span class="row-title">LAN Compute</span>
		</div>
	</div>

	<div id="threadsContainer" class="threads-scroll"></div>

	<div class="sidebar-footer">
		<div class="sidebar-row" data-action="openSettings">
			<span class="row-title">Settings</span>
			<span class="row-meta">API Keys</span>
		</div>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();

	let state = {
		sessions: [],
		selectedSessionId: null,
		workspaceName: 'omen',
	};

	function escapeHtml(str) {
		if (!str) return '';
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function getDateBucket(session) {
		const ts = session.createdAt || Date.now();
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const startOfYesterday = startOfToday - 86400000;
		const startOfWeek = startOfToday - 7 * 86400000;

		if (ts >= startOfToday) return 'Today';
		if (ts >= startOfYesterday) return 'Yesterday';
		if (ts >= startOfWeek) return 'Previous 7 Days';
		return 'Older';
	}

	function formatShortTime(session) {
		if (session.status === 'running') return 'Running';
		if (!session.createdAt) return session.timestamp || 'now';
		const diffSec = Math.max(1, Math.floor((Date.now() - session.createdAt) / 1000));
		if (diffSec < 60) return 'now';
		const diffMin = Math.floor(diffSec / 60);
		if (diffMin < 60) return diffMin + 'm';
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return diffHr + 'h';
		const diffDays = Math.floor(diffHr / 24);
		return diffDays + 'd';
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			state.sessions = msg.sessions || [];
			state.selectedSessionId = msg.selectedSessionId || null;
			if (msg.workspaceName) state.workspaceName = msg.workspaceName;
			render();
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		const sessionId = actionEl.getAttribute('data-session-id');

		switch (action) {
			case 'newConversation':
				vscode.postMessage({ type: 'newConversation' });
				break;
			case 'selectConversation':
				if (sessionId) {
					vscode.postMessage({ type: 'selectConversation', sessionId });
				}
				break;
			case 'deleteConversation':
				e.stopPropagation();
				if (sessionId) {
					vscode.postMessage({ type: 'deleteConversation', sessionId });
				}
				break;
			case 'openClusterHub':
				vscode.postMessage({ type: 'openClusterHub' });
				break;
			case 'openDocsHub':
				vscode.postMessage({ type: 'openDocsHub' });
				break;
			case 'openSettings':
				vscode.postMessage({ type: 'openSettings' });
				break;
		}
	});

	function render() {
		const container = document.getElementById('threadsContainer');
		if (!state.sessions || state.sessions.length === 0) {
			container.innerHTML = \`
				<div class="date-group">
					<div class="date-header">Today</div>
					<div class="empty-state">No conversations yet</div>
				</div>
			\`;
			return;
		}

		const bucketOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Older'];
		const buckets = new Map();
		for (const b of bucketOrder) {
			buckets.set(b, []);
		}

		for (const s of state.sessions) {
			const bucket = getDateBucket(s);
			buckets.get(bucket).push(s);
		}

		let html = '';
		for (const bucketName of bucketOrder) {
			const list = buckets.get(bucketName);
			if (!list || list.length === 0) continue;

			html += \`<div class="date-group"><div class="date-header">\${escapeHtml(bucketName)}</div>\`;
			for (const s of list) {
				const isSelected = s.id === state.selectedSessionId;
				const timeStr = formatShortTime(s);
				html += \`
					<div class="sidebar-row \${isSelected ? 'selected' : ''}" data-action="selectConversation" data-session-id="\${escapeHtml(s.id)}">
						<span class="row-title">\${escapeHtml(s.title)}</span>
						<span class="row-meta">\${escapeHtml(timeStr)}</span>
						<button class="btn-delete" data-action="deleteConversation" data-session-id="\${escapeHtml(s.id)}" title="Delete">Delete</button>
					</div>
				\`;
			}
			html += \`</div>\`;
		}

		container.innerHTML = html;
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
