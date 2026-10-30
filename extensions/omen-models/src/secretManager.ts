/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";

export class SecretManager {
	private static readonly DEEPSEEK_SECRET_KEY = "omen.secrets.deepseekApiKey";
	private static readonly OPENAI_SECRET_KEY = "omen.secrets.openaiApiKey";
	private static readonly META_SECRET_KEY = "omen.secrets.metaApiKey";

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

	async getMetaApiKey(): Promise<string | undefined> {
		return this.context.secrets.get(SecretManager.META_SECRET_KEY);
	}

	async setMetaApiKey(key: string): Promise<void> {
		await this.context.secrets.store(SecretManager.META_SECRET_KEY, key);
	}

	async getActiveKey(): Promise<{ provider: "meta" | "deepseek" | "openai"; key: string } | undefined> {
		const metaKey = await this.getMetaApiKey();
		if (metaKey) {
			return { provider: "meta", key: metaKey };
		}
		const deepseekKey = await this.getDeepSeekApiKey();
		if (deepseekKey) {
			return { provider: "deepseek", key: deepseekKey };
		}
		const openaiKey = await this.getOpenAIApiKey();
		if (openaiKey) {
			return { provider: "openai", key: openaiKey };
		}
		return undefined;
	}

	async promptForApiKey(): Promise<void> {
		const choice = await vscode.window.showQuickPick(
			[
				{
					label: "$(sparkle) Meta Muse / Llama API Key",
					description: "For Muse Spark, Muse Wonder & Llama models",
					provider: "meta",
				},
				{
					label: "$(key) DeepSeek API Key",
					description: "For deepseek-chat & deepseek-reasoner",
					provider: "deepseek",
				},
				{
					label: "$(key) OpenAI API Key",
					description: "For gpt-4o, gpt-4o-mini, o1, o3-mini",
					provider: "openai",
				},
			],
			{ placeHolder: "Select provider to configure API Key" },
		);

		if (!choice) {
			return;
		}

		let currentKey: string | undefined;
		if (choice.provider === "meta") {
			currentKey = await this.getMetaApiKey();
		} else if (choice.provider === "deepseek") {
			currentKey = await this.getDeepSeekApiKey();
		} else {
			currentKey = await this.getOpenAIApiKey();
		}

		const inputKey = await vscode.window.showInputBox({
			title: `Enter ${choice.provider.toUpperCase()} API Key`,
			password: true,
			value: currentKey || "",
			placeHolder: choice.provider === "meta" ? "meta_..." : choice.provider === "deepseek" ? "sk-..." : "sk-proj-...",
			prompt: "Key is securely stored in your OS native keychain",
		});

		if (inputKey !== undefined) {
			if (choice.provider === "meta") {
				await this.setMetaApiKey(inputKey.trim());
			} else if (choice.provider === "deepseek") {
				await this.setDeepSeekApiKey(inputKey.trim());
			} else {
				await this.setOpenAIApiKey(inputKey.trim());
			}
			vscode.window.showInformationMessage(
				`✓ ${choice.provider.toUpperCase()} API Key saved securely.`,
			);
		}
	}
}
