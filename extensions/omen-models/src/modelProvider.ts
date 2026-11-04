/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */

import * as vscode from "vscode";
import { OmenCloudProvider, SecretManager } from "./secretManager.js";
import { OllamaManager } from "./ollamaManager.js";
import { OmenClusterViewProvider } from "./clusterView.js";

export type OmenModelProviderType = OmenCloudProvider | "ollama" | "lan";

export interface OmenChatModelInfo extends vscode.LanguageModelChatInformation {
	id: string;
	name: string;
	family: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxContextWindowTokens: number;
	capabilities: vscode.LanguageModelChatCapabilities;
	provider: OmenModelProviderType;
	baseUrl: string;
}

export class OmenLanguageModelChatProvider implements vscode.LanguageModelChatProvider<OmenChatModelInfo> {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		private readonly secretManager: SecretManager,
		private readonly clusterProvider?: OmenClusterViewProvider,
	) {}

	refresh(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<OmenChatModelInfo[]> {
		const models: OmenChatModelInfo[] = [];

		// 1. Paired LAN Worker (e.g. Acer Nitro 5 GPU over LAN)
		const activeWorker = this.clusterProvider?.getActiveWorker();
		if (activeWorker && activeWorker.online) {
			const workerBaseUrl = `http://${activeWorker.ip}:${activeWorker.port}/v1`;
			const workerModels = activeWorker.models.length > 0 ? activeWorker.models : ["qwen2.5-coder:7b"];
			for (const modelName of workerModels) {
				models.push({
					id: `lan/${activeWorker.ip}/${modelName}`,
					name: `LAN (${activeWorker.name}): ${modelName}`,
					family: "ollama-lan",
					version: "lan",
					detail: `${activeWorker.gpuName} (${activeWorker.ip})`,
					maxInputTokens: 32768,
					maxOutputTokens: 8192,
					maxContextWindowTokens: 32768,
					capabilities: { toolCalling: true },
					provider: "lan",
					baseUrl: workerBaseUrl,
					isBYOK: false,
					isUserSelectable: true,
					isDefault: models.length === 0,
				});
			}
		}

		// 2. Local Ollama Models (Dynamically queried from localhost:11434)
		const ollamaConfig = vscode.workspace.getConfiguration("omen.providers.ollama");
		if (ollamaConfig.get<boolean>("enabled", true)) {
			const baseUrl = OllamaManager.getBaseUrl();
			const localModels = await OllamaManager.listInstalledModels();
			for (const m of localModels) {
				models.push({
					id: `ollama/${m.name}`,
					name: `Local Ollama: ${m.name}`,
					family: m.details?.family || "ollama",
					version: m.digest.slice(0, 8),
					detail: "Local (127.0.0.1:11434)",
					maxInputTokens: 32768,
					maxOutputTokens: 8192,
					maxContextWindowTokens: 32768,
					capabilities: { toolCalling: true },
					provider: "ollama",
					baseUrl: `${baseUrl}/v1`,
					isBYOK: false,
					isUserSelectable: true,
					isDefault: models.length === 0,
				});
			}
		}

		// 3. DeepSeek Models
		const deepseekConfig = vscode.workspace.getConfiguration("omen.providers.deepseek");
		if (deepseekConfig.get<boolean>("enabled", true)) {
			const baseUrl = deepseekConfig
				.get<string>("baseUrl", "https://api.deepseek.com/v1")
				.replace(/\/+$/, "");
			models.push({
				id: "deepseek-chat",
				name: "DeepSeek-V3 (Chat)",
				family: "deepseek",
				version: "v3",
				detail: "DeepSeek API",
				maxInputTokens: 64000,
				maxOutputTokens: 8192,
				maxContextWindowTokens: 65536,
				capabilities: { toolCalling: true },
				provider: "deepseek",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
				isDefault: models.length === 0,
			});
			models.push({
				id: "deepseek-reasoner",
				name: "DeepSeek-R1 (Reasoning)",
				family: "deepseek",
				version: "r1",
				detail: "DeepSeek API",
				maxInputTokens: 64000,
				maxOutputTokens: 8192,
				maxContextWindowTokens: 65536,
				capabilities: { toolCalling: true },
				provider: "deepseek",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		// 4. OpenAI Models
		const openaiConfig = vscode.workspace.getConfiguration("omen.providers.openai");
		if (openaiConfig.get<boolean>("enabled", true)) {
			const baseUrl = openaiConfig
				.get<string>("baseUrl", "https://api.openai.com/v1")
				.replace(/\/+$/, "");
			models.push({
				id: "gpt-4o",
				name: "OpenAI GPT-4o",
				family: "openai",
				version: "2024-11-20",
				detail: "OpenAI API",
				maxInputTokens: 124000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 128000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "openai",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "gpt-4o-mini",
				name: "OpenAI GPT-4o-mini",
				family: "openai",
				version: "2024-07-18",
				detail: "OpenAI API",
				maxInputTokens: 124000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 128000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "openai",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "o3-mini",
				name: "OpenAI o3-mini (Reasoning)",
				family: "openai",
				version: "2025-01-31",
				detail: "OpenAI API",
				maxInputTokens: 124000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 128000,
				capabilities: { toolCalling: true },
				provider: "openai",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		// 5. Anthropic Claude Models
		const anthropicConfig = vscode.workspace.getConfiguration("omen.providers.anthropic");
		if (anthropicConfig.get<boolean>("enabled", true)) {
			const baseUrl = anthropicConfig
				.get<string>("baseUrl", "https://api.anthropic.com/v1")
				.replace(/\/+$/, "");
			models.push({
				id: "claude-3-7-sonnet-latest",
				name: "Anthropic Claude 3.7 Sonnet",
				family: "claude",
				version: "3.7",
				detail: "Anthropic API",
				maxInputTokens: 180000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 200000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "anthropic",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "claude-3-5-haiku-latest",
				name: "Anthropic Claude 3.5 Haiku",
				family: "claude",
				version: "3.5",
				detail: "Anthropic API",
				maxInputTokens: 180000,
				maxOutputTokens: 8192,
				maxContextWindowTokens: 200000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "anthropic",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		// 6. Google Gemini Models
		const geminiConfig = vscode.workspace.getConfiguration("omen.providers.gemini");
		if (geminiConfig.get<boolean>("enabled", true)) {
			const baseUrl = geminiConfig
				.get<string>("baseUrl", "https://generativelanguage.googleapis.com/v1beta/openai")
				.replace(/\/+$/, "");
			models.push({
				id: "gemini-2.5-pro",
				name: "Google Gemini 2.5 Pro",
				family: "gemini",
				version: "2.5",
				detail: "Google Gemini API",
				maxInputTokens: 900000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "gemini",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "gemini-2.5-flash",
				name: "Google Gemini 2.5 Flash",
				family: "gemini",
				version: "2.5",
				detail: "Google Gemini API",
				maxInputTokens: 900000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "gemini",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		// 7. Meta Muse Models (https://api.meta.ai/v1)
		const metaConfig = vscode.workspace.getConfiguration("omen.providers.meta");
		if (metaConfig.get<boolean>("enabled", true)) {
			let baseUrl = metaConfig
				.get<string>("baseUrl", "https://api.meta.ai/v1")
				.replace(/\/+$/, "");
			if (
				baseUrl === "https://api.meta.com/v1" ||
				baseUrl === "https://api.llama.com/compat/v1"
			) {
				baseUrl = "https://api.meta.ai/v1";
			}
			models.push({
				id: "muse-spark-1.3",
				name: "Meta Muse Spark 1.3 (Agentic Coding)",
				family: "meta-muse",
				version: "1.3",
				detail: "Meta Model API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "meta",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
				isDefault: true,
			});
			models.push({
				id: "muse-wonder-1.0",
				name: "Meta Muse Wonder 1.0 (Frontier Reasoning)",
				family: "meta-muse",
				version: "1.0",
				detail: "Meta Model API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 128000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "meta",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "muse-spark-1.3-contributor",
				name: "Meta Muse Spark 1.3 (Contributor)",
				family: "meta-muse",
				version: "1.3",
				detail: "Meta Model API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "meta",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "muse-spark-1.2",
				name: "Meta Muse Spark 1.2",
				family: "meta-muse",
				version: "1.2",
				detail: "Meta Model API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "meta",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "muse-spark-1.1",
				name: "Meta Muse Spark 1.1",
				family: "meta-muse",
				version: "1.1",
				detail: "Meta Model API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 1000000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "meta",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		// 8. OpenRouter Unified Third-Party Models
		const openrouterConfig = vscode.workspace.getConfiguration("omen.providers.openrouter");
		if (openrouterConfig.get<boolean>("enabled", true)) {
			const baseUrl = openrouterConfig
				.get<string>("baseUrl", "https://openrouter.ai/api/v1")
				.replace(/\/+$/, "");
			models.push({
				id: "openrouter/auto",
				name: "OpenRouter: Auto Router",
				family: "openrouter",
				version: "1.0",
				detail: "OpenRouter API",
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 128000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "openrouter",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
			models.push({
				id: "anthropic/claude-3.7-sonnet",
				name: "OpenRouter: Claude 3.7 Sonnet",
				family: "openrouter",
				version: "3.7",
				detail: "OpenRouter API",
				maxInputTokens: 180000,
				maxOutputTokens: 16384,
				maxContextWindowTokens: 200000,
				capabilities: { toolCalling: true, imageInput: true },
				provider: "openrouter",
				baseUrl,
				isBYOK: true,
				isUserSelectable: true,
			});
		}

		return models;
	}

	async provideTokenCount(
		_model: OmenChatModelInfo,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
		let totalLen = 0;
		if (Array.isArray(text.content)) {
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalLen += part.value.length;
				} else if (typeof part === "string") {
					totalLen += (part as string).length;
				}
			}
		}
		return Math.ceil(totalLen / 4);
	}

	async provideLanguageModelChatResponse(
		model: OmenChatModelInfo,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		let apiKey = "";
		if (model.provider !== "ollama" && model.provider !== "lan") {
			apiKey = (await this.secretManager.getKeyForProvider(model.provider)) || "";
			if (!apiKey) {
				const action = await vscode.window.showErrorMessage(
					`${model.name} requires a ${model.provider.toUpperCase()} API Key.`,
					"Set API Key",
				);
				if (action === "Set API Key") {
					await this.secretManager.promptForApiKey();
					apiKey = (await this.secretManager.getKeyForProvider(model.provider)) || "";
				}
				if (!apiKey) {
					throw new Error(
						`Missing API key for ${model.name} (${model.provider}). Configure it via 'Omen: Set API Key'.`,
					);
				}
			}
		}

		const formattedMessages: { role: string; content: string }[] = [];
		for (const msg of messages) {
			let role = "user";
			if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
				role = "assistant";
			} else if (msg.role === vscode.LanguageModelChatMessageRole.User) {
				role = "user";
			}

			let textContent = "";
			if (typeof msg.content === "string") {
				textContent = msg.content;
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part instanceof vscode.LanguageModelTextPart) {
						textContent += part.value;
					}
				}
			}

			formattedMessages.push({ role, content: textContent });
		}

		const targetModelId = model.id
			.replace(/^ollama\//, "")
			.replace(/^lan\/[^/]+\//, "");

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
			if (model.provider === "anthropic") {
				headers["x-api-key"] = apiKey;
				headers["anthropic-version"] = "2023-06-01";
			}
		}

		const response = await fetch(`${model.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: targetModelId,
				messages: formattedMessages,
				stream: true,
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`${model.name} error (HTTP ${response.status}): ${errText}`);
		}

		if (!response.body) {
			throw new Error("Response body stream is empty");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line.startsWith("data:")) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") {
					return;
				}
				try {
					const json = JSON.parse(payload) as {
						choices?: {
							delta?: {
								content?: string;
								reasoning_content?: string;
							};
						}[];
					};
					const delta = json.choices?.[0]?.delta;
					if (delta?.reasoning_content) {
						progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
					}
					if (delta?.content) {
						progress.report(new vscode.LanguageModelTextPart(delta.content));
					}
				} catch {
					// Ignore partial SSE JSON chunks
				}
			}
		}
	}
}
