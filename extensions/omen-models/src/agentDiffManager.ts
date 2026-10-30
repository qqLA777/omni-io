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
}

export class AgentDiffManager implements vscode.TextDocumentContentProvider {
	public static readonly scheme = "omen-agent";
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChange.event;

	private _sessions: AgentSession[] = [];
	private _selectedSessionId?: string;
	private readonly _onDidUpdateSessions = new vscode.EventEmitter<AgentSession[]>();
	public readonly onDidUpdateSessions = this._onDidUpdateSessions.event;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _secretManager: SecretManager,
	) {
		void this._context;
	}

	public get sessions(): AgentSession[] {
		return this._sessions;
	}

	public get selectedSession(): AgentSession | undefined {
		return this._sessions.find((s) => s.id === this._selectedSessionId);
	}

	public selectSession(sessionId: string): void {
		this._selectedSessionId = sessionId;
		this._onDidUpdateSessions.fire(this._sessions);
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
		this._onDidUpdateSessions.fire(this._sessions);

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
		session.activityLog.push({
			time: this._now(),
			text: `✓ Changes applied directly to ${fileDiff.filePath} and staged on disk.`,
			kind: "success",
		});
		this._onDidUpdateSessions.fire(this._sessions);
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
		session.activityLog.push({
			time: this._now(),
			text: "✕ Proposed changes discarded by developer.",
			kind: "info",
		});
		this._onDidUpdateSessions.fire(this._sessions);
		vscode.window.showInformationMessage(
			`Agent diff discarded: ${session.title}`,
		);
		return Promise.resolve();
	}

	public async executeRealAgent(
		prompt: string,
		specifiedUri?: vscode.Uri,
	): Promise<AgentSession | undefined> {
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

		const session: AgentSession = {
			id,
			title,
			prompt,
			timestamp: "Running",
			status: "running",
			targetUri,
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
				{ time: this._now(), text: `Target file resolved: ${relativePath} (${originalContent.split("\n").length} lines)`, kind: "tool" },
			],
		};

		this._sessions.unshift(session);
		this._selectedSessionId = id;
		this._onDidUpdateSessions.fire(this._sessions);

		try {
			session.activityLog.push({
				time: this._now(),
				text: "Querying active Language Model...",
				kind: "step",
			});
			this._onDidUpdateSessions.fire(this._sessions);

			const modifiedCode = await this._queryLLM(
				prompt,
				relativePath,
				originalContent,
				(statusText) => {
					session.activityLog.push({
						time: this._now(),
						text: statusText,
						kind: "info",
					});
					this._onDidUpdateSessions.fire(this._sessions);
				},
			);

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
			this._onDidUpdateSessions.fire(this._sessions);
			await this.showDiff(session);
			return session;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			session.status = "error";
			session.timestamp = "Error";
			session.activityLog.push({
				time: this._now(),
				text: `Agent execution failed: ${errMsg}`,
				kind: "error",
			});
			this._onDidUpdateSessions.fire(this._sessions);
			return session;
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

		// Look for file path mentioned in prompt
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

		// Prompt user with workspace file quick-pick
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
		onProgress: (statusText: string) => void,
	): Promise<string> {
		// 1. Attempt official VS Code Language Model API
		try {
			const models = await vscode.lm.selectChatModels({ vendor: "omen" });
			if (models && models.length > 0) {
				const model = models[0];
				onProgress(`Connected to model: ${model.name}`);
				const messages = [
					vscode.LanguageModelChatMessage.User(
						`You are an expert autonomous software engineer.\nInstruction: ${prompt}\n\nTarget File: ${relativePath}\nOriginal Content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nCRITICAL: Return ONLY the raw modified file content without markdown code fences or explanatory text.`,
					),
				];
				const tokenSource = new vscode.CancellationTokenSource();
				const response = await model.sendRequest(
					messages,
					{},
					tokenSource.token,
				);
				let fullText = "";
				for await (const chunk of response.text) {
					fullText += chunk;
				}
				if (fullText.trim()) {
					return this._cleanModelOutput(fullText);
				}
			}
		} catch {
			// Fallback to direct provider integration
		}

		// 2. Direct Provider Fallback via SecretManager (Meta / DeepSeek / OpenAI)
		const activeKey = await this._secretManager.getActiveKey();
		if (activeKey) {
			onProgress(`Connecting to ${activeKey.provider.toUpperCase()} API endpoint...`);
			let endpoint = "https://api.deepseek.com/v1/chat/completions";
			let modelName = "deepseek-chat";

			if (activeKey.provider === "openai") {
				endpoint = "https://api.openai.com/v1/chat/completions";
				modelName = "gpt-4o";
			} else if (activeKey.provider === "meta") {
				endpoint = "https://api.meta.com/v1/chat/completions";
				modelName = "muse-spark";
			}

			const resp = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${activeKey.key}`,
				},
				body: JSON.stringify({
					model: modelName,
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
				throw new Error(`${activeKey.provider.toUpperCase()} API returned error HTTP ${resp.status}: ${errText}`);
			}

			const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
			const output = data.choices?.[0]?.message?.content;
			if (output && output.trim()) {
				return this._cleanModelOutput(output);
			}
		}

		// 3. Fallback: Local Ollama check
		try {
			const ollamaBaseUrl = OllamaManager.getBaseUrl();
			const localModels = await OllamaManager.listInstalledModels();
			if (localModels.length > 0) {
				const localModel = localModels[0].name;
				onProgress(`Streaming from local Ollama model (${localModel})...`);
				const resp = await fetch(`${ollamaBaseUrl}/v1/chat/completions`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: localModel,
						messages: [
							{
								role: "system",
								content:
									"You are an expert software engineer. Return ONLY modified code without backticks.",
							},
							{
								role: "user",
								content: `Instruction: ${prompt}\n\nFile: ${relativePath}\n\`\`\`\n${originalContent}\n\`\`\``,
							},
						],
					}),
				});
				if (resp.ok) {
					const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
					const output = data.choices?.[0]?.message?.content;
					if (output && output.trim()) {
						return this._cleanModelOutput(output);
					}
				}
			}
		} catch {
			// Ollama not reachable
		}

		// 4. No configured provider found
		const setKeyAction = "Set API Key";
		void vscode.window
			.showErrorMessage(
				"No AI model available. Please configure an API Key (DeepSeek / OpenAI / Meta) or start Ollama.",
				setKeyAction,
			)
			.then((sel) => {
				if (sel === setKeyAction) {
					void this._secretManager.promptForApiKey();
				}
			});

		throw new Error(
			"API key not configured and local Ollama is offline. Configure an API key via 'Omen: Set API Key' in the Command Palette.",
		);
	}

	public loadDemoSession(): void {
		const sampleSidebarOriginal = `export function AdminSidebar() {
  return (
    <aside className="w-64 bg-gray-900 text-white p-4">
      <h2 className="text-xl font-bold">Admin Panel</h2>
      <nav className="mt-4 flex flex-col gap-2">
        <a href="/admin">Dashboard</a>
        <a href="/admin/staff">Staff</a>
        <a href="/admin/settings">Settings</a>
      </nav>
    </aside>
  );
}`;

		const sampleSidebarModified = `import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function AdminSidebar() {
  const pathname = usePathname();
  const navItems = [
    { href: '/admin', label: 'Dashboard', icon: 'LayoutDashboard' },
    { href: '/admin/staff', label: 'Staff Roster', icon: 'Users' },
    { href: '/admin/services', label: 'Services', icon: 'Scissors' },
    { href: '/admin/settings', label: 'Preferences', icon: 'Settings' },
  ];

  return (
    <aside className="w-64 bg-[#161616] border-r border-[#222222] text-[#E6E6E6] flex flex-col h-full">
      <div className="p-4 border-b border-[#222222]">
        <h2 className="text-sm font-semibold tracking-wide">Ariel Barbers Admin</h2>
      </div>
      <nav className="p-3 flex flex-col gap-1 flex-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={\`px-3 py-2 rounded-md text-xs font-medium transition-colors \${
                isActive
                  ? 'bg-[#272727] text-white'
                  : 'text-[#858585] hover:text-[#E6E6E6] hover:bg-[#1C1C1C]'
              }\`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}`;

		const demoSession: AgentSession = {
			id: "agent-demo-sidebar",
			title: "Refactor admin-sidebar.tsx to match design system",
			prompt: "Refactor components/admin/admin-sidebar.tsx with active route highlighting, matching the #141414 / #161616 monochromatic theme and Next.js navigation.",
			timestamp: "Demo",
			status: "review",
			filesChanged: [
				{
					filePath: "components/admin/admin-sidebar.tsx",
					originalContent: sampleSidebarOriginal,
					modifiedContent: sampleSidebarModified,
					status: "modified",
					additions: 32,
					deletions: 8,
				},
			],
			activityLog: [
				{ time: "00:01", text: "Target file resolved: components/admin/admin-sidebar.tsx", kind: "tool" },
				{ time: "00:02", text: "Connected to Language Model (deepseek-chat)", kind: "step" },
				{ time: "00:03", text: "Generated typed navigation schema and theme tokens", kind: "step" },
				{ time: "00:04", text: "Diff ready (+32 -8 lines). Awaiting developer review.", kind: "diff" },
			],
		};

		this._sessions = [demoSession];
		this._selectedSessionId = demoSession.id;
		this._onDidUpdateSessions.fire(this._sessions);
		void this.showDiff(demoSession);
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
