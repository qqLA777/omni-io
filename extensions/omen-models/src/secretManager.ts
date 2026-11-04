/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";

export type OmenCloudProvider = "meta" | "deepseek" | "openai" | "anthropic" | "gemini" | "openrouter";

export class SecretManager {
	private static readonly DEEPSEEK_SECRET_KEY = "omen.secrets.deepseekApiKey";
	private static readonly OPENAI_SECRET_KEY = "omen.secrets.openaiApiKey";
	private static readonly META_SECRET_KEY = "omen.secrets.metaApiKey";
	private static readonly ANTHROPIC_SECRET_KEY = "omen.secrets.anthropicApiKey";
	private static readonly GEMINI_SECRET_KEY = "omen.secrets.geminiApiKey";
	private static readonly OPENROUTER_SECRET_KEY = "omen.secrets.openrouterApiKey";

	constructor(private readonly context: vscode.ExtensionContext) {}

	async getDeepSeekApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.DEEPSEEK_SECRET_KEY);
	}

	async setDeepSeekApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.DEEPSEEK_SECRET_KEY, key);
	}

	async getOpenAIApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.OPENAI_SECRET_KEY);
	}

	async setOpenAIApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.OPENAI_SECRET_KEY, key);
	}

	private static readonly DEFAULT_META_API_KEY =
		"LLM_1581309667132854_QMRdLO1QTHPDROrBUhLSFip1Hyo";

	async getMetaApiKey(): Promise<string | undefined> {
		const stored = await this.context.secrets.get(SecretManager.META_SECRET_KEY);
		if (stored && stored.trim()) {
			return stored.trim();
		}
		const envKey = process.env.MODEL_API_KEY || process.env.META_API_KEY;
		if (envKey && envKey.trim()) {
			return envKey.trim();
		}
		return SecretManager.DEFAULT_META_API_KEY;
	}

	async setMetaApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.META_SECRET_KEY, key);
	}

	async getAnthropicApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.ANTHROPIC_SECRET_KEY);
	}

	async setAnthropicApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.ANTHROPIC_SECRET_KEY, key);
	}

	async getGeminiApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.GEMINI_SECRET_KEY);
	}

	async setGeminiApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.GEMINI_SECRET_KEY, key);
	}

	async getOpenRouterApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.OPENROUTER_SECRET_KEY);
	}

	async setOpenRouterApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.OPENROUTER_SECRET_KEY, key);
	}

	async getKeyForProvider(provider: OmenCloudProvider): Promise<string | undefined> {
		switch (provider) {
			case "meta":
				return this.getMetaApiKey();
			case "deepseek":
				return this.getDeepSeekApiKey();
			case "openai":
				return this.getOpenAIApiKey();
			case "anthropic":
				return this.getAnthropicApiKey();
			case "gemini":
				return this.getGeminiApiKey();
			case "openrouter":
				return this.getOpenRouterApiKey();
		}
	}

	async getActiveKey(): Promise<{ provider: OmenCloudProvider; key: string } | undefined> {
		const providers: OmenCloudProvider[] = ["meta", "deepseek", "openai", "anthropic", "gemini", "openrouter"];
		for (const provider of providers) {
			const key = await this.getKeyForProvider(provider);
			if (key) {
				return { provider, key };
			}
		}
		return undefined;
	}

	async promptForApiKey(): Promise<void> {
		const choice = await vscode.window.showQuickPick<{
			label: string;
			description: string;
			provider: OmenCloudProvider;
			placeholder: string;
		}>(
			[
				{
					label: "$(key) DeepSeek API Key",
					description: "For deepseek-chat & deepseek-reasoner",
					provider: "deepseek",
					placeholder: "sk-...",
				},
				{
					label: "$(key) OpenAI API Key",
					description: "For gpt-4o, gpt-4o-mini, o3-mini",
					provider: "openai",
					placeholder: "sk-proj-...",
				},
				{
					label: "$(key) Anthropic Claude API Key",
					description: "For claude-3-7-sonnet-latest & claude-3-5-haiku-latest",
					provider: "anthropic",
					placeholder: "sk-ant-...",
				},
				{
					label: "$(key) Google Gemini API Key",
					description: "For gemini-2.5-pro & gemini-2.5-flash",
					provider: "gemini",
					placeholder: "AIzaSy...",
				},
				{
					label: "$(sparkle) Meta Muse / Llama API Key",
					description: "For Muse Spark, Muse Wonder & Llama models",
					provider: "meta",
					placeholder: "LLM|...",
				},
				{
					label: "$(globe) OpenRouter API Key",
					description: "For OpenRouter unified third-party LLMs",
					provider: "openrouter",
					placeholder: "sk-or-v1-...",
				},
			],
			{ placeHolder: "Select LLM provider to configure API Key" },
		);

		if (!choice) {
			return;
		}

		const currentKey = await this.getKeyForProvider(choice.provider);

		const inputKey = await vscode.window.showInputBox({
			title: `Enter ${choice.provider.toUpperCase()} API Key`,
			password: true,
			value: currentKey || "",
			placeHolder: choice.placeholder,
			prompt: "Key is securely stored in your OS native keychain",
		});

		if (inputKey !== undefined) {
			const trimmed = inputKey.trim();
			switch (choice.provider) {
				case "meta":
					await this.setMetaApiKey(trimmed);
					break;
				case "deepseek":
					await this.setDeepSeekApiKey(trimmed);
					break;
				case "openai":
					await this.setOpenAIApiKey(trimmed);
					break;
				case "anthropic":
					await this.setAnthropicApiKey(trimmed);
					break;
				case "gemini":
					await this.setGeminiApiKey(trimmed);
					break;
				case "openrouter":
					await this.setOpenRouterApiKey(trimmed);
					break;
			}
			vscode.window.showInformationMessage(`${choice.provider.toUpperCase()} API Key saved.`);
		}
	}
}
