/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as path from "path";
import { SecretManager } from "./secretManager.js";
import { OllamaManager } from "./ollamaManager.js";

export interface AgentFileDiff {
	filePath: string;
	originalContent: string;
	modifiedContent: string;
	status: "modified" | "added" | "deleted";
	additions: number;
	deletions: number;
}

export interface AgentActivityStep {
	time: string;
	text: string;
	kind: "step" | "tool" | "diff" | "success" | "info" | "error";
}

export interface AgentSession {
	id: string;
	title: string;
	prompt: string;
	timestamp: string;
	status: "running" | "review" | "completed" | "rejected" | "error";
	filesChanged: AgentFileDiff[];
	activityLog: AgentActivityStep[];
	targetUri?: vscode.Uri;
	targetUriString?: string;
	modelId?: string;
}

export interface SelectableModelOption {
	id: string;
	name: string;
	provider: "deepseek" | "openai" | "meta" | "ollama";
	baseUrl: string;
}

const SESSIONS_STORAGE_KEY = "omen.agentSessions.v1";
const SELECTED_MODEL_STORAGE_KEY = "omen.selectedModelId.v1";

export class AgentDiffManager implements vscode.TextDocumentContentProvider {
	public static readonly scheme = "omen-agent";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChange.event;

	private _sessions: AgentSession[] = [];
	private _selectedSessionId?: string;
	private _selectedModelId: string;
	private readonly _activeCancellations = new Map<
		string,
		vscode.CancellationTokenSource
	>();

	private readonly _onDidUpdateSessions = new vscode.EventEmitter<
		AgentSession[]
	>();
	public readonly onDidUpdateSessions = this._onDidUpdateSessions.event;

