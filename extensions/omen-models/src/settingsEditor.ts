/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import * as crypto from "crypto";
import { SecretManager, OmenCloudProvider } from "./secretManager.js";

interface ProviderStatusItem {
	id: OmenCloudProvider;
	name: string;
	subtitle: string;
	models: string[];
	baseUrl: string;
	configSection: string;
	enabled: boolean;
	configured: boolean;
	maskedKey: string;
	placeholder: string;
}

export class OmenSettingsEditorProvider {
	public static readonly viewType = "omen.settingsHub";
	private static _currentPanel: vscode.WebviewPanel | undefined;

	public static async createOrShow(
		_context: vscode.ExtensionContext,
		secretManager: SecretManager,
		onDidUpdate?: () => void,
	): Promise<void> {
		const column = vscode.ViewColumn.One;

		if (OmenSettingsEditorProvider._currentPanel) {
			OmenSettingsEditorProvider._currentPanel.reveal(column);
			await OmenSettingsEditorProvider._postState(secretManager);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			OmenSettingsEditorProvider.viewType,
			"Settings & API Keys",
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		OmenSettingsEditorProvider._currentPanel = panel;

		panel.onDidDispose(() => {
			OmenSettingsEditorProvider._currentPanel = undefined;
		});

		panel.webview.html = OmenSettingsEditorProvider._getHtml();

		panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready": {
					await OmenSettingsEditorProvider._postState(secretManager);
					break;
				}
				case "saveProvider": {
					const provider = msg.provider as OmenCloudProvider;
					const apiKey = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
					const baseUrl =
						typeof msg.baseUrl === "string" ? msg.baseUrl.trim() : "";
					const enabled = Boolean(msg.enabled);

					const configSection = `omen.providers.${provider}`;
					try {
						await vscode.workspace
							.getConfiguration(configSection)
							.update("enabled", enabled, vscode.ConfigurationTarget.Global);
						if (baseUrl) {
							await vscode.workspace
								.getConfiguration(configSection)
								.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
						}
					} catch {
						// Ignore config update error
					}

					if (msg.updateKey === true) {
						switch (provider) {
							case "meta":
								await secretManager.setMetaApiKey(apiKey);
								break;
							case "gemini":
								await secretManager.setGeminiApiKey(apiKey);
								break;
							case "anthropic":
								await secretManager.setAnthropicApiKey(apiKey);
								break;
							case "openai":
								await secretManager.setOpenAIApiKey(apiKey);
								break;
							case "deepseek":
								await secretManager.setDeepSeekApiKey(apiKey);
								break;
							case "openrouter":
								await secretManager.setOpenRouterApiKey(apiKey);
								break;
						}
					}

					if (onDidUpdate) {
						onDidUpdate();
					}
					await OmenSettingsEditorProvider._postState(
						secretManager,
						`${provider.toUpperCase()} configuration saved.`,
					);
					break;
				}
				case "clearProviderKey": {
					const provider = msg.provider as OmenCloudProvider;
					switch (provider) {
						case "meta":
							await secretManager.setMetaApiKey("");
							break;
						case "gemini":
							await secretManager.setGeminiApiKey("");
							break;
						case "anthropic":
							await secretManager.setAnthropicApiKey("");
							break;
						case "openai":
							await secretManager.setOpenAIApiKey("");
							break;
						case "deepseek":
							await secretManager.setDeepSeekApiKey("");
							break;
						case "openrouter":
							await secretManager.setOpenRouterApiKey("");
							break;
					}
					if (onDidUpdate) {
						onDidUpdate();
					}
					await OmenSettingsEditorProvider._postState(
						secretManager,
						`${provider.toUpperCase()} API key cleared.`,
					);
					break;
				}
				case "backToChat": {
					await vscode.commands.executeCommand("omen.openAgentHub");
					break;
				}
				case "openIdeSettings": {
					await vscode.commands.executeCommand("workbench.action.openSettings");
					break;
				}
			}
		});

		await OmenSettingsEditorProvider._postState(secretManager);
	}

	private static _maskKey(key?: string): string {
		if (!key || !key.trim()) {
			return "";
		}
		const trimmed = key.trim();
		if (trimmed.length <= 10) {
			return "••••••••";
		}
		return `${trimmed.slice(0, 6)}••••••••••••${trimmed.slice(-4)}`;
	}

	private static async _postState(
		secretManager: SecretManager,
		toast?: string,
	): Promise<void> {
		if (!OmenSettingsEditorProvider._currentPanel) {
			return;
		}

		const metaKey = await secretManager.getMetaApiKey();
		const geminiKey = await secretManager.getGeminiApiKey();
		const anthropicKey = await secretManager.getAnthropicApiKey();
		const openaiKey = await secretManager.getOpenAIApiKey();
		const deepseekKey = await secretManager.getDeepSeekApiKey();
		const openrouterKey = await secretManager.getOpenRouterApiKey();

		const getCfg = (provider: string, defUrl: string) => {
			const cfg = vscode.workspace.getConfiguration(`omen.providers.${provider}`);
			return {
				enabled: cfg.get<boolean>("enabled", true),
				baseUrl: cfg.get<string>("baseUrl", defUrl),
			};
		};

		const metaCfg = getCfg("meta", "https://api.meta.ai/v1");
		const geminiCfg = getCfg(
			"gemini",
			"https://generativelanguage.googleapis.com/v1beta/openai",
		);
		const anthropicCfg = getCfg("anthropic", "https://api.anthropic.com/v1");
		const openaiCfg = getCfg("openai", "https://api.openai.com/v1");
		const deepseekCfg = getCfg("deepseek", "https://api.deepseek.com/v1");
		const openrouterCfg = getCfg("openrouter", "https://openrouter.ai/api/v1");

		const providers: ProviderStatusItem[] = [
			{
				id: "meta",
				name: "Meta Muse API",
				subtitle:
					"Frontier agentic coding & multimodal reasoning via Meta Model API",
				models: [
					"muse-spark-1.3",
					"muse-wonder-1.0",
					"muse-spark-1.3-contributor",
					"muse-spark-1.2",
				],
				baseUrl: metaCfg.baseUrl,
				configSection: "omen.providers.meta",
				enabled: metaCfg.enabled,
				configured: Boolean(metaKey && metaKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(metaKey),
				placeholder: "LLM_...",
			},
			{
				id: "gemini",
				name: "Google Gemini API",
				subtitle:
					"1M context window multimodal & reasoning models via Google AI Studio",
				models: ["gemini-2.5-pro", "gemini-2.5-flash"],
				baseUrl: geminiCfg.baseUrl,
				configSection: "omen.providers.gemini",
				enabled: geminiCfg.enabled,
				configured: Boolean(geminiKey && geminiKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(geminiKey),
				placeholder: "AIzaSy...",
			},
			{
				id: "anthropic",
				name: "Anthropic Claude API",
				subtitle:
					"High-precision code generation & architectural refactoring via Anthropic",
				models: ["claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
				baseUrl: anthropicCfg.baseUrl,
				configSection: "omen.providers.anthropic",
				enabled: anthropicCfg.enabled,
				configured: Boolean(anthropicKey && anthropicKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(anthropicKey),
				placeholder: "sk-ant-...",
			},
			{
				id: "openai",
				name: "OpenAI API",
				subtitle: "GPT-4o multimodal and o3-mini reasoning models via OpenAI",
				models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
				baseUrl: openaiCfg.baseUrl,
				configSection: "omen.providers.openai",
				enabled: openaiCfg.enabled,
				configured: Boolean(openaiKey && openaiKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(openaiKey),
				placeholder: "sk-proj-...",
			},
			{
				id: "deepseek",
				name: "DeepSeek API",
				subtitle: "DeepSeek-V3 chat and DeepSeek-R1 chain-of-thought reasoning",
				models: ["deepseek-chat", "deepseek-reasoner"],
				baseUrl: deepseekCfg.baseUrl,
				configSection: "omen.providers.deepseek",
				enabled: deepseekCfg.enabled,
				configured: Boolean(deepseekKey && deepseekKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(deepseekKey),
				placeholder: "sk-...",
			},
			{
				id: "openrouter",
				name: "OpenRouter API",
				subtitle: "Unified gateway for 200+ third-party cloud models",
				models: ["openrouter/auto", "anthropic/claude-3.7-sonnet"],
				baseUrl: openrouterCfg.baseUrl,
				configSection: "omen.providers.openrouter",
				enabled: openrouterCfg.enabled,
				configured: Boolean(openrouterKey && openrouterKey.trim()),
				maskedKey: OmenSettingsEditorProvider._maskKey(openrouterKey),
				placeholder: "sk-or-v1-...",
			},
		];

		void OmenSettingsEditorProvider._currentPanel.webview.postMessage({
			type: "state",
			providers,
			toast: toast || null,
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

		--bg: var(--bg-app);
		--bg-card: var(--bg-sidebar);
		--bg-input: var(--bg-elevated);
		--fg: var(--text-primary);
		--fg-muted: var(--text-secondary);
		--fg-subtle: var(--text-tertiary);
		--green: var(--accent);
		--font: var(--font-ui);
		--mono: var(--font-code);
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
		background: var(--bg-app);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		user-select: none;
		-webkit-font-smoothing: antialiased;
	}

	.page-scroll {
		flex: 1;
		overflow-y: auto;
		padding: 36px 14% 48px 14%;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}
	@media (max-width: 900px) {
		.page-scroll {
			padding: 24px 20px 36px 20px;
		}
	}

	.top-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		border-bottom: 1px solid var(--border);
		padding-bottom: 18px;
	}
	.header-left {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.page-title {
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.2px;
		color: var(--fg);
	}
	.page-subtitle {
		font-size: 12.5px;
		color: var(--fg-muted);
		line-height: 1.5;
		max-width: 580px;
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}
	.btn-secondary {
		background: #16161A;
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 7px;
		padding: 6px 12px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.12s ease, border-color 0.12s ease;
	}
	.btn-secondary:hover {
		background: #1F1F25;
		border-color: var(--border-focus);
	}

	.toast-banner {
		display: none;
		background: rgba(34, 197, 94, 0.1);
		border: 1px solid rgba(34, 197, 94, 0.3);
		color: var(--green);
		padding: 9px 14px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 500;
	}
	.toast-banner.visible {
		display: block;
	}

	.providers-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
		gap: 14px;
	}

	.provider-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}
	.provider-title-group {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.provider-name {
		font-size: 14px;
		font-weight: 600;
		color: var(--fg);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.provider-desc {
		font-size: 11.5px;
		color: var(--fg-muted);
		line-height: 1.4;
	}
	.status-pill {
		font-size: 10.5px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 12px;
		letter-spacing: 0.2px;
		flex-shrink: 0;
	}
	.status-pill.configured {
		background: rgba(34, 197, 94, 0.12);
		color: var(--green);
		border: 1px solid rgba(34, 197, 94, 0.28);
	}
	.status-pill.missing {
		background: #18181D;
		color: var(--fg-subtle);
		border: 1px solid var(--border);
	}

	.models-list {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.model-tag {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--fg-muted);
		background: #17171C;
		border: 1px solid #24242C;
		padding: 2px 7px;
		border-radius: 4px;
	}

	.field-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.field-label {
		font-size: 11px;
		font-weight: 500;
		color: var(--fg-subtle);
		display: flex;
		justify-content: space-between;
	}
	.field-input {
		width: 100%;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 7px 10px;
		color: var(--fg);
		font-family: var(--mono);
		font-size: 11.5px;
		outline: none;
		transition: border-color 0.12s ease;
	}
	.field-input:focus {
		border-color: var(--border-focus);
	}

	.card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-top: 4px;
		gap: 8px;
	}
	.toggle-wrap {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 11.5px;
		color: var(--fg-muted);
		cursor: pointer;
	}
	.btn-group {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.btn-save {
		background: #F4F4F5;
		color: #09090B;
		border: none;
		border-radius: 6px;
		padding: 5px 12px;
		font-size: 11.5px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.12s ease;
	}
	.btn-save:hover {
		opacity: 0.9;
	}
	.btn-clear {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--fg-subtle);
		border-radius: 6px;
		padding: 5px 9px;
		font-size: 11px;
		cursor: pointer;
	}
	.btn-clear:hover {
		color: var(--fg);
		border-color: var(--border-focus);
	}
</style>
</head>
<body>
	<div class="page-scroll">
		<div class="top-header">
			<div class="header-left">
				<div class="page-title">Settings &amp; External API Keys</div>
				<div class="page-subtitle">
					Configure external cloud model credentials for Meta Muse, Google Gemini, Anthropic Claude, OpenAI, DeepSeek, and OpenRouter. Keys are stored in your system keychain and immediately available in the AI Chat model selector.
				</div>
			</div>
			<div class="header-actions">
				<button class="btn-secondary" data-action="openIdeSettings">IDE Preferences</button>
				<button class="btn-secondary" data-action="backToChat">Back to AI Chat</button>
			</div>
		</div>

		<div id="toastBanner" class="toast-banner"></div>

		<div id="providersContainer" class="providers-grid"></div>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	let providers = [];

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
			providers = msg.providers || [];
			render();
			if (msg.toast) {
				const banner = document.getElementById('toastBanner');
				banner.textContent = msg.toast;
				banner.classList.add('visible');
				setTimeout(() => banner.classList.remove('visible'), 3000);
			}
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		const providerId = actionEl.getAttribute('data-provider');

		if (action === 'backToChat') {
			vscode.postMessage({ type: 'backToChat' });
		} else if (action === 'openIdeSettings') {
			vscode.postMessage({ type: 'openIdeSettings' });
		} else if (action === 'saveProvider' && providerId) {
			const keyInput = document.getElementById('key-' + providerId);
			const urlInput = document.getElementById('url-' + providerId);
			const enabledInput = document.getElementById('enabled-' + providerId);

			const rawKey = keyInput ? keyInput.value.trim() : '';
			vscode.postMessage({
				type: 'saveProvider',
				provider: providerId,
				apiKey: rawKey,
				updateKey: rawKey.length > 0,
				baseUrl: urlInput ? urlInput.value.trim() : '',
				enabled: enabledInput ? enabledInput.checked : true,
			});
		} else if (action === 'clearKey' && providerId) {
			vscode.postMessage({
				type: 'clearProviderKey',
				provider: providerId,
			});
		}
	});

	function render() {
		const container = document.getElementById('providersContainer');
		container.innerHTML = providers.map(p => {
			const statusClass = p.configured ? 'configured' : 'missing';
			const statusText = p.configured ? 'Configured' : 'Not Set';
			const modelsHtml = (p.models || []).map(m => '<span class="model-tag">' + escapeHtml(m) + '</span>').join('');
			const keyHint = p.configured ? ('Saved: ' + p.maskedKey) : 'Not configured';

			return \`
				<div class="provider-card">
					<div class="card-top">
						<div class="provider-title-group">
							<div class="provider-name">\${escapeHtml(p.name)}</div>
							<div class="provider-desc">\${escapeHtml(p.subtitle)}</div>
						</div>
						<span class="status-pill \${statusClass}">\${statusText}</span>
					</div>

					<div class="models-list">\${modelsHtml}</div>

					<div class="field-group">
						<div class="field-label">
							<span>API Key</span>
							<span>\${escapeHtml(keyHint)}</span>
						</div>
						<input id="key-\${escapeHtml(p.id)}" class="field-input" type="password" placeholder="\${p.configured ? 'Enter new key to replace saved key...' : escapeHtml(p.placeholder)}" />
					</div>

					<div class="field-group">
						<div class="field-label">
							<span>Base Endpoint URL</span>
						</div>
						<input id="url-\${escapeHtml(p.id)}" class="field-input" type="text" value="\${escapeHtml(p.baseUrl)}" />
					</div>

					<div class="card-footer">
						<label class="toggle-wrap">
							<input id="enabled-\${escapeHtml(p.id)}" type="checkbox" \${p.enabled ? 'checked' : ''} />
							<span>Enable in Model Selector</span>
						</label>
						<div class="btn-group">
							\${p.configured ? \`<button class="btn-clear" data-action="clearKey" data-provider="\${escapeHtml(p.id)}">Clear Key</button>\` : ''}
							<button class="btn-save" data-action="saveProvider" data-provider="\${escapeHtml(p.id)}">Save</button>
						</div>
					</div>
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
