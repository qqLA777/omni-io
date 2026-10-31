/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as crypto from "crypto";
import { AgentDiffManager } from "./agentDiffManager.js";
import { SecretManager } from "./secretManager.js";

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export class AgentHubEditorProvider {
	public static readonly viewType = "omen.agentHub";
	private static _currentPanel: vscode.WebviewPanel | undefined;

	public static async createOrShow(
		context: vscode.ExtensionContext,
		diffManager: AgentDiffManager,
		secretManager: SecretManager,
	): Promise<void> {
		const column = vscode.ViewColumn.One;

		if (AgentHubEditorProvider._currentPanel) {
			AgentHubEditorProvider._currentPanel.reveal(column);
			const currentModel = await diffManager.getSelectedModelOption();
			void AgentHubEditorProvider._currentPanel.webview.postMessage({
				type: "modelUpdated",
				modelName: currentModel.name,
			});
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			AgentHubEditorProvider.viewType,
			"Agent Mode",
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		AgentHubEditorProvider._currentPanel = panel;

		const modelSub = diffManager.onDidChangeSelectedModel((model) => {
			if (AgentHubEditorProvider._currentPanel) {
				void AgentHubEditorProvider._currentPanel.webview.postMessage({
					type: "modelUpdated",
					modelName: model.name,
				});
			}
		});

		panel.onDidDispose(() => {
			modelSub.dispose();
			AgentHubEditorProvider._currentPanel = undefined;
		});

		const selectedModel = await diffManager.getSelectedModelOption();
		panel.webview.html = AgentHubEditorProvider._getHtml(
			context,
			selectedModel.name,
		);

		panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "openIDE": {
					await vscode.commands.executeCommand("workbench.view.explorer");
					await vscode.commands.executeCommand(
						"workbench.action.closeActiveEditor",
					);
					break;
				}
				case "executePrompt": {
					if (msg.prompt && typeof msg.prompt === "string" && msg.prompt.trim()) {
						await vscode.commands.executeCommand("omen.agentsView.focus");
						void diffManager.executeRealAgent(msg.prompt.trim());
					}
					break;
				}
				case "selectModel": {
					const availableModels = await diffManager.getAvailableModels();
					const currentId = diffManager.selectedModelId;
					const items = availableModels.map((m) => ({
						label: `${m.id === currentId ? "$(check) " : ""}${m.name}`,
						description: m.id,
						detail: `Provider: ${m.provider.toUpperCase()} (${m.baseUrl})`,
						modelId: m.id,
						modelName: m.name,
					}));

					const choice = await vscode.window.showQuickPick(items, {
						placeHolder: "Select active Omen Language Model for Agent execution",
					});
					if (choice) {
						await diffManager.setSelectedModelId(choice.modelId);
					}
					break;
				}
				case "configureKey": {
					await secretManager.promptForApiKey();
					break;
				}
			}
		});
	}

	private static _getHtml(
		_context: vscode.ExtensionContext,
		selectedModelName: string,
	): string {
		const nonce = crypto.randomBytes(16).toString("base64");
		const workspaceName = escapeHtml(
			vscode.workspace.workspaceFolders?.[0]?.name || "Workspace",
		);
		const safeModelName = escapeHtml(selectedModelName);

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
	:root {
		--bg-canvas: #101010;
		--bg-card: #202020;
		--bg-card-bottom: #313131;
		--border-subtle: #2b2b2b;
		--fg-primary: #EDEDED;
		--fg-muted: #8E8E8E;
		--accent-blue: #007acc;
		--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	}
	* { box-sizing: border-box; }
	body, html {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		background-color: var(--bg-canvas);
		color: var(--fg-primary);
		font-family: var(--font);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		user-select: none;
	}
	.top-bar {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		padding: 12px 18px;
		gap: 10px;
	}
	.btn-open-ide {
		background: #181818;
		color: #EDEDED;
		border: 1px solid #2B2B2B;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: all 0.15s ease;
	}
	.btn-open-ide:hover {
		background: #242424;
		border-color: #383838;
		color: #FFFFFF;
	}
	.canvas-center {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		padding: 0 24px;
		margin-top: -60px;
	}
	.capsule-wrapper {
		width: 100%;
		max-width: 680px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.repo-tag {
		font-size: 12.5px;
		color: #9E9E9E;
		display: flex;
		align-items: center;
		gap: 6px;
		width: fit-content;
		padding: 3px 6px;
		border-radius: 4px;
	}
	.input-capsule {
		background: var(--bg-card);
		border: 1px solid #2B2B2B;
		border-radius: 14px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
		transition: border-color 0.15s ease;
	}
	.input-capsule:focus-within {
		border-color: #454545;
	}
	.capsule-textarea {
		width: 100%;
		height: 80px;
		background: transparent;
		border: none;
		outline: none;
		color: #EDEDED;
		font-family: inherit;
		font-size: 13.5px;
		padding: 14px 16px;
		resize: none;
		line-height: 1.45;
	}
	.capsule-textarea::placeholder {
		color: #727272;
	}
	.capsule-footer {
		background: var(--bg-card-bottom);
		padding: 8px 12px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		border-top: 1px solid rgba(255, 255, 255, 0.05);
	}
	.footer-left {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.footer-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.pill-btn {
		background: rgba(255, 255, 255, 0.06);
		color: #CFCFCF;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 5px;
		transition: all 0.15s ease;
	}
	.pill-btn:hover {
		background: rgba(255, 255, 255, 0.12);
		color: #FFFFFF;
	}
	.btn-submit {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: #3B3B3B;
		color: #9E9E9E;
		border: none;
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.btn-submit.active {
		background: #007acc;
		color: #FFFFFF;
	}
</style>
</head>
<body>
	<div class="top-bar">
		<button id="openIdeBtn" class="btn-open-ide">Open IDE ↗</button>
	</div>

	<div class="canvas-center">
		<div class="capsule-wrapper">
			<div class="repo-tag">
				<span>📁 ${workspaceName}</span>
			</div>

			<div class="input-capsule">
				<textarea
					id="promptInput"
					class="capsule-textarea"
					placeholder="Ask anything, @ to mention, / for actions"
				></textarea>

				<div class="capsule-footer">
					<div class="footer-left">
						<button id="apiKeyBtn" class="pill-btn">API Keys ⚙</button>
						<button id="modelPickerBtn" class="pill-btn">
							<span id="modelName">${safeModelName}</span>
							<span style="font-size: 9px; opacity: 0.7;">▾</span>
						</button>
					</div>

					<div class="footer-right">
						<button id="submitBtn" class="btn-submit">→</button>
					</div>
				</div>
			</div>
		</div>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const inputEl = document.getElementById('promptInput');
	const submitBtn = document.getElementById('submitBtn');
	const modelNameEl = document.getElementById('modelName');
	const openIdeBtn = document.getElementById('openIdeBtn');
	const apiKeyBtn = document.getElementById('apiKeyBtn');
	const modelPickerBtn = document.getElementById('modelPickerBtn');

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'modelUpdated') {
			modelNameEl.textContent = msg.modelName;
		}
	});

	function updateSubmitState() {
		if (inputEl.value.trim().length > 0) {
			submitBtn.classList.add('active');
		} else {
			submitBtn.classList.remove('active');
		}
	}

	function submitPrompt() {
		const val = inputEl.value.trim();
		if (!val) return;
		vscode.postMessage({ type: 'executePrompt', prompt: val });
		inputEl.value = '';
		updateSubmitState();
	}

	inputEl.addEventListener('input', updateSubmitState);
	inputEl.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitPrompt();
		}
	});

	submitBtn.addEventListener('click', submitPrompt);
	openIdeBtn.addEventListener('click', () => vscode.postMessage({ type: 'openIDE' }));
	apiKeyBtn.addEventListener('click', () => vscode.postMessage({ type: 'configureKey' }));
	modelPickerBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
</script>
</body>
</html>`;
	}
}
