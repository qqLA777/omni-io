/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import { AgentDiffManager, SelectableModelOption } from "./agentDiffManager.js";
import { SecretManager } from "./secretManager.js";

export class AgentHubEditorProvider {
	public static readonly viewType = "omen.agentHub";
	private static _currentPanel: vscode.WebviewPanel | undefined;

	public static async createOrShow(
		_context: vscode.ExtensionContext,
		diffManager: AgentDiffManager,
		secretManager: SecretManager,
	): Promise<void> {
		void secretManager;
		const column = vscode.ViewColumn.One;

		if (AgentHubEditorProvider._currentPanel) {
			AgentHubEditorProvider._currentPanel.reveal(column);
			void AgentHubEditorProvider._postState(diffManager);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			AgentHubEditorProvider.viewType,
			"AI Chat",
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		AgentHubEditorProvider._currentPanel = panel;

		const sessionsSub = diffManager.onDidUpdateSessions(() => {
			void AgentHubEditorProvider._postState(diffManager);
		});

		const modelSub = diffManager.onDidChangeSelectedModel(() => {
			void AgentHubEditorProvider._postState(diffManager);
		});

		const activeEditorSub = vscode.window.onDidChangeActiveTextEditor(() => {
			void AgentHubEditorProvider._postState(diffManager);
		});

		panel.onDidDispose(() => {
			sessionsSub.dispose();
			modelSub.dispose();
			activeEditorSub.dispose();
			AgentHubEditorProvider._currentPanel = undefined;
		});

		panel.webview.html = AgentHubEditorProvider._getHtml();

		panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready": {
					await AgentHubEditorProvider._postState(diffManager);
					break;
				}
				case "submitPrompt": {
					if (
						msg.prompt &&
						typeof msg.prompt === "string" &&
						msg.prompt.trim()
					) {
						const activeDoc = vscode.window.activeTextEditor?.document;
						const modelId =
							typeof msg.modelId === "string" && msg.modelId
								? msg.modelId
								: undefined;
						void diffManager.executeRealAgent(
							msg.prompt.trim(),
							activeDoc?.uri,
							modelId,
						);
					}
					break;
				}
				case "newChat": {
					diffManager.selectSession("");
					void AgentHubEditorProvider._postState(diffManager);
					if (panel) {
						void panel.webview.postMessage({ type: "focusInput" });
					}
					break;
				}
				case "openDocsHub": {
					await vscode.commands.executeCommand("omen.openDocsHub");
					break;
				}
				case "openClusterHub": {
					await vscode.commands.executeCommand("omen.openClusterHub");
					break;
				}
				case "openSettingsHub": {
					await vscode.commands.executeCommand("omen.openSettingsHub");
					break;
				}
				case "openFileDiff": {
					const session = diffManager.sessions.find(
						(s) => s.id === msg.sessionId,
					);
					if (session) {
						const fileDiff =
							session.filesChanged.find((f) => f.filePath === msg.filePath) ??
							session.filesChanged[0];
						await diffManager.showDiff(
							session,
							fileDiff,
							vscode.ViewColumn.Beside,
						);
					}
					break;
				}
				case "acceptDiff": {
					if (typeof msg.sessionId === "string") {
						await diffManager.acceptSessionDiff(msg.sessionId);
					}
					break;
				}
				case "rejectDiff": {
					if (typeof msg.sessionId === "string") {
						await diffManager.rejectSessionDiff(msg.sessionId);
					}
					break;
				}
				case "cancelSession": {
					if (typeof msg.sessionId === "string") {
						diffManager.cancelSession(msg.sessionId);
					}
					break;
				}
				case "copyToClipboard": {
					if (typeof msg.text === "string") {
						await vscode.env.clipboard.writeText(msg.text);
					}
					break;
				}
				case "pickContextFile": {
					const files = await vscode.workspace.findFiles(
						"**/*.{ts,tsx,js,jsx,py,go,rs,json,md,css,html}",
						"{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}",
						60,
					);
					if (files.length === 0) {
						vscode.window.showInformationMessage("No workspace files found.");
						break;
					}
					const picked = await vscode.window.showQuickPick(
						files.map((f) => ({
							label: path.basename(f.fsPath),
							description: vscode.workspace.asRelativePath(f),
							uri: f,
						})),
						{ placeHolder: "Attach codebase file (@file)" },
					);
					if (picked && panel) {
						void panel.webview.postMessage({
							type: "addContextChip",
							relativePath: picked.description,
							fileName: picked.label,
						});
					}
					break;
				}
				case "pickModel": {
					const models = await diffManager.getAvailableModels();
					const current = await diffManager.getSelectedModelOption();
					const items: Array<
						vscode.QuickPickItem & { modelOption?: SelectableModelOption }
					> = models.map((m) => ({
						label: m.id === current.id ? `${m.name} (Active)` : m.name,
						description: `${m.provider.toUpperCase()} (${m.id})`,
						detail: m.baseUrl,
						modelOption: m,
					}));
					items.push(
						{
							label: "",
							kind: vscode.QuickPickItemKind.Separator,
						},
						{
							label: "Settings & External API Keys...",
							description:
								"Configure Meta Muse, Gemini, Claude, OpenAI, DeepSeek, or OpenRouter keys",
						},
						{
							label: "LAN Compute Cluster...",
							description: "Pair LAN GPU worker or local Ollama",
						},
						{
							label: "Docs & Local RAG...",
							description: "Open Documentation Reader & Local Vector DB",
						},
					);

					const picked = await vscode.window.showQuickPick(items, {
						placeHolder: "Select Active AI Model (Cloud, Local, or LAN Cluster)",
					});
					if (!picked) {
						break;
					}
					if (picked.modelOption) {
						await diffManager.setSelectedModelId(picked.modelOption.id);
					} else if (picked.label.includes("Settings")) {
						await vscode.commands.executeCommand("omen.openSettingsHub");
					} else if (picked.label.includes("Cluster")) {
						await vscode.commands.executeCommand("omen.openClusterHub");
					} else if (picked.label.includes("RAG")) {
						await vscode.commands.executeCommand("omen.openDocsHub");
					}
					break;
				}
			}
		});

		void AgentHubEditorProvider._postState(diffManager);
	}

	private static async _postState(diffManager: AgentDiffManager): Promise<void> {
		if (!AgentHubEditorProvider._currentPanel) {
			return;
		}
		const selectedModel: SelectableModelOption =
			await diffManager.getSelectedModelOption();
		const workspaceName =
			vscode.workspace.workspaceFolders?.[0]?.name || "omen";
		const activeDoc = vscode.window.activeTextEditor?.document;
		const activeFile =
			activeDoc && activeDoc.uri.scheme === "file"
				? {
						fileName: path.basename(activeDoc.uri.fsPath),
						relativePath: vscode.workspace.asRelativePath(activeDoc.uri),
				  }
				: null;

		if (AgentHubEditorProvider._currentPanel) {
			AgentHubEditorProvider._currentPanel.title =
				diffManager.selectedSession?.title || "AI Chat";
		}

		void AgentHubEditorProvider._currentPanel.webview.postMessage({
			type: "state",
			sessions: diffManager.sessions,
			selectedSessionId: diffManager.selectedSession?.id || null,
			selectedModel,
			workspaceName,
			activeFile,
		});
	}

	private static _getHtml(): string {
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
		line-height: 1.55;
		color: var(--text-primary);
		background: var(--bg-app);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		-webkit-font-smoothing: antialiased;
	}

	/* Scrollable Viewport */
	.chat-viewport {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 24px 20px 16px 20px;
	}
	.chat-viewport::-webkit-scrollbar {
		width: 5px;
	}
	.chat-viewport::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.08);
		border-radius: 4px;
	}

	/* Centered 720px Column Constraint */
	.chat-column {
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
		flex: 1;
	}

	/* Empty State */
	.empty-state {
		margin: auto 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 8px;
		animation: fadeSlideUp 240ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.empty-title {
		font-size: 20px;
		font-weight: 500;
		letter-spacing: -0.02em;
		color: var(--text-primary);
	}
	.empty-subtitle {
		font-size: 13px;
		color: var(--text-tertiary);
	}

	/* User Message: Compact Filled Block (Zero Visible Message Border) */
	.user-message {
		background: var(--bg-elevated);
		border: none;
		border-radius: var(--radius-md);
		padding: 9px 13px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-primary);
		user-select: text;
		word-break: break-word;
		animation: fadeSlideUp 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	/* Tool Call: Collapsed Single-Line Row */
	.tool-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.tool-row {
		border-radius: var(--radius-sm);
		overflow: hidden;
		transition: background 140ms ease;
	}
	.tool-row:hover {
		background: var(--bg-sidebar);
	}
	.tool-summary {
		height: 26px;
		padding: 0 8px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 12px;
		color: var(--text-secondary);
		cursor: pointer;
		user-select: none;
	}
	.tool-summary-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.tool-status-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-tertiary);
		flex-shrink: 0;
	}
	.tool-status-dot.active {
		background: var(--accent);
		animation: pulseDot 1.4s infinite ease-in-out;
	}
	.tool-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tool-time {
		font-family: var(--font-code);
		font-size: 11px;
		color: var(--text-tertiary);
		flex-shrink: 0;
	}
	.tool-details {
		display: none;
		padding: 6px 8px 8px 21px;
		font-family: var(--font-code);
		font-size: 11.5px;
		color: var(--text-tertiary);
	}
	.tool-row.expanded .tool-details {
		display: block;
		animation: fadeSlideUp 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	/* Code Edit Diff Card with Accept and Reject Buttons */
	.diff-card {
		background: var(--bg-sidebar);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
		transition: border-color 160ms ease;
		animation: fadeSlideUp 200ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.diff-card:hover {
		border-color: var(--border-focus);
	}
	.diff-header {
		height: 36px;
		padding: 0 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
	}
	.diff-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		cursor: pointer;
	}
	.diff-path {
		font-family: var(--font-code);
		font-size: 12px;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.diff-counts {
		font-family: var(--font-code);
		font-size: 11.5px;
		color: var(--text-secondary);
		flex-shrink: 0;
	}
	.diff-counts .add {
		color: var(--accent);
	}
	.diff-counts .del {
		color: var(--text-tertiary);
	}
	.diff-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
	.btn-diff {
		height: 24px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		font-family: var(--font-ui);
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-app);
		color: var(--text-secondary);
		transition: all 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.btn-diff:hover {
		color: var(--text-primary);
		border-color: var(--border-focus);
	}
	.btn-diff.accept {
		background: var(--accent);
		border-color: var(--accent);
		color: #ffffff;
	}
	.btn-diff.accept:hover {
		opacity: 0.92;
	}
	.diff-preview {
		padding: 8px 12px;
		font-family: var(--font-code);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text-secondary);
		max-height: 140px;
		overflow-y: auto;
		white-space: pre;
	}

	/* Assistant Message: Plain Text (Zero Background / Zero Border) */
	.assistant-message {
		background: transparent;
		border: none;
		padding: 0;
		color: var(--text-primary);
		font-size: 13px;
		line-height: 1.62;
		user-select: text;
		word-break: break-word;
		animation: fadeSlideUp 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.assistant-message h1,
	.assistant-message h2,
	.assistant-message h3,
	.assistant-message h4 {
		margin: 14px 0 6px 0;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}
	.assistant-message h1 { font-size: 17px; }
	.assistant-message h2 { font-size: 15px; }
	.assistant-message h3 { font-size: 13.5px; }
	.assistant-message p {
		margin: 0 0 10px 0;
	}
	.assistant-message p:last-child {
		margin-bottom: 0;
	}
	.assistant-message ul,
	.assistant-message ol {
		margin: 6px 0 10px 0;
		padding-left: 20px;
	}
	.assistant-message li {
		margin: 3px 0;
	}
	.assistant-message ul.task-list {
		list-style: none;
		padding-left: 2px;
	}
	.assistant-message li.task-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.task-checkbox {
		appearance: none;
		width: 13px;
		height: 13px;
		border: 1px solid var(--border-focus);
		border-radius: 3px;
		background: var(--bg-sidebar);
		display: inline-block;
		position: relative;
		flex-shrink: 0;
	}
	.task-checkbox.checked {
		background: var(--accent);
		border-color: var(--accent);
	}
	.task-checkbox.checked::after {
		content: "";
		position: absolute;
		left: 3px;
		top: 1px;
		width: 4px;
		height: 7px;
		border: solid #fff;
		border-width: 0 1.5px 1.5px 0;
		transform: rotate(45deg);
	}
	.assistant-message code.inline-code {
		font-family: var(--font-code);
		font-size: 12px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		padding: 1px 5px;
		border-radius: 4px;
		color: var(--text-primary);
	}

	/* Code Block with Language Header & Copy Button */
	.code-block-wrap {
		margin: 10px 0;
		background: var(--bg-sidebar);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.code-block-header {
		height: 28px;
		padding: 0 10px;
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.code-lang {
		font-family: var(--font-code);
		font-size: 11px;
		color: var(--text-tertiary);
	}
	.btn-copy-code {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 11px;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 4px;
		transition: color 120ms ease, background 120ms ease;
	}
	.btn-copy-code:hover {
		color: var(--text-primary);
		background: rgba(255, 255, 255, 0.04);
	}
	.code-block-pre {
		margin: 0;
		padding: 10px 12px;
		overflow-x: auto;
		font-family: var(--font-code);
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-primary);
	}

	/* Bottom Centered 720px Input Area */
	.input-dock {
		padding: 8px 20px 16px 20px;
		display: flex;
		justify-content: center;
		flex-shrink: 0;
	}
	.input-container {
		width: 100%;
		max-width: 720px;
		background: var(--bg-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		transition: border-color 180ms cubic-bezier(0.22, 1, 0.36, 1),
			box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.input-container:focus-within {
		border-color: var(--border-focus);
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
	}

	/* Context-Chip Row inside the Input Container */
	.chip-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 5px;
	}
	.context-chip {
		height: 22px;
		padding: 0 8px;
		background: var(--bg-sidebar);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 11.5px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		cursor: pointer;
		transition: border-color 140ms ease, color 140ms ease, transform 120ms ease;
	}
	.context-chip:hover {
		color: var(--text-primary);
		border-color: var(--border-focus);
	}
	.context-chip.code-chip {
		font-family: var(--font-code);
		font-size: 11px;
	}
	.chip-remove {
		color: var(--text-tertiary);
		margin-left: 2px;
	}
	.chip-remove:hover {
		color: var(--text-primary);
	}

	.prompt-textarea {
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-primary);
		font-family: var(--font-ui);
		font-size: 13px;
		line-height: 1.5;
		resize: none;
		outline: none;
		min-height: 38px;
		max-height: 160px;
		padding: 2px 2px;
	}
	.prompt-textarea::placeholder {
		color: var(--text-tertiary);
	}

	/* Bottom Controls Row: Mode Selector, Model Selector, Circular Send Button */
	.controls-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.controls-left {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.selector-pill {
		height: 24px;
		padding: 0 8px;
		background: var(--bg-sidebar);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
	}
	.selector-pill:hover {
		color: var(--text-primary);
		border-color: var(--border-focus);
	}
	.selector-pill.mode-active {
		color: var(--text-primary);
		border-color: var(--border-focus);
	}
	.mode-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
	}

	/* Circular Send Button */
	.btn-send-circle {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--accent);
		border: none;
		color: #ffffff;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex-shrink: 0;
		transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 150ms ease;
	}
	.btn-send-circle:hover {
		transform: scale(1.06);
	}
	.btn-send-circle:active {
		transform: scale(0.95);
	}
	.btn-send-circle.stop {
		background: var(--bg-sidebar);
		border: 1px solid var(--border-focus);
		color: var(--text-primary);
	}

	@keyframes fadeSlideUp {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	@keyframes pulseDot {
		0%, 100% { opacity: 0.35; transform: scale(0.9); }
		50% { opacity: 1; transform: scale(1.15); }
	}
</style>
</head>
<body>
	<div id="chatViewport" class="chat-viewport">
		<div id="chatColumn" class="chat-column"></div>
	</div>

	<div class="input-dock">
		<div class="input-container">
			<div id="chipRow" class="chip-row"></div>
			<textarea id="promptInput" class="prompt-textarea" placeholder="Plan, search, build anything... (@ to mention files)" rows="2"></textarea>
			<div class="controls-row">
				<div class="controls-left">
					<button id="modeSelector" class="selector-pill mode-active" data-action="cycleMode" title="Switch interaction mode (Agent / Ask / Edit)">
						<span class="mode-dot"></span>
						<span id="modeLabel">Agent</span>
					</button>
					<button class="selector-pill" data-action="pickModel" title="Switch active language model">
						<span id="modelLabel">Meta Muse Spark 1.3</span>
					</button>
				</div>
				<button id="sendBtn" class="btn-send-circle" data-action="submitPrompt" title="Send message (Enter)">↑</button>
			</div>
		</div>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();

	const MODES = ['Agent', 'Ask', 'Edit'];
	let state = {
		sessions: [],
		selectedSessionId: null,
		selectedModel: { id: 'muse-spark-1.3', name: 'Meta Muse Spark 1.3' },
		workspaceName: 'omen',
		activeFile: null,
		attachedFiles: [],
		modeIndex: 0,
		expandedTools: {},
	};

	const codeBlocksStore = [];

	function escapeHtml(str) {
		if (!str) return '';
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function renderInlineMarkdown(text) {
		let out = escapeHtml(text);
		out = out.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');
		out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
		out = out.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
		return out;
	}

	function renderFullMarkdown(rawText) {
		if (!rawText) return '';
		const segments = String(rawText).split(/(^\`\`\`[\\s\\S]*?^\`\`\`|\`\`\`[\\s\\S]*?\`\`\`)/gm);

		return segments.map(segment => {
			if (segment.startsWith('\`\`\`') && segment.endsWith('\`\`\`')) {
				const lines = segment.slice(3, -3).split('\\n');
				let lang = 'code';
				if (lines.length > 0 && /^[a-zA-Z0-9_+-]+$/.test(lines[0].trim())) {
					lang = lines.shift().trim();
				}
				const codeContent = lines.join('\\n').trim();
				const codeIdx = codeBlocksStore.push(codeContent) - 1;
				return \`
					<div class="code-block-wrap">
						<div class="code-block-header">
							<span class="code-lang">\${escapeHtml(lang)}</span>
							<button class="btn-copy-code" data-action="copyCode" data-code-index="\${codeIdx}">Copy</button>
						</div>
						<pre class="code-block-pre"><code>\${escapeHtml(codeContent)}</code></pre>
					</div>
				\`;
			}

			const lines = segment.split('\\n');
			let html = '';
			let inUl = false;
			let inTaskList = false;

			const closeLists = () => {
				if (inUl) { html += '</ul>'; inUl = false; }
				if (inTaskList) { html += '</ul>'; inTaskList = false; }
			};

			for (const rawLine of lines) {
				const line = rawLine.trimEnd();
				if (!line.trim()) {
					closeLists();
					continue;
				}

				if (line.startsWith('#### ')) {
					closeLists();
					html += '<h4>' + renderInlineMarkdown(line.slice(5)) + '</h4>';
				} else if (line.startsWith('### ')) {
					closeLists();
					html += '<h3>' + renderInlineMarkdown(line.slice(4)) + '</h3>';
				} else if (line.startsWith('## ')) {
					closeLists();
					html += '<h2>' + renderInlineMarkdown(line.slice(3)) + '</h2>';
				} else if (line.startsWith('# ')) {
					closeLists();
					html += '<h1>' + renderInlineMarkdown(line.slice(2)) + '</h1>';
				} else if (/^[-*]\\s+\\[( |x|X)\\]\\s+/.test(line)) {
					if (inUl) { html += '</ul>'; inUl = false; }
					if (!inTaskList) { html += '<ul class="task-list">'; inTaskList = true; }
					const checked = /^[-*]\\s+\\[(x|X)\\]/.test(line);
					const itemText = line.replace(/^[-*]\\s+\\[( |x|X)\\]\\s+/, '');
					html += \`
						<li class="task-item">
							<span class="task-checkbox \${checked ? 'checked' : ''}"></span>
							<span>\${renderInlineMarkdown(itemText)}</span>
						</li>
					\`;
				} else if (/^[-*]\\s+/.test(line)) {
					if (inTaskList) { html += '</ul>'; inTaskList = false; }
					if (!inUl) { html += '<ul>'; inUl = true; }
					html += '<li>' + renderInlineMarkdown(line.replace(/^[-*]\\s+/, '')) + '</li>';
				} else {
					closeLists();
					html += '<p>' + renderInlineMarkdown(line) + '</p>';
				}
			}
			closeLists();
			return html;
		}).join('');
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			state.sessions = msg.sessions || [];
			state.selectedSessionId = msg.selectedSessionId || null;
			if (msg.selectedModel) state.selectedModel = msg.selectedModel;
			if (msg.workspaceName) state.workspaceName = msg.workspaceName;
			state.activeFile = msg.activeFile || null;
			render();
		} else if (msg.type === 'addContextChip' && msg.relativePath) {
			if (!state.attachedFiles.some(f => f.relativePath === msg.relativePath)) {
				state.attachedFiles.push({
					fileName: msg.fileName || msg.relativePath,
					relativePath: msg.relativePath,
				});
				renderChips();
			}
			const input = document.getElementById('promptInput');
			if (input) input.focus();
		} else if (msg.type === 'focusInput') {
			state.selectedSessionId = null;
			render();
			const input = document.getElementById('promptInput');
			if (input) {
				input.value = '';
				input.focus();
			}
		}
	});

	function submitPrompt() {
		const input = document.getElementById('promptInput');
		const rawText = input ? input.value.trim() : '';
		if (!rawText) return;

		const mentions = state.attachedFiles.map(f => '@' + f.relativePath).join(' ');
		const finalPrompt = mentions ? (mentions + ' ' + rawText) : rawText;

		input.value = '';
		vscode.postMessage({
			type: 'submitPrompt',
			prompt: finalPrompt,
			modelId: state.selectedModel ? state.selectedModel.id : undefined,
		});
	}

	document.getElementById('promptInput').addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitPrompt();
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		const sessionId = actionEl.getAttribute('data-session-id');
		const filePath = actionEl.getAttribute('data-file-path');
		const toolKey = actionEl.getAttribute('data-tool-key');
		const codeIdx = actionEl.getAttribute('data-code-index');
		const chipPath = actionEl.getAttribute('data-chip-path');

		switch (action) {
			case 'pickContextFile':
				vscode.postMessage({ type: 'pickContextFile' });
				break;
			case 'removeChip':
				e.stopPropagation();
				state.attachedFiles = state.attachedFiles.filter(f => f.relativePath !== chipPath);
				renderChips();
				break;
			case 'cycleMode':
				state.modeIndex = (state.modeIndex + 1) % MODES.length;
				document.getElementById('modeLabel').textContent = MODES[state.modeIndex];
				break;
			case 'pickModel':
				vscode.postMessage({ type: 'pickModel' });
				break;
			case 'submitPrompt':
				submitPrompt();
				break;
			case 'stopActiveSession': {
				const active = getActiveSession();
				if (active && active.status === 'running') {
					vscode.postMessage({ type: 'cancelSession', sessionId: active.id });
				}
				break;
			}
			case 'toggleToolRow':
				if (toolKey) {
					state.expandedTools[toolKey] = !state.expandedTools[toolKey];
					render();
				}
				break;
			case 'openFileDiff':
				if (sessionId) {
					vscode.postMessage({ type: 'openFileDiff', sessionId, filePath });
				}
				break;
			case 'acceptDiff':
				if (sessionId) {
					vscode.postMessage({ type: 'acceptDiff', sessionId });
				}
				break;
			case 'rejectDiff':
				if (sessionId) {
					vscode.postMessage({ type: 'rejectDiff', sessionId });
				}
				break;
			case 'copyCode':
				if (codeIdx !== null && codeBlocksStore[Number(codeIdx)] !== undefined) {
					vscode.postMessage({
						type: 'copyToClipboard',
						text: codeBlocksStore[Number(codeIdx)],
					});
					actionEl.textContent = 'Copied';
					setTimeout(() => { actionEl.textContent = 'Copy'; }, 1400);
				}
				break;
		}
	});

	function getActiveSession() {
		if (!state.selectedSessionId || !state.sessions) return null;
		return state.sessions.find(s => s.id === state.selectedSessionId) || null;
	}

	function renderChips() {
		const chipRow = document.getElementById('chipRow');
		let html = \`
			<button class="context-chip" data-action="pickContextFile" title="Add file context (@file)">
				<span>@ Add Context</span>
			</button>
		\`;

		if (state.activeFile && !state.attachedFiles.some(f => f.relativePath === state.activeFile.relativePath)) {
			html += \`
				<button class="context-chip code-chip" data-action="pickContextFile" title="Active editor file">
					<span>\${escapeHtml(state.activeFile.fileName)}</span>
				</button>
			\`;
		}

		for (const f of state.attachedFiles) {
			html += \`
				<span class="context-chip code-chip">
					<span>@\${escapeHtml(f.fileName)}</span>
					<span class="chip-remove" data-action="removeChip" data-chip-path="\${escapeHtml(f.relativePath)}">×</span>
				</span>
			\`;
		}

		chipRow.innerHTML = html;
	}

	function render() {
		renderChips();
		codeBlocksStore.length = 0;

		const session = getActiveSession();
		const column = document.getElementById('chatColumn');
		const viewport = document.getElementById('chatViewport');
		const modelLabel = document.getElementById('modelLabel');
		const sendBtn = document.getElementById('sendBtn');

		if (state.selectedModel) {
			modelLabel.textContent = state.selectedModel.name;
		}

		if (session && session.status === 'running') {
			sendBtn.textContent = '■';
			sendBtn.className = 'btn-send-circle stop';
			sendBtn.setAttribute('data-action', 'stopActiveSession');
		} else {
			sendBtn.textContent = '↑';
			sendBtn.className = 'btn-send-circle';
			sendBtn.setAttribute('data-action', 'submitPrompt');
		}

		if (!session) {
			column.innerHTML = \`
				<div class="empty-state">
					<div class="empty-title">What can we build today?</div>
					<div class="empty-subtitle">Ask a question, attach files with @, or describe a code change.</div>
				</div>
			\`;
			return;
		}

		let html = '';
		const messages = Array.isArray(session.messages) && session.messages.length > 0
			? session.messages
			: [{ role: 'user', content: session.prompt, time: session.timestamp }];

		messages.forEach((m, idx) => {
			if (m.role === 'user') {
				html += \`
					<div class="user-message">
						\${escapeHtml(m.content)}
					</div>
				\`;

				// Render collapsed single-line tool rows for the latest turn
				const isLatestUserTurn = idx >= messages.length - 2;
				if (isLatestUserTurn && Array.isArray(session.activityLog) && session.activityLog.length > 0) {
					html += '<div class="tool-group">';
					session.activityLog.forEach((step, sIdx) => {
						const tKey = session.id + '-' + sIdx;
						const isExpanded = Boolean(state.expandedTools[tKey]);
						const isRunningLast = session.status === 'running' && sIdx === session.activityLog.length - 1;
						html += \`
							<div class="tool-row \${isExpanded ? 'expanded' : ''}">
								<div class="tool-summary" data-action="toggleToolRow" data-tool-key="\${escapeHtml(tKey)}">
									<div class="tool-summary-left">
										<span class="tool-status-dot \${isRunningLast ? 'active' : ''}"></span>
										<span class="tool-text">\${escapeHtml(step.text)}</span>
									</div>
									<span class="tool-time">\${escapeHtml(step.time || '')}</span>
								</div>
								<div class="tool-details">
									Step \${sIdx + 1} (\${escapeHtml(step.kind)}) — \${escapeHtml(step.text)}
								</div>
							</div>
						\`;
					});
					html += '</div>';
				}

				// Render Diff Cards with Accept and Reject buttons
				if (isLatestUserTurn && Array.isArray(session.filesChanged) && session.filesChanged.length > 0) {
					for (const f of session.filesChanged) {
						const previewLines = (f.modifiedContent || '').split('\\n').slice(0, 6).join('\\n');
						html += \`
							<div class="diff-card">
								<div class="diff-header">
									<div class="diff-meta" data-action="openFileDiff" data-session-id="\${escapeHtml(session.id)}" data-file-path="\${escapeHtml(f.filePath)}">
										<span class="diff-path">\${escapeHtml(f.filePath)}</span>
										<span class="diff-counts">
											<span class="add">+\${f.additions}</span>
											<span class="del">-\${f.deletions}</span>
										</span>
									</div>
									<div class="diff-actions">
										<button class="btn-diff" data-action="openFileDiff" data-session-id="\${escapeHtml(session.id)}" data-file-path="\${escapeHtml(f.filePath)}">Diff</button>
										\${session.status === 'review' ? \`
											<button class="btn-diff accept" data-action="acceptDiff" data-session-id="\${escapeHtml(session.id)}">Accept</button>
											<button class="btn-diff" data-action="rejectDiff" data-session-id="\${escapeHtml(session.id)}">Reject</button>
										\` : ''}
									</div>
								</div>
								\${previewLines ? \`<div class="diff-preview">\${escapeHtml(previewLines)}</div>\` : ''}
							</div>
						\`;
					}
				}
			} else {
				html += \`
					<div class="assistant-message">
						\${renderFullMarkdown(m.content)}
					</div>
				\`;
			}
		});

		column.innerHTML = html;
		viewport.scrollTop = viewport.scrollHeight;
	}

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