	private readonly _onDidChangeSelectedModel =
		new vscode.EventEmitter<SelectableModelOption>();
	public readonly onDidChangeSelectedModel =
		this._onDidChangeSelectedModel.event;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _secretManager: SecretManager,
		private readonly _clusterProvider?: {
			getVerifiedWorkerNodes(): Array<{
				ip: string;
				name: string;
				installedModels?: string[];
			}>;
		},
	) {
		this._selectedModelId =
			this._context.globalState.get<string>(SELECTED_MODEL_STORAGE_KEY) ||
			"deepseek-chat";
		this._loadPersistedSessions();
	}

	public get sessions(): AgentSession[] {
		return this._sessions;
	}

	public get selectedSession(): AgentSession | undefined {
		return this._sessions.find((s) => s.id === this._selectedSessionId);
	}

	public get selectedModelId(): string {
		return this._selectedModelId;
	}

	public async getAvailableModels(): Promise<SelectableModelOption[]> {
		const options: SelectableModelOption[] = [];

		const deepseekConfig = vscode.workspace.getConfiguration(
			"omen.providers.deepseek",
		);
		if (deepseekConfig.get<boolean>("enabled", true)) {
			const baseUrl = deepseekConfig
				.get<string>("baseUrl", "https://api.deepseek.com/v1")
				.replace(/\/+$/, "");
			options.push(
				{
					id: "deepseek-chat",
					name: "DeepSeek-V3 (Chat)",
					provider: "deepseek",
					baseUrl,
				},
				{
					id: "deepseek-reasoner",
					name: "DeepSeek-R1 (Reasoning)",
					provider: "deepseek",
					baseUrl,
				},
			);
		}

		const openaiConfig = vscode.workspace.getConfiguration(
			"omen.providers.openai",
		);
		if (openaiConfig.get<boolean>("enabled", true)) {
			const baseUrl = openaiConfig
				.get<string>("baseUrl", "https://api.openai.com/v1")
				.replace(/\/+$/, "");
			options.push(
				{
					id: "gpt-4o",
					name: "OpenAI GPT-4o",
					provider: "openai",
					baseUrl,
				},
				{
					id: "gpt-4o-mini",
					name: "OpenAI GPT-4o-mini",
					provider: "openai",
					baseUrl,
				},
			);
		}

		const metaConfig = vscode.workspace.getConfiguration("omen.providers.meta");
		if (metaConfig.get<boolean>("enabled", true)) {
			const baseUrl = metaConfig
				.get<string>("baseUrl", "https://api.meta.com/v1")
				.replace(/\/+$/, "");
			options.push(
				{
					id: "muse-spark",
					name: "Meta Muse Spark (Agentic)",
					provider: "meta",
					baseUrl,
				},
				{
					id: "muse-wonder",
					name: "Meta Muse Wonder (Reasoning)",
					provider: "meta",
					baseUrl,
				},
				{
					id: "llama-3.3-70b-instruct",
					name: "Meta Llama 3.3 70B Instruct",
					provider: "meta",
					baseUrl,
				},
			);
		}

		const ollamaConfig = vscode.workspace.getConfiguration(
			"omen.providers.ollama",
		);
		if (ollamaConfig.get<boolean>("enabled", true)) {
			try {
				const baseUrl = OllamaManager.getBaseUrl();
				const localModels = await OllamaManager.listInstalledModels();
				for (const m of localModels) {
					options.push({
						id: `ollama/${m.name}`,
						name: `Ollama: ${m.name}`,
						provider: "ollama",
						baseUrl: `${baseUrl}/v1`,
					});
				}
			} catch {
				// Ollama offline
			}

			// Add paired worker models (e.g. Nitro 5)
			if (this._clusterProvider) {
				const workers = this._clusterProvider.getVerifiedWorkerNodes();
				for (const w of workers) {
					if (Array.isArray(w.installedModels)) {
						for (const modelName of w.installedModels) {
							options.push({
								id: `lan/${w.ip}/${modelName}`,
								name: `LAN (${w.ip}): ${modelName}`,
								provider: "ollama",
								baseUrl: `http://${w.ip}:11434/v1`,
							});
						}
					}
				}
			}
		}

		return options;
	}

	public async getSelectedModelOption(): Promise<SelectableModelOption> {
		const models = await this.getAvailableModels();
		return (
			models.find((m) => m.id === this._selectedModelId) ||
			models[0] || {
				id: "deepseek-chat",
				name: "DeepSeek-V3 (Chat)",
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
			}
		);
	}

	public async setSelectedModelId(modelId: string): Promise<void> {
		this._selectedModelId = modelId;
		await this._context.globalState.update(
			SELECTED_MODEL_STORAGE_KEY,
			modelId,
		);
		const selected = await this.getSelectedModelOption();
		this._onDidChangeSelectedModel.fire(selected);
	}

	private _loadPersistedSessions(): void {
		const raw = this._context.workspaceState.get<AgentSession[]>(
			SESSIONS_STORAGE_KEY,
		);
		if (!Array.isArray(raw)) {
			this._sessions = [];
			return;
		}
		this._sessions = raw.map((s) => {
			const wasRunning = s.status === "running";
			const restoredUri = s.targetUriString
				? vscode.Uri.parse(s.targetUriString)
				: undefined;
			const activityLog = Array.isArray(s.activityLog) ? [...s.activityLog] : [];
			if (wasRunning) {
				activityLog.push({
					time: this._now(),
					text: "Session interrupted by workbench reload.",
					kind: "error",
				});
			}
			return {
				...s,
				status: wasRunning ? "error" : s.status,
				timestamp: wasRunning ? "Interrupted" : s.timestamp,
				targetUri: restoredUri,
				activityLog,
			};
		});
		if (this._sessions.length > 0) {
			this._selectedSessionId = this._sessions[0].id;
		}
	}

	private _persistAndNotify(): void {
		const serializable = this._sessions.map((s) => ({
			id: s.id,
			title: s.title,
			prompt: s.prompt,
			timestamp: s.timestamp,
			status: s.status,
			filesChanged: s.filesChanged,
			activityLog: s.activityLog,
			targetUriString: s.targetUri ? s.targetUri.toString() : s.targetUriString,
			modelId: s.modelId,
		}));
		void this._context.workspaceState.update(
			SESSIONS_STORAGE_KEY,
			serializable,
		);
		this._onDidUpdateSessions.fire(this._sessions);
	}

	public selectSession(sessionId: string): void {
		this._selectedSessionId = sessionId;
		this._persistAndNotify();
	}

	public cancelSession(sessionId: string): void {
		const tokenSource = this._activeCancellations.get(sessionId);
		if (tokenSource) {
			tokenSource.cancel();
			tokenSource.dispose();
			this._activeCancellations.delete(sessionId);
		}
		const session = this._sessions.find((s) => s.id === sessionId);
		if (session && session.status === "running") {
			session.status = "rejected";
			session.timestamp = "Cancelled";
			session.activityLog.push({
				time: this._now(),
				text: "⏹ Agent execution cancelled by developer.",
				kind: "info",
			});
			this._persistAndNotify();
		}
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const parts = uri.path.split("/").filter(Boolean);
		if (parts.length < 2) {
			return "";
		}
		const side = parts[0]; // "original" or "modified"
		const sessionId = parts[1];
		const filePath = parts.slice(2).join("/");

		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session) {
			return "";
		}
		const fileDiff = session.filesChanged.find((f) => f.filePath === filePath);
		if (!fileDiff) {
			return "";
		}
		return side === "original"
			? fileDiff.originalContent
			: fileDiff.modifiedContent;
	}

	public async showDiff(
		session: AgentSession,
		fileDiff?: AgentFileDiff,
	): Promise<void> {
		this._selectedSessionId = session.id;
		this._persistAndNotify();

		const target = fileDiff ?? session.filesChanged[0];
		if (!target) {
			return;
		}

		const originalUri = vscode.Uri.parse(
			`${AgentDiffManager.scheme}://omen-diff/original/${session.id}/${target.filePath}`,
		);
		const modifiedUri = vscode.Uri.parse(
			`${AgentDiffManager.scheme}://omen-diff/modified/${session.id}/${target.filePath}`,
		);

		const title = `${path.basename(target.filePath)} (Agent Changes: ${session.title})`;
		await vscode.commands.executeCommand(
			"vscode.diff",
			originalUri,
			modifiedUri,
			title,
			{ preview: true },
		);
	}

	public async acceptSessionDiff(sessionId: string): Promise<void> {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session || !session.filesChanged[0]) {
			return;
		}

		const fileDiff = session.filesChanged[0];
		let targetUri = session.targetUri;
		if (!targetUri && session.targetUriString) {
			targetUri = vscode.Uri.parse(session.targetUriString);
		}
		if (!targetUri && vscode.workspace.workspaceFolders?.[0]) {
			targetUri = vscode.Uri.joinPath(
				vscode.workspace.workspaceFolders[0].uri,
				fileDiff.filePath,
			);
		}

		if (targetUri) {
			try {
				const data = Buffer.from(fileDiff.modifiedContent, "utf8");
				await vscode.workspace.fs.writeFile(targetUri, data);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to write file to disk: ${message}`);
				return;
			}
		}

		session.status = "completed";
		session.timestamp = "Completed";
		session.activityLog.push({
			time: this._now(),
			text: `✓ Changes applied directly to ${fileDiff.filePath} and staged on disk.`,
			kind: "success",
		});
		this._persistAndNotify();
		vscode.window.showInformationMessage(
			`✓ Agent changes applied to ${path.basename(fileDiff.filePath)}. Git working tree updated.`,
		);
	}

	public rejectSessionDiff(sessionId: string): Promise<void> {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session) {
			return Promise.resolve();
		}
		session.status = "rejected";
		session.timestamp = "Discarded";
		session.activityLog.push({
			time: this._now(),
			text: "✕ Proposed changes discarded by developer.",
			kind: "info",
		});
		this._persistAndNotify();
		vscode.window.showInformationMessage(
			`Agent diff discarded: ${session.title}`,
		);
		return Promise.resolve();
	}

	public async executeRealAgent(
		prompt: string,
		specifiedUri?: vscode.Uri,
		overrideModelId?: string,
	): Promise<AgentSession | undefined> {
		if (overrideModelId) {
			await this.setSelectedModelId(overrideModelId);
		}
		const modelOption = await this.getSelectedModelOption();

		const targetUri = await this._resolveTargetFile(prompt, specifiedUri);
		if (!targetUri) {
			vscode.window.showWarningMessage(
				"No target file selected. Please open a file or specify a valid file path in your prompt.",
			);
			return undefined;
		}

		let originalContent = "";
		try {
			const rawBytes = await vscode.workspace.fs.readFile(targetUri);
			originalContent = Buffer.from(rawBytes).toString("utf8");
		} catch {
			originalContent = "";
		}

		const relativePath = vscode.workspace.asRelativePath(targetUri);
		const id = `agent-${Date.now()}`;
		const title = prompt.length > 55 ? prompt.substring(0, 52) + "..." : prompt;

		const tokenSource = new vscode.CancellationTokenSource();
		this._activeCancellations.set(id, tokenSource);

		const session: AgentSession = {
			id,
			title,
			prompt,
			timestamp: "Running",
			status: "running",
			targetUri,
			targetUriString: targetUri.toString(),
			modelId: modelOption.id,
			filesChanged: [
				{
					filePath: relativePath,
					originalContent,
					modifiedContent: originalContent,
					status: "modified",
					additions: 0,
					deletions: 0,
				},
			],
			activityLog: [
				{ time: this._now(), text: `Agent initiated: "${prompt}"`, kind: "step" },
				{
					time: this._now(),
					text: `Target file resolved: ${relativePath} (${originalContent.split("\n").length} lines)`,
					kind: "tool",
				},
				{
					time: this._now(),
					text: `Selected model: ${modelOption.name} (${modelOption.id})`,
					kind: "step",
				},
			],
		};

		this._sessions.unshift(session);
		this._selectedSessionId = id;
		this._persistAndNotify();

		try {
			const modifiedCode = await this._queryLLM(
				prompt,
				relativePath,
				originalContent,
				modelOption,
				tokenSource.token,
				(statusText) => {
					session.activityLog.push({
						time: this._now(),
						text: statusText,
						kind: "info",
					});
					this._persistAndNotify();
				},
			);

			if (tokenSource.token.isCancellationRequested) {
				return session;
			}

			const metrics = this._computeDiffMetrics(originalContent, modifiedCode);
			session.filesChanged[0].modifiedContent = modifiedCode;
			session.filesChanged[0].additions = metrics.additions;
			session.filesChanged[0].deletions = metrics.deletions;
			session.status = "review";
			session.timestamp = "Review";

			session.activityLog.push({
				time: this._now(),
				text: `Code generation complete (+${metrics.additions} -${metrics.deletions} lines). Awaiting developer review.`,
				kind: "diff",
			});
			this._onDidChange.fire(
				vscode.Uri.parse(
					`${AgentDiffManager.scheme}://omen-diff/modified/${session.id}/${relativePath}`,
				),
			);
			this._persistAndNotify();
			await this.showDiff(session);
			return session;
		} catch (err: unknown) {
			if (tokenSource.token.isCancellationRequested) {
				return session;
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			session.status = "error";
			session.timestamp = "Error";
			session.activityLog.push({
				time: this._now(),
				text: `Agent execution failed: ${errMsg}`,
				kind: "error",
			});
			this._persistAndNotify();
			return session;
		} finally {
			const stored = this._activeCancellations.get(id);
			if (stored) {
				stored.dispose();
				this._activeCancellations.delete(id);
			}
		}
	}

	private async _resolveTargetFile(
		prompt: string,
		specifiedUri?: vscode.Uri,
	): Promise<vscode.Uri | undefined> {
		if (specifiedUri && specifiedUri.scheme === "file") {
			return specifiedUri;
		}

		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && activeEditor.document.uri.scheme === "file") {
			return activeEditor.document.uri;
		}

		const fileMatch = prompt.match(
			/(?:[a-zA-Z0-9_\-\./]+)\.(?:tsx?|jsx?|py|json|css|html|md|vue|svelte)/i,
		);
		if (fileMatch && vscode.workspace.workspaceFolders?.[0]) {
			const candidatePath = fileMatch[0];
			const uri = vscode.Uri.joinPath(
				vscode.workspace.workspaceFolders[0].uri,
				candidatePath,
			);
			try {
				await vscode.workspace.fs.stat(uri);
				return uri;
			} catch {
				// Continue to picker fallback
			}
		}

		if (vscode.workspace.workspaceFolders?.[0]) {
			const files = await vscode.workspace.findFiles(
				"**/*.{ts,tsx,js,jsx,py,json,css,html}",
				"**/node_modules/**",
				30,
			);
			if (files.length > 0) {
				const pick = await vscode.window.showQuickPick(
					files.map((f) => ({
						label: path.basename(f.fsPath),
						description: vscode.workspace.asRelativePath(f),
						uri: f,
					})),
					{ placeHolder: "Select target file for the Agent to refactor and diff" },
				);
				if (pick) {
					return pick.uri;
				}
			}
		}

		return undefined;
	}

	private async _queryLLM(
		prompt: string,
		relativePath: string,
		originalContent: string,
		modelOption: SelectableModelOption,
		token: vscode.CancellationToken,
		onProgress: (statusText: string) => void,
	): Promise<string> {
		// 1. Attempt official VS Code Language Model API matching the selected model ID
		try {
			const models = await vscode.lm.selectChatModels({
				vendor: "omen",
				id: modelOption.id,
			});
			const matchedModel = models?.[0];
			if (matchedModel) {
				onProgress(`Dispatching via vscode.lm to ${matchedModel.name}...`);
				const messages = [
					vscode.LanguageModelChatMessage.User(
						`You are an expert autonomous software engineer.\nInstruction: ${prompt}\n\nTarget File: ${relativePath}\nOriginal Content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nCRITICAL: Return ONLY the raw modified file content without markdown code fences or explanatory text.`,
					),
				];
				const response = await matchedModel.sendRequest(messages, {}, token);
				let fullText = "";
				for await (const chunk of response.text) {
					if (token.isCancellationRequested) {
						throw new Error("Cancelled");
					}
					fullText += chunk;
				}
				if (fullText.trim()) {
					return this._cleanModelOutput(fullText);
				}
			}
		} catch (err: unknown) {
			if (token.isCancellationRequested) {
				throw err;
			}
			// Fall back to direct provider HTTP call for the selected model
		}

		// 2. Direct Provider Call for the chosen modelOption
		let apiKey: string | undefined;
		if (modelOption.provider === "deepseek") {
			apiKey = await this._secretManager.getDeepSeekApiKey();
		} else if (modelOption.provider === "openai") {
			apiKey = await this._secretManager.getOpenAIApiKey();
		} else if (modelOption.provider === "meta") {
			apiKey = await this._secretManager.getMetaApiKey();
		}

		if (modelOption.provider !== "ollama" && !apiKey) {
			const setKeyAction = `Set ${modelOption.provider.toUpperCase()} API Key`;
			void vscode.window
				.showErrorMessage(
					`${modelOption.name} requires a configured ${modelOption.provider.toUpperCase()} API Key.`,
					setKeyAction,
				)
				.then((sel) => {
					if (sel === setKeyAction) {
						void this._secretManager.promptForApiKey();
					}
				});

			throw new Error(
				`Missing API key for ${modelOption.name} (${modelOption.provider}). Configure it via 'Omen: Set API Key'.`,
			);
		}

		onProgress(`Connecting to ${modelOption.name} (${modelOption.baseUrl})...`);

		const targetModelName = modelOption.id.startsWith("ollama/")
			? modelOption.id.replace("ollama/", "")
			: modelOption.id;

		const abortController = new AbortController();
		const cancelSub = token.onCancellationRequested(() =>
			abortController.abort(),
		);

		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (apiKey) {
				headers["Authorization"] = `Bearer ${apiKey}`;
			}

			const resp = await fetch(`${modelOption.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				signal: abortController.signal,
				body: JSON.stringify({
					model: targetModelName,
					messages: [
						{
							role: "system",
							content:
								"You are an expert software engineer. Modify the given code according to developer instructions. Return ONLY the complete updated file content without markdown code blocks, backticks, or commentary.",
						},
						{
							role: "user",
							content: `Instruction: ${prompt}\n\nFile: ${relativePath}\n\`\`\`\n${originalContent}\n\`\`\``,
						},
					],
					temperature: 0.2,
				}),
			});

			if (!resp.ok) {
				const errText = await resp.text();
				throw new Error(
					`${modelOption.name} returned HTTP ${resp.status}: ${errText}`,
				);
			}

			const data = (await resp.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			const output = data.choices?.[0]?.message?.content;
			if (!output || !output.trim()) {
				throw new Error(`Empty response received from ${modelOption.name}.`);
			}
			return this._cleanModelOutput(output);
		} finally {
			cancelSub.dispose();
		}
	}

	private _cleanModelOutput(raw: string): string {
		let text = raw.trim();
		if (text.startsWith("```")) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline !== -1) {
				text = text.substring(firstNewline + 1);
			}
			if (text.endsWith("```")) {
				text = text.substring(0, text.length - 3).trimEnd();
			}
		}
		return text;
	}

	private _computeDiffMetrics(
		original: string,
		modified: string,
	): { additions: number; deletions: number } {
		const origLines = original.split("\n");
		const modLines = modified.split("\n");
		const origSet = new Set(origLines);
		const modSet = new Set(modLines);

		let additions = 0;
		let deletions = 0;

		for (const line of modLines) {
			if (!origSet.has(line)) {
				additions++;
			}
		}
		for (const line of origLines) {
			if (!modSet.has(line)) {
				deletions++;
			}
		}

		if (additions === 0 && deletions === 0 && original !== modified) {
			additions = 1;
		}

		return { additions, deletions };
	}

	private _now(): string {
		const d = new Date();
		const mm = String(d.getMinutes()).padStart(2, "0");
		const ss = String(d.getSeconds()).padStart(2, "0");
		return `${mm}:${ss}`;
	}
}
