/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
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

export interface AgentChatMessage {
	role: "user" | "assistant";
	content: string;
	time: string;
}

export interface AgentSession {
	id: string;
	title: string;
	prompt: string;
	timestamp: string;
	createdAt?: number;
	pinned?: boolean;
	projectName?: string;
	folderPath?: string;
	messages?: AgentChatMessage[];
	status: "running" | "review" | "completed" | "rejected" | "error";
	filesChanged: AgentFileDiff[];
	activityLog: AgentActivityStep[];
	targetUri?: vscode.Uri;
	targetUriString?: string;
	modelId?: string;
	durationSeconds?: number;
}

export interface SelectableModelOption {
	id: string;
	name: string;
	provider: "deepseek" | "openai" | "meta" | "anthropic" | "gemini" | "openrouter" | "ollama";
	baseUrl: string;
}

const SESSIONS_STORAGE_KEY = "omen.agentSessions.v1";
const SELECTED_MODEL_STORAGE_KEY = "omen.selectedModelId.v1";
const SELECTED_FOLDER_STORAGE_KEY = "omen.selectedFolderPath.v1";
const RECENT_FOLDERS_STORAGE_KEY = "omen.recentFolders.v1";

export class AgentDiffManager implements vscode.TextDocumentContentProvider {
	public static readonly scheme = "omen-agent";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChange.event;

	private _sessions: AgentSession[] = [];
	private _selectedSessionId?: string;
	private _selectedModelId: string;
	private _selectedFolderPath: string;
	private _recentFolders: string[] = [];
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
		const savedModelId = this._context.globalState.get<string>(
			SELECTED_MODEL_STORAGE_KEY,
		);
		this._selectedModelId =
			!savedModelId ||
			savedModelId === "deepseek-chat" ||
			savedModelId === "deepseek-reasoner" ||
			savedModelId === "muse-spark"
				? "muse-spark-1.3"
				: savedModelId;

		const defaultFolder =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		const savedFolder = this._context.globalState.get<string>(
			SELECTED_FOLDER_STORAGE_KEY,
		);
		this._selectedFolderPath =
			savedFolder && fs.existsSync(savedFolder) ? savedFolder : defaultFolder;

		const savedRecents = this._context.globalState.get<string[]>(
			RECENT_FOLDERS_STORAGE_KEY,
		);
		this._recentFolders = Array.isArray(savedRecents)
			? savedRecents.filter((p) => typeof p === "string" && fs.existsSync(p))
			: [];
		if (
			this._selectedFolderPath &&
			!this._recentFolders.includes(this._selectedFolderPath)
		) {
			this._recentFolders.unshift(this._selectedFolderPath);
		}

