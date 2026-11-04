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
				case "toggleSidebar": {
					await vscode.commands.executeCommand(
						"workbench.action.toggleSidebarVisibility",
					);
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
				case "pickFolder": {
					const currentFolder = diffManager.getSelectedFolderPath();
					const recentFolders = diffManager.getRecentFolders();
					const subfolders = await diffManager.getSubfoldersOfSelectedFolder();
					const parentFolder = path.dirname(currentFolder);

					interface FolderPickItem extends vscode.QuickPickItem {
						folderPath?: string;
						browse?: boolean;
					}

					const items: FolderPickItem[] = [
						{
							label: "Browse Folder...",
							description: "Select any folder on your Mac for this conversation",
							browse: true,
						},
						{
							label: "Recent & Workspace Folders",
							kind: vscode.QuickPickItemKind.Separator,
						},
						...recentFolders.map((folderPath) => ({
							label:
								folderPath === currentFolder
									? `${path.basename(folderPath) || folderPath} (Active)`
									: path.basename(folderPath) || folderPath,
							description: folderPath,
							folderPath,
						})),
					];

					if (parentFolder && parentFolder !== currentFolder) {
						items.push(
							{
								label: "Navigate",
								kind: vscode.QuickPickItemKind.Separator,
							},
							{
								label: `.. (${path.basename(parentFolder) || parentFolder})`,
								description: parentFolder,
								folderPath: parentFolder,
							},
						);
					}

					if (subfolders.length > 0) {
						items.push({
							label: `Subfolders in ${path.basename(currentFolder)}`,
							kind: vscode.QuickPickItemKind.Separator,
						});
						for (const sub of subfolders) {
							items.push({
								label: path.basename(sub),
								description: sub,
								folderPath: sub,
							});
						}
					}

					const picked = await vscode.window.showQuickPick(items, {
						placeHolder: `Select active codebase folder (Current: ${currentFolder})`,
					});
					if (!picked) {
						break;
					}

					if (picked.browse) {
						const uris = await vscode.window.showOpenDialog({
							canSelectFolders: true,
							canSelectFiles: false,
							canSelectMany: false,
							defaultUri: vscode.Uri.file(currentFolder),
							openLabel: "Select Folder",
						});
						if (uris && uris[0]) {
							await diffManager.setSelectedFolderPath(uris[0].fsPath);
							await AgentHubEditorProvider._postState(diffManager);
						}
					} else if (picked.folderPath) {
						await diffManager.setSelectedFolderPath(picked.folderPath);
						await AgentHubEditorProvider._postState(diffManager);
					}
					break;
				}
				case "pickContextFile": {
					const folderFiles = await diffManager.listFilesInSelectedFolder();
					if (folderFiles.length === 0) {
						vscode.window.showInformationMessage(
							`No code files found in ${diffManager.getSelectedFolderPath()}.`,
						);
						break;
					}
					const picked = await vscode.window.showQuickPick(
						folderFiles.map((f) => ({
							label: f.label,
							description: f.relativePath,
							fsPath: f.fsPath,
						})),
						{
							placeHolder: `Mention file from ${path.basename(diffManager.getSelectedFolderPath())} (@file)`,
						},
					);
					if (picked && panel) {
						void panel.webview.postMessage({
							type: "addContextChip",
							relativePath: picked.description,
							fileName: picked.label,
							fsPath: picked.fsPath,
						});
					}
					break;
				}
				case "openContextFile": {
					if (typeof msg.relativePath === "string" && msg.relativePath) {
						const fullPath = path.resolve(
							diffManager.getSelectedFolderPath(),
							msg.relativePath,
						);
						try {
							const doc = await vscode.workspace.openTextDocument(
								vscode.Uri.file(fullPath),
							);
							await vscode.window.showTextDocument(
								doc,
								vscode.ViewColumn.Beside,
							);
						} catch {
							// Ignore if file cannot be opened
						}
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
		const selectedFolderPath = diffManager.getSelectedFolderPath();
		const workspaceName =
			path.basename(selectedFolderPath) ||
			vscode.workspace.workspaceFolders?.[0]?.name ||
			"omen";
		const activeDoc = vscode.window.activeTextEditor?.document;
		const activeFile =
			activeDoc && activeDoc.uri.scheme === "file"
				? {
						fileName: path.basename(activeDoc.uri.fsPath),
						relativePath: activeDoc.uri.fsPath.startsWith(selectedFolderPath)
							? path.relative(selectedFolderPath, activeDoc.uri.fsPath)
							: vscode.workspace.asRelativePath(activeDoc.uri),
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
			selectedFolderPath,
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
		/* Backgrounds (Antigravity reference dark + subtle top-center ambient navy glow) */
		--bg-app:      #050507;
		--bg-sidebar:  #0c0b11;
		--bg-elevated: rgba(18, 18, 24, 0.85);

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
		background-color: var(--bg-app);
		background-image:
			radial-gradient(ellipse 68% 42% at 50% -4%, rgba(28, 58, 128, 0.22) 0%, rgba(18, 36, 82, 0.12) 38%, rgba(10, 16, 34, 0.05) 68%, rgba(5, 5, 7, 0) 100%),
			radial-gradient(ellipse 42% 28% at 50% 18%, rgba(36, 72, 148, 0.08) 0%, rgba(5, 5, 7, 0) 100%);
		background-repeat: no-repeat;
		background-attachment: fixed;
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

	/* Code Edit Unified Diff Card (Screenshot 2 Multi-File Tab Layout & Color Scheme) */
	.diff-card {
		background: #191716;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
		transition: border-color 160ms ease;
		animation: fadeSlideUp 200ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.diff-card:hover {
		border-color: var(--border-focus);
	}
	.diff-tabs-bar {
		height: 36px;
		display: flex;
		align-items: stretch;
		justify-content: space-between;
		background: #191716;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.diff-tabs-list {
		display: flex;
		align-items: stretch;
		overflow-x: auto;
		min-width: 0;
	}
	.diff-tabs-list::-webkit-scrollbar {
		display: none;
	}
	.diff-tab {
		padding: 0 14px;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-family: var(--font-ui);
		font-size: 12.5px;
		color: rgba(255, 255, 255, 0.45);
		background: #191716;
		border-right: 1px solid rgba(255, 255, 255, 0.07);
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
		transition: color 140ms ease, background 140ms ease;
	}
	.diff-tab:hover {
		color: rgba(255, 255, 255, 0.78);
		background: #1d1b19;
	}
	.diff-tab.active {
		color: rgba(255, 255, 255, 0.92);
		background: #1e1c1a;
	}
	.diff-tab-close {
		font-size: 13px;
		color: rgba(255, 255, 255, 0.45);
		line-height: 1;
	}
	.diff-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		flex-shrink: 0;
	}
	.diff-counts {
		font-family: var(--font-code);
		font-size: 11px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-right: 4px;
	}
	.diff-counts .add {
		color: #5ab87e;
	}
	.diff-counts .del {
		color: #d15a5a;
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
		background: #287346;
		border-color: #38915c;
		color: #ffffff;
	}
	.btn-diff.accept:hover {
		background: #308753;
	}
	.diff-unified-body {
		padding: 10px 0;
		background: #191716;
		font-family: var(--font-code);
		font-size: 12.5px;
		line-height: 1.62;
		max-height: 340px;
		overflow-y: auto;
		overflow-x: auto;
	}
	.diff-line {
		display: flex;
		align-items: baseline;
		padding: 0 14px;
		white-space: pre;
		min-width: max-content;
	}
	.diff-line.ctx {
		background: #191716;
		color: #8fd1a8;
	}
	.diff-line.del {
		background: #2b1818;
		color: #9e8e8a;
	}
	.diff-line.add {
		background: #16281e;
		color: #8fd1a8;
	}
	.diff-sign {
		width: 22px;
		flex-shrink: 0;
		user-select: none;
		display: inline-block;
		font-weight: 500;
	}
	.diff-line.del .diff-sign {
		color: #d15a5a;
	}
	.diff-line.add .diff-sign {
		color: #5ab87e;
	}
	.diff-line.ctx .diff-sign {
		color: transparent;
	}
	.diff-code {
		flex: 1;
	}
	.tok-str {
		color: #c9a26d;
	}
	.tok-param {
		color: #b8afa9;
		font-style: italic;
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

	/* Code Block with Language Header & Copy Button (Screenshot 2 Code Palette) */
	.code-block-wrap {
		margin: 10px 0;
		background: #191716;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
	.code-block-header {
		height: 30px;
		padding: 0 12px;
		background: #1e1c1a;
		border-bottom: 1px solid rgba(255, 255, 255, 0.07);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.code-lang {
		font-family: var(--font-code);
		font-size: 11px;
		color: rgba(255, 255, 255, 0.55);
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
		padding: 10px 14px;
		overflow-x: auto;
		font-family: var(--font-code);
		font-size: 12.5px;
		line-height: 1.6;
		color: #8fd1a8;
		background: #191716;
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
		selectedFolderPath: '',
		activeFile: null,
		attachedFiles: [],
		modeIndex: 0,
		expandedTools: {},
		activeDiffTabIndex: 0,
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

	function highlightCodeTokens(rawLine, isDeleted) {
		const escaped = escapeHtml(rawLine);
		if (isDeleted) {
			return escaped;
		}
		// Highlight string literals and numeric constants in warm amber (#c9a26d) matching Screenshot 2
		return escaped.replace(
			/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|\b\d+(?:\.\d+)?\b)/g,
			'<span class="tok-str">$1</span>'
		);
	}

	function buildUnifiedDiffHtml(originalText, modifiedText) {
		const origLines = (originalText || '').split('\\n');
		const modLines = (modifiedText || '').split('\\n');

		// Simple Myers/LCS-style line diff for unified view
		const origSet = new Set(origLines);
		const modSet = new Set(modLines);
		const rows = [];

		let i = 0;
		let j = 0;
		const maxLines = 120;

		while ((i < origLines.length || j < modLines.length) && rows.length < maxLines) {
			const oLine = i < origLines.length ? origLines[i] : undefined;
			const mLine = j < modLines.length ? modLines[j] : undefined;

			if (oLine !== undefined && mLine !== undefined && oLine === mLine) {
				rows.push({ kind: 'ctx', sign: ' ', text: oLine });
				i++;
				j++;
			} else if (oLine !== undefined && !modSet.has(oLine)) {
				rows.push({ kind: 'del', sign: '-', text: oLine });
				i++;
			} else if (mLine !== undefined && !origSet.has(mLine)) {
				rows.push({ kind: 'add', sign: '+', text: mLine });
				j++;
			} else if (oLine !== undefined) {
				rows.push({ kind: 'del', sign: '-', text: oLine });
				i++;
			} else if (mLine !== undefined) {
				rows.push({ kind: 'add', sign: '+', text: mLine });
				j++;
			}
		}

		return rows
			.map(r => \`
				<div class="diff-line \${r.kind}">
					<span class="diff-sign">\${r.sign}</span>
					<span class="diff-code">\${highlightCodeTokens(r.text, r.kind === 'del')}</span>
				</div>
			\`)
			.join('');
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
						<pre class="code-block-pre"><code>\${highlightCodeTokens(codeContent, false)}</code></pre>
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
			if (msg.selectedFolderPath !== undefined) state.selectedFolderPath = msg.selectedFolderPath;
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
		} else if (e.key === '@') {
			const input = e.target;
			const val = input.value || '';
			const caret = input.selectionStart || 0;
			if (caret === 0 || /\\s$/.test(val.slice(0, caret))) {
				setTimeout(() => {
					vscode.postMessage({ type: 'pickContextFile' });
				}, 20);
			}
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
		const tabIdx = actionEl.getAttribute('data-tab-index');

		switch (action) {
			case 'pickFolder':
				vscode.postMessage({ type: 'pickFolder' });
				break;
			case 'pickContextFile':
				vscode.postMessage({ type: 'pickContextFile' });
				break;
			case 'openContextFile':
				if (chipPath) {
					vscode.postMessage({ type: 'openContextFile', relativePath: chipPath });
				}
				break;
			case 'selectDiffTab':
				if (tabIdx !== null) {
					state.activeDiffTabIndex = Number(tabIdx) || 0;
					render();
				}
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
		const activeSession = getActiveSession();
		const folderLabel = (activeSession && activeSession.projectName) || state.workspaceName || 'Select Folder';
		const folderTooltip = (activeSession && activeSession.folderPath) || state.selectedFolderPath || 'Click to select folder for this conversation';

		let html = \`
			<button class="context-chip" data-action="pickFolder" title="\${escapeHtml(folderTooltip)}">
				<span>\${escapeHtml(folderLabel)} ⌄</span>
			</button>
		\`;

		if (state.activeFile && !state.attachedFiles.some(f => f.relativePath === state.activeFile.relativePath)) {
			html += \`
				<button class="context-chip code-chip" data-action="openContextFile" data-chip-path="\${escapeHtml(state.activeFile.relativePath)}" title="Active file in folder">
					<span>\${escapeHtml(state.activeFile.fileName)}</span>
				</button>
			\`;
		}

		for (const f of state.attachedFiles) {
			html += \`
				<span class="context-chip code-chip" data-action="openContextFile" data-chip-path="\${escapeHtml(f.relativePath)}" title="Click to open \${escapeHtml(f.relativePath)}">
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

				// Render Unified Diff Card with Multi-File Tabs & Screenshot 2 Color Scheme
				if (isLatestUserTurn && Array.isArray(session.filesChanged) && session.filesChanged.length > 0) {
					const activeIdx = Math.min(state.activeDiffTabIndex || 0, session.filesChanged.length - 1);
					const activeDiff = session.filesChanged[activeIdx] || session.filesChanged[0];
					const tabsHtml = session.filesChanged.map((f, fIdx) => {
						const baseName = f.filePath.split('/').pop() || f.filePath;
						const isTabActive = fIdx === activeIdx;
						return \`
							<div class="diff-tab \${isTabActive ? 'active' : ''}" data-action="selectDiffTab" data-tab-index="\${fIdx}" title="\${escapeHtml(f.filePath)}">
								<span>\${escapeHtml(baseName)}</span>
								\${isTabActive ? '<span class="diff-tab-close">×</span>' : ''}
							</div>
						\`;
					}).join('');

					const unifiedLinesHtml = buildUnifiedDiffHtml(
						activeDiff.originalContent || '',
						activeDiff.modifiedContent || ''
					);

					html += \`
						<div class="diff-card">
							<div class="diff-tabs-bar">
								<div class="diff-tabs-list">
									\${tabsHtml}
								</div>
								<div class="diff-actions">
									<span class="diff-counts">
										<span class="add">+\${activeDiff.additions}</span>
										<span class="del">-\${activeDiff.deletions}</span>
									</span>
									<button class="btn-diff" data-action="openFileDiff" data-session-id="\${escapeHtml(session.id)}" data-file-path="\${escapeHtml(activeDiff.filePath)}">Diff</button>
									\${session.status === 'review' ? \`
										<button class="btn-diff accept" data-action="acceptDiff" data-session-id="\${escapeHtml(session.id)}">Accept</button>
										<button class="btn-diff" data-action="rejectDiff" data-session-id="\${escapeHtml(session.id)}">Reject</button>
									\` : ''}
								</div>
							</div>
							<div class="diff-unified-body">
								\${unifiedLinesHtml}
							</div>
						</div>
					\`;
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