		this._loadPersistedSessions();
	}

	public getSelectedFolderPath(): string {
		const activeSession = this.selectedSession;
		if (activeSession?.folderPath && fs.existsSync(activeSession.folderPath)) {
			return activeSession.folderPath;
		}
		return this._selectedFolderPath;
	}

	public getRecentFolders(): string[] {
		const workspacePaths = (vscode.workspace.workspaceFolders || []).map(
			(w) => w.uri.fsPath,
		);
		const combined = new Set<string>([
			this.getSelectedFolderPath(),
			...this._recentFolders,
			...workspacePaths,
		]);
		return Array.from(combined).filter((p) => p && fs.existsSync(p));
	}

	public async setSelectedFolderPath(folderPath: string): Promise<void> {
		if (!folderPath || !fs.existsSync(folderPath)) {
			return;
		}
		this._selectedFolderPath = folderPath;
		const activeSession = this.selectedSession;
		if (activeSession) {
			activeSession.folderPath = folderPath;
			activeSession.projectName = path.basename(folderPath) || "omen";
		}
		this._recentFolders = [
			folderPath,
			...this._recentFolders.filter((p) => p !== folderPath),
		].slice(0, 12);
		await this._context.globalState.update(
			SELECTED_FOLDER_STORAGE_KEY,
			folderPath,
		);
		await this._context.globalState.update(
			RECENT_FOLDERS_STORAGE_KEY,
			this._recentFolders,
		);
		this._persistAndNotify();
	}

	public async getSubfoldersOfSelectedFolder(): Promise<string[]> {
		const root = this.getSelectedFolderPath();
		const ignored = new Set([
			"node_modules",
			".git",
			"out",
			"dist",
			".build",
			".vscode-test",
			".next",
			"target",
		]);
		try {
			const entries = await fs.promises.readdir(root, { withFileTypes: true });
			return entries
				.filter(
					(e) =>
						e.isDirectory() && !e.name.startsWith(".") && !ignored.has(e.name),
				)
				.slice(0, 20)
				.map((e) => path.join(root, e.name));
		} catch {
			return [];
		}
	}

	public async listFilesInSelectedFolder(): Promise<
		Array<{ label: string; relativePath: string; fsPath: string }>
	> {
		const root = this.getSelectedFolderPath();
		const results: Array<{
			label: string;
			relativePath: string;
			fsPath: string;
		}> = [];
		const ignored = new Set([
			"node_modules",
			".git",
			"out",
			"dist",
			".build",
			".next",
			"target",
			"coverage",
		]);
		const allowedExt = new Set([
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".go",
			".rs",
			".json",
			".yaml",
			".yml",
			".md",
			".css",
			".html",
			".vue",
			".svelte",
			".sh",
			".toml",
		]);

		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 3 || results.length >= 80) {
				return;
			}
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (results.length >= 80) {
					break;
				}
				if (entry.name.startsWith(".") || ignored.has(entry.name)) {
					continue;
				}
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath, depth + 1);
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name).toLowerCase();
					if (allowedExt.has(ext)) {
						const rel = path.relative(root, fullPath);
						results.push({
							label: entry.name,
							relativePath: rel,
							fsPath: fullPath,
						});
					}
				}
			}
		};

		await walk(root, 0);
		return results;
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
			let baseUrl = metaConfig
				.get<string>("baseUrl", "https://api.meta.ai/v1")
				.replace(/\/+$/, "");
			if (
				baseUrl === "https://api.meta.com/v1" ||
				baseUrl === "https://api.llama.com/compat/v1"
			) {
				baseUrl = "https://api.meta.ai/v1";
			}
			options.push(
				{
					id: "muse-spark-1.3",
					name: "Meta Muse Spark 1.3 (Agentic)",
					provider: "meta",
					baseUrl,
				},
				{
					id: "muse-wonder-1.0",
					name: "Meta Muse Wonder 1.0 (Reasoning)",
					provider: "meta",
					baseUrl,
				},
				{
					id: "muse-spark-1.3-contributor",
					name: "Meta Muse Spark 1.3 (Contributor)",
					provider: "meta",
					baseUrl,
				},
				{
					id: "muse-spark-1.2",
					name: "Meta Muse Spark 1.2",
					provider: "meta",
					baseUrl,
				},
				{
					id: "muse-spark-1.1",
					name: "Meta Muse Spark 1.1",
					provider: "meta",
					baseUrl,
				},
			);
		}

		const anthropicConfig = vscode.workspace.getConfiguration(
			"omen.providers.anthropic",
		);
		if (anthropicConfig.get<boolean>("enabled", true)) {
			const baseUrl = anthropicConfig
				.get<string>("baseUrl", "https://api.anthropic.com/v1")
				.replace(/\/+$/, "");
			options.push(
				{
					id: "claude-3-7-sonnet-latest",
					name: "Anthropic Claude 3.7 Sonnet",
					provider: "anthropic",
					baseUrl,
				},
				{
					id: "claude-3-5-haiku-latest",
					name: "Anthropic Claude 3.5 Haiku",
					provider: "anthropic",
					baseUrl,
				},
			);
		}

		const geminiConfig = vscode.workspace.getConfiguration(
			"omen.providers.gemini",
		);
		if (geminiConfig.get<boolean>("enabled", true)) {
			const baseUrl = geminiConfig
				.get<string>(
					"baseUrl",
					"https://generativelanguage.googleapis.com/v1beta/openai",
				)
				.replace(/\/+$/, "");
			options.push(
				{
					id: "gemini-2.5-pro",
					name: "Google Gemini 2.5 Pro",
					provider: "gemini",
					baseUrl,
				},
				{
					id: "gemini-2.5-flash",
					name: "Google Gemini 2.5 Flash",
					provider: "gemini",
					baseUrl,
				},
			);
		}

		const openrouterConfig = vscode.workspace.getConfiguration(
			"omen.providers.openrouter",
		);
		if (openrouterConfig.get<boolean>("enabled", true)) {
			const baseUrl = openrouterConfig
				.get<string>("baseUrl", "https://openrouter.ai/api/v1")
				.replace(/\/+$/, "");
			options.push(
				{
					id: "openrouter/auto",
					name: "OpenRouter: Auto Router",
					provider: "openrouter",
					baseUrl,
				},
				{
					id: "anthropic/claude-3.7-sonnet",
					name: "OpenRouter: Claude 3.7 Sonnet",
					provider: "openrouter",
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
				id: "muse-spark-1.3",
				name: "Meta Muse Spark 1.3 (Agentic)",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
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
		const defaultProject =
			vscode.workspace.workspaceFolders?.[0]?.name || "omen";
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
			const messages: AgentChatMessage[] = Array.isArray(s.messages)
				? [...s.messages]
				: s.prompt
					? [{ role: "user", content: s.prompt, time: s.timestamp || "1m ago" }]
					: [];
			return {
				...s,
				createdAt: s.createdAt || Date.now(),
				pinned: Boolean(s.pinned),
				projectName: s.projectName || defaultProject,
				folderPath: s.folderPath || this._selectedFolderPath,
				messages,
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
			createdAt: s.createdAt,
			pinned: s.pinned,
			projectName: s.projectName,
			folderPath: s.folderPath,
			messages: s.messages,
			status: s.status,
			filesChanged: s.filesChanged,
			activityLog: s.activityLog,
			targetUriString: s.targetUri ? s.targetUri.toString() : s.targetUriString,
			modelId: s.modelId,
			durationSeconds: s.durationSeconds,
		}));
		void this._context.workspaceState.update(
			SESSIONS_STORAGE_KEY,
			serializable,
		);
		this._onDidUpdateSessions.fire(this._sessions);
	}

	public selectSession(sessionId: string): void {
		this._selectedSessionId = sessionId || undefined;
		this._persistAndNotify();
	}

	public togglePinSession(sessionId: string): void {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (session) {
			session.pinned = !session.pinned;
			this._persistAndNotify();
		}
	}

	public deleteSession(sessionId: string): void {
		this._sessions = this._sessions.filter((s) => s.id !== sessionId);
		if (this._selectedSessionId === sessionId) {
			this._selectedSessionId = this._sessions[0]?.id;
		}
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
		viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
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

		const title = `${path.basename(target.filePath)} (Review: ${session.title})`;
		await vscode.commands.executeCommand(
			"vscode.diff",
			originalUri,
			modifiedUri,
			title,
			{ preview: true, viewColumn },
		);
	}

	public async acceptSessionDiff(sessionId: string): Promise<void> {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (!session || !session.filesChanged[0]) {
			return;
		}

		const baseFolder = session.folderPath || this.getSelectedFolderPath();
		for (const fileDiff of session.filesChanged) {
			let targetUri: vscode.Uri | undefined;
			if (session.filesChanged.length === 1) {
				targetUri = session.targetUri;
				if (!targetUri && session.targetUriString) {
					targetUri = vscode.Uri.parse(session.targetUriString);
				}
			}
			if (!targetUri && baseFolder) {
				targetUri = vscode.Uri.file(path.resolve(baseFolder, fileDiff.filePath));
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
		}

		const fileDiff = session.filesChanged[0];
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

		const activeFolder = this.getSelectedFolderPath();
		let originalContent = "";
		let relativePath = "";
		if (targetUri) {
			try {
				const rawBytes = await vscode.workspace.fs.readFile(targetUri);
				originalContent = Buffer.from(rawBytes).toString("utf8");
				relativePath = targetUri.fsPath.startsWith(activeFolder)
					? path.relative(activeFolder, targetUri.fsPath)
					: vscode.workspace.asRelativePath(targetUri);
			} catch {
				originalContent = "";
			}
		}

		const projectName =
			path.basename(activeFolder) ||
			vscode.workspace.workspaceFolders?.[0]?.name ||
			"omen";
		const existingSession = this.selectedSession;
		let session: AgentSession;

		if (existingSession) {
			session = existingSession;
			session.folderPath = session.folderPath || activeFolder;
			session.projectName = path.basename(session.folderPath) || projectName;
			if (!Array.isArray(session.messages)) {
				session.messages = [];
			}
			session.messages.push({
				role: "user",
				content: prompt,
				time: this._now(),
			});
			session.status = "running";
			session.timestamp = "Running";
			session.modelId = modelOption.id;
			if (targetUri) {
				session.targetUri = targetUri;
				session.targetUriString = targetUri.toString();
			}
			session.activityLog.push({
				time: this._now(),
				text: `Follow-up prompt: "${prompt}"`,
				kind: "step",
			});
		} else {
			const id = `agent-${Date.now()}`;
			const title =
				prompt.length > 52 ? prompt.substring(0, 49) + "..." : prompt;
			session = {
				id,
				title,
				prompt,
				timestamp: "Just now",
				createdAt: Date.now(),
				pinned: false,
				projectName,
				folderPath: activeFolder,
				messages: [
					{
						role: "user",
						content: prompt,
						time: this._now(),
					},
				],
				status: "running",
				targetUri,
				targetUriString: targetUri?.toString(),
				modelId: modelOption.id,
				filesChanged: [],
				activityLog: [
					{ time: this._now(), text: `Agent initiated: "${prompt}"`, kind: "step" },
					...(relativePath
						? [
								{
									time: this._now(),
									text: `Context file attached: ${relativePath} (${originalContent.split("\n").length} lines)`,
									kind: "tool" as const,
								},
							]
						: []),
					{
						time: this._now(),
						text: `Active model: ${modelOption.name} (${modelOption.id})`,
						kind: "step",
					},
				],
			};
			this._sessions.unshift(session);
			this._selectedSessionId = session.id;
		}

		const tokenSource = new vscode.CancellationTokenSource();
		this._activeCancellations.set(session.id, tokenSource);

		const startTime = Date.now();
		this._persistAndNotify();

		try {
			const rawReply = await this._queryLLM(
				prompt,
				relativePath,
				originalContent,
				session.messages || [],
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

			session.messages = session.messages || [];
			session.messages.push({
				role: "assistant",
				content: rawReply,
				time: this._now(),
			});

			// Extract code block if targetUri exists and code was generated/modified
			const codeBlockMatch = rawReply.match(
				/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/,
			);
			if (targetUri && relativePath && codeBlockMatch && codeBlockMatch[1]?.trim()) {
				const modifiedCode = codeBlockMatch[1].trimEnd();
				const metrics = this._computeDiffMetrics(originalContent, modifiedCode);
				if (
					metrics.additions > 0 ||
					metrics.deletions > 0 ||
					modifiedCode !== originalContent
				) {
					session.filesChanged = [
						{
							filePath: relativePath,
							originalContent,
							modifiedContent: modifiedCode,
							status: "modified",
							additions: metrics.additions,
							deletions: metrics.deletions,
						},
					];
					this._onDidChange.fire(
						vscode.Uri.parse(
							`${AgentDiffManager.scheme}://omen-diff/modified/${session.id}/${relativePath}`,
						),
					);
				}
			}

			session.durationSeconds = Math.max(
				1,
				Math.round((Date.now() - startTime) / 1000),
			);
			const hasDiff = session.filesChanged.length > 0;
			session.status = hasDiff ? "review" : "completed";
			session.timestamp = "Just now";

			if (hasDiff) {
				const f = session.filesChanged[0];
				session.activityLog.push({
					time: this._now(),
					text: `Prepared changes for ${f.filePath} (+${f.additions} -${f.deletions} lines).`,
					kind: "diff",
				});
			} else {
				session.activityLog.push({
					time: this._now(),
					text: `Response completed in ${session.durationSeconds}s.`,
					kind: "success",
				});
			}

			this._persistAndNotify();
			return session;
		} catch (err: unknown) {
			if (tokenSource.token.isCancellationRequested) {
				return session;
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			session.status = "error";
			session.timestamp = "Error";
			session.messages = session.messages || [];
			session.messages.push({
				role: "assistant",
				content: `**Error (${modelOption.name}):** ${errMsg}`,
				time: this._now(),
			});
			session.activityLog.push({
				time: this._now(),
				text: `Agent execution failed: ${errMsg}`,
				kind: "error",
			});
			this._persistAndNotify();
			return session;
		} finally {
			const stored = this._activeCancellations.get(session.id);
			if (stored) {
				stored.dispose();
				this._activeCancellations.delete(session.id);
			}
		}
	}

	private async _resolveTargetFile(
		prompt: string,
		specifiedUri?: vscode.Uri,
	): Promise<vscode.Uri | undefined> {
		const mentionMatch = prompt.match(
			/@?([a-zA-Z0-9_\-\./]+\.(?:tsx?|jsx?|py|json|yaml|yml|css|html|md|vue|svelte|go|rs|sh|toml))/i,
		);
		if (mentionMatch) {
			const candidatePath = mentionMatch[1];
			const activeFolder = this.getSelectedFolderPath();
			if (activeFolder) {
				const folderCandidate = vscode.Uri.file(
					path.resolve(activeFolder, candidatePath),
				);
				try {
					await vscode.workspace.fs.stat(folderCandidate);
					return folderCandidate;
				} catch {
					// Fall through to workspace folders
				}
			}
			if (vscode.workspace.workspaceFolders?.[0]) {
				const uri = vscode.Uri.joinPath(
					vscode.workspace.workspaceFolders[0].uri,
					candidatePath,
				);
				try {
					await vscode.workspace.fs.stat(uri);
					return uri;
				} catch {
					// Ignore invalid path
				}
			}
		}

		if (specifiedUri && specifiedUri.scheme === "file") {
			return specifiedUri;
		}

		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && activeEditor.document.uri.scheme === "file") {
			return activeEditor.document.uri;
		}

		return undefined;
	}

	private async _queryLLM(
		prompt: string,
		relativePath: string,
		originalContent: string,
		history: AgentChatMessage[],
		modelOption: SelectableModelOption,
		token: vscode.CancellationToken,
		onProgress: (statusText: string) => void,
	): Promise<string> {
		const systemInstruction = relativePath
			? `You are Omen, an expert AI coding assistant in an agentic IDE. Active workspace file: ${relativePath}.\nWhen answering questions, respond clearly in Markdown. When asked to edit, refactor, or write code for ${relativePath}, explain your changes concisely and include the complete updated file inside a fenced code block.`
			: `You are Omen, an expert AI coding assistant in an agentic IDE (Project: ${vscode.workspace.workspaceFolders?.[0]?.name || "omen"}). Respond clearly and concisely using GitHub-flavored Markdown.`;

		const userContentWithContext = relativePath
			? `${prompt}\n\nActive File (${relativePath}):\n\`\`\`\n${originalContent}\n\`\`\``
			: prompt;

		// 1. Attempt official VS Code Language Model API matching the selected model ID
		try {
			const models = await vscode.lm.selectChatModels({
				vendor: "omen",
				id: modelOption.id,
			});
			const matchedModel = models?.[0];
			if (matchedModel) {
				onProgress(`Dispatching via vscode.lm to ${matchedModel.name}...`);
				const lmMessages: vscode.LanguageModelChatMessage[] = [
					vscode.LanguageModelChatMessage.User(systemInstruction),
				];
				for (const m of history.slice(0, -1)) {
					if (m.role === "user") {
						lmMessages.push(vscode.LanguageModelChatMessage.User(m.content));
					} else {
						lmMessages.push(vscode.LanguageModelChatMessage.Assistant(m.content));
					}
				}
				lmMessages.push(
					vscode.LanguageModelChatMessage.User(userContentWithContext),
				);
				const response = await matchedModel.sendRequest(lmMessages, {}, token);
				let fullText = "";
				for await (const chunk of response.text) {
					if (token.isCancellationRequested) {
						throw new Error("Cancelled");
					}
					fullText += chunk;
				}
				if (fullText.trim()) {
					return fullText.trim();
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
		if (modelOption.provider !== "ollama") {
			apiKey = await this._secretManager.getKeyForProvider(modelOption.provider);
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
			: modelOption.id.startsWith("lan/")
				? modelOption.id.replace(/^lan\/[^/]+\//, "")
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
				headers.Authorization = `Bearer ${apiKey}`;
			}

			const apiMessages: Array<{ role: string; content: string }> = [
				{
					role: "system",
					content: systemInstruction,
				},
			];
			for (const m of history.slice(0, -1)) {
				apiMessages.push({
					role: m.role,
					content: m.content,
				});
			}
			apiMessages.push({
				role: "user",
				content: userContentWithContext,
			});

			const resp = await fetch(`${modelOption.baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				signal: abortController.signal,
				body: JSON.stringify({
					model: targetModelName,
					messages: apiMessages,
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
			return output.trim();
		} finally {
			cancelSub.dispose();
		}
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

	/**
	 * Records a native built-in Chat turn into the Conversations list and stages a virtual diff
	 * if the assistant response includes a code block targeting a workspace file.
	 */
	public async recordNativeChatTurn(params: {
		prompt: string;
		modelId: string;
		modelName: string;
		responseText: string;
		targetUri?: vscode.Uri;
		durationSeconds: number;
	}): Promise<AgentSession> {
		const id = `agent-${Date.now()}`;
		const title =
			params.prompt.length > 55
				? params.prompt.substring(0, 52) + "..."
				: params.prompt;

		const workspaceUri =
			params.targetUri ||
			vscode.window.activeTextEditor?.document.uri ||
			vscode.workspace.workspaceFolders?.[0]?.uri ||
			vscode.Uri.parse("untitled:chat");

		const filesChanged: AgentFileDiff[] = [];
		const codeBlockMatch = params.responseText.match(
			/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/,
		);

		if (
			params.targetUri &&
			params.targetUri.scheme === "file" &&
			codeBlockMatch &&
			codeBlockMatch[1]?.trim()
		) {
			try {
				const rawBytes = await vscode.workspace.fs.readFile(params.targetUri);
				const originalContent = Buffer.from(rawBytes).toString("utf8");
				const modifiedContent = codeBlockMatch[1].trimEnd();
				const relativePath = vscode.workspace.asRelativePath(params.targetUri);
				const metrics = this._computeDiffMetrics(
					originalContent,
					modifiedContent,
				);
				if (
					metrics.additions > 0 ||
					metrics.deletions > 0 ||
					modifiedContent !== originalContent
				) {
					filesChanged.push({
						filePath: relativePath,
						originalContent,
						modifiedContent,
						status: "modified",
						additions: metrics.additions,
						deletions: metrics.deletions,
					});
				}
			} catch {
				// Ignore non-existent file reads
			}
		}

		const hasDiff = filesChanged.length > 0;
		const session: AgentSession = {
			id,
			title,
			prompt: params.prompt,
			timestamp: hasDiff ? "Review" : "Completed",
			status: hasDiff ? "review" : "completed",
			targetUri: workspaceUri,
			targetUriString: workspaceUri.toString(),
			modelId: params.modelId,
			durationSeconds: Math.max(1, params.durationSeconds),
			filesChanged,
			activityLog: [
				{
					time: this._now(),
					text: `Prompt (${params.modelName}): "${params.prompt}"`,
					kind: "step",
				},
				{
					time: this._now(),
					text: params.responseText.slice(0, 600),
					kind: "info",
				},
			],
		};

		if (hasDiff) {
			const f = filesChanged[0];
			session.activityLog.push({
				time: this._now(),
				text: `Staged diff for ${f.filePath} (+${f.additions} -${f.deletions})`,
				kind: "diff",
			});
		}

		this._sessions.unshift(session);
		this._selectedSessionId = id;
		this._persistAndNotify();
		return session;
	}
}
