/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import { SecretManager } from "./secretManager.js";
import { OllamaManager } from "./ollamaManager.js";
import { OmenLanguageModelChatProvider } from "./modelProvider.js";
import { OmenDocsViewProvider } from "./docsHubView.js";
import { OmenClusterViewProvider } from "./clusterView.js";
import { AgentDiffManager } from "./agentDiffManager.js";
import { OmenConversationsSidebarProvider } from "./conversationsSidebar.js";
import { AgentHubEditorProvider } from "./agentHubEditor.js";
import { OmenSettingsEditorProvider } from "./settingsEditor.js";

export function activate(context: vscode.ExtensionContext): void {
	const secretManager = new SecretManager(context);

	// 1. Register Right/Panel Webview Views (Docs & RAG + Compute Cluster)
	const docsProvider = new OmenDocsViewProvider(context);
	const clusterProvider = new OmenClusterViewProvider(context);

	// 2. Register Omen Language Model Chat Provider (Local Ollama + LAN Worker + Third-Party Cloud APIs)
	const provider = new OmenLanguageModelChatProvider(
		secretManager,
		clusterProvider,
	);
	const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
		"omen",
		provider,
	);
	context.subscriptions.push(providerDisposable);

	// Trigger immediate model resolution in LanguageModelsService so models appear in the native built-in Chat Model Picker
	provider.refresh();
	void vscode.lm.selectChatModels({ vendor: "omen" });

	// 3. Register Agents Diff Engine & Left Sidebar Chat
	const diffManager = new AgentDiffManager(
		context,
		secretManager,
		clusterProvider,
	);
	const conversationsProvider = new OmenConversationsSidebarProvider(
		context,
		diffManager,
		secretManager,
	);

	// 4. Register Default Native Built-in Chat Participant ("omen.agent")
	const chatParticipant = vscode.chat.createChatParticipant(
		"omen.agent",
		async (
			request: vscode.ChatRequest,
			chatContext: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken,
		) => {
			if (request.command === "keys") {
				await secretManager.promptForApiKey();
				provider.refresh();
				void vscode.lm.selectChatModels({ vendor: "omen" });
				stream.markdown(
					"API Key configuration updated. Select any Local, LAN, or Third-Party Cloud model from the Chat model picker below.",
				);
				return;
			}

			if (request.command === "cluster") {
				const activeWorker = clusterProvider.getActiveWorker();
				if (activeWorker && activeWorker.online) {
					stream.markdown(
						`**LAN GPU Worker Connected:** \`${activeWorker.name}\` (\`${activeWorker.ip}:${activeWorker.port}\`) — **${activeWorker.gpuName}**\n\nAvailable LAN models: ${activeWorker.models.map((m: string) => `\`${m}\``).join(", ")}`,
					);
				} else {
					stream.markdown(
						"No LAN GPU Worker is currently paired. Click below to open the **Compute Cluster** panel and pair your Acer Nitro 5 or LAN worker.",
					);
				}
				stream.button({
					command: "omen.openClusterHub",
					title: "Open LAN Compute Cluster",
				});
				return;
			}

			// Resolve target workspace file from #file references or active editor
			let targetUri: vscode.Uri | undefined;
			for (const ref of request.references) {
				if (ref.value instanceof vscode.Uri && ref.value.scheme === "file") {
					targetUri = ref.value;
					break;
				} else if (
					ref.value instanceof vscode.Location &&
					ref.value.uri.scheme === "file"
				) {
					targetUri = ref.value.uri;
					break;
				}
			}
			if (
				!targetUri &&
				vscode.window.activeTextEditor?.document.uri.scheme === "file"
			) {
				targetUri = vscode.window.activeTextEditor.document.uri;
			}

			let fileContextSection = "";
			if (targetUri && targetUri.scheme === "file") {
				try {
					const rawBytes = await vscode.workspace.fs.readFile(targetUri);
					const fileText = Buffer.from(rawBytes).toString("utf8");
					const relPath = vscode.workspace.asRelativePath(targetUri);
					stream.reference(targetUri);
					fileContextSection = `\n\nActive Workspace File (${relPath}):\n\`\`\`\n${fileText}\n\`\`\`\nIf the user asks to modify or edit this file, provide the complete updated file inside a fenced code block.`;
				} catch {
					// Ignore unreadable files
				}
			}

			// Build conversation messages for the selected model in the native Chat picker
			const messages: vscode.LanguageModelChatMessage[] = [];
			for (const turn of chatContext.history) {
				if (turn instanceof vscode.ChatRequestTurn) {
					messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
				} else if (turn instanceof vscode.ChatResponseTurn) {
					let prevText = "";
					for (const part of turn.response) {
						if (part instanceof vscode.ChatResponseMarkdownPart) {
							prevText += part.value.value;
						}
					}
					if (prevText) {
						messages.push(vscode.LanguageModelChatMessage.Assistant(prevText));
					}
				}
			}

			messages.push(
				vscode.LanguageModelChatMessage.User(
					`${request.prompt}${fileContextSection}`,
				),
			);

			let selectedModel: vscode.LanguageModelChat | undefined = request.model;
			if (!selectedModel) {
				const fallbackModels = await vscode.lm.selectChatModels({
					vendor: "omen",
				});
				selectedModel = fallbackModels[0];
			}

			if (!selectedModel) {
				stream.markdown(
					"No language model is currently available. Configure an API key or start Local/LAN Ollama.",
				);
				stream.button({
					command: "omen.setApiKey",
					title: "Configure API Keys",
				});
				return;
			}

			const startTime = Date.now();
			let fullResponseText = "";
			try {
				const chatResponse = await selectedModel.sendRequest(
					messages,
					{},
					token,
				);
				for await (const fragment of chatResponse.text) {
					fullResponseText += fragment;
					stream.markdown(fragment);
				}
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				stream.markdown(`\n\n**Error (${selectedModel.name}):** ${errMsg}`);
				stream.button({
					command: "omen.setApiKey",
					title: "Set API Key",
				});
				stream.button({
					command: "omen.openClusterHub",
					title: "Configure LAN Compute Cluster",
				});
				return;
			}

			const durationSeconds = Math.max(
				1,
				Math.round((Date.now() - startTime) / 1000),
			);
			const session = await diffManager.recordNativeChatTurn({
				prompt: request.prompt,
				modelId: selectedModel.id,
				modelName: selectedModel.name,
				responseText: fullResponseText,
				targetUri,
				durationSeconds,
			});

			if (session.filesChanged.length > 0) {
				const f = session.filesChanged[0];
				stream.markdown(
					`\n\n---\n**Edited file:** \`${f.filePath}\` (**+${f.additions}** / **-${f.deletions}** lines)`,
				);
				stream.button({
					command: "omen.reviewSessionDiff",
					title: "Review Diff",
					arguments: [session.id],
				});
				stream.button({
					command: "omen.acceptSessionDiff",
					title: "✓ Accept",
					arguments: [session.id],
				});
				stream.button({
					command: "omen.rejectSessionDiff",
					title: "✕ Reject",
					arguments: [session.id],
				});
			}
		},
	);
	chatParticipant.iconPath = new vscode.ThemeIcon("sparkle");

	context.subscriptions.push(
		chatParticipant,
		vscode.workspace.registerTextDocumentContentProvider(
			AgentDiffManager.scheme,
			diffManager,
		),
		vscode.window.registerWebviewViewProvider(
			OmenConversationsSidebarProvider.viewType,
			conversationsProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.window.registerWebviewViewProvider(
			OmenDocsViewProvider.viewType,
			docsProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.window.registerWebviewViewProvider(
			OmenClusterViewProvider.viewType,
			clusterProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		clusterProvider,
	);

	// 5. Apply Omen Dark theme, flat elevation model, and minimalist Cursor/Antigravity layout defaults
	const safeSetConfig = async (
		section: string,
		key: string,
		value: unknown,
	): Promise<void> => {
		try {
			await vscode.workspace
				.getConfiguration(section)
				.update(key, value, vscode.ConfigurationTarget.Global);
		} catch {
			// Ignore unregistered or read-only settings individually
		}
	};

	const initializeCursorLayout = async (): Promise<void> => {
		try {
			await vscode.commands.executeCommand("workbench.action.closePanel");
		} catch {
			// Ignore
		}
		try {
			await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
		} catch {
			// Ignore
		}
		try {
			for (const tabGroup of vscode.window.tabGroups.all) {
				for (const tab of tabGroup.tabs) {
					if (tab.label === "Welcome") {
						await vscode.window.tabGroups.close(tab);
					}
				}
			}
		} catch {
			// Ignore
		}
		try {
			await vscode.commands.executeCommand("omen.conversationsView.focus");
		} catch {
			// Ignore
		}
		try {
			await AgentHubEditorProvider.createOrShow(
				context,
				diffManager,
				secretManager,
			);
		} catch {
			// Ignore
		}
	};

	void (async () => {
		await initializeCursorLayout();
		setTimeout(() => {
			void initializeCursorLayout();
		}, 350);

		await safeSetConfig("workbench", "colorTheme", "Omen Dark");
		await safeSetConfig("workbench", "shadows", false);
		await safeSetConfig("workbench", "startupEditor", "none");
		await safeSetConfig("workbench", "activityBar.location", "hidden");
		await safeSetConfig("workbench", "editor.showTabs", "none");
		await safeSetConfig("workbench", "editor.editorActionsLocation", "hidden");
		await safeSetConfig("workbench", "experimental.modernUI", false);
		await safeSetConfig("workbench", "secondarySideBar.defaultVisibility", "hidden");
		await safeSetConfig("workbench", "secondarySideBar.showLabels", false);
		await safeSetConfig("workbench", "statusBar.visible", false);
		await safeSetConfig("workbench", "layoutControl.enabled", false);
		await safeSetConfig("chat", "agentsControl.enabled", "hidden");
		await safeSetConfig("chat", "titleBar.signIn.enabled", false);
	})();

	// 6. Register Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("omen.manageModels", async () => {
			await OllamaManager.showManageModelsDialog();
			provider.refresh();
			void vscode.lm.selectChatModels({ vendor: "omen" });
		}),
		vscode.commands.registerCommand("omen.setApiKey", async () => {
			await OmenSettingsEditorProvider.createOrShow(
				context,
				secretManager,
				() => {
					provider.refresh();
					void vscode.lm.selectChatModels({ vendor: "omen" });
				},
			);
		}),
		vscode.commands.registerCommand("omen.openSettingsHub", async () => {
			await OmenSettingsEditorProvider.createOrShow(
				context,
				secretManager,
				() => {
					provider.refresh();
					void vscode.lm.selectChatModels({ vendor: "omen" });
				},
			);
		}),
		vscode.commands.registerCommand("omen.refreshModels", async () => {
			provider.refresh();
			await vscode.lm.selectChatModels({ vendor: "omen" });
			vscode.window.showInformationMessage("Omen AI Models refreshed.");
		}),
		vscode.commands.registerCommand("omen.openDocsHub", async () => {
			await vscode.commands.executeCommand("omen.docsView.focus");
		}),
		vscode.commands.registerCommand("omen.openClusterHub", async () => {
			await vscode.commands.executeCommand("omen.clusterView.focus");
		}),
		vscode.commands.registerCommand("omen.openAgentsView", async () => {
			await vscode.commands.executeCommand("omen.conversationsView.focus");
			await AgentHubEditorProvider.createOrShow(
				context,
				diffManager,
				secretManager,
			);
		}),
		vscode.commands.registerCommand("omen.openAgentHub", async () => {
			await vscode.commands.executeCommand("omen.conversationsView.focus");
			await AgentHubEditorProvider.createOrShow(
				context,
				diffManager,
				secretManager,
			);
		}),
		vscode.commands.registerCommand("omen.newAgent", async () => {
			diffManager.selectSession("");
			await vscode.commands.executeCommand("omen.conversationsView.focus");
			await AgentHubEditorProvider.createOrShow(
				context,
				diffManager,
				secretManager,
			);
		}),
		vscode.commands.registerCommand(
			"omen.reviewSessionDiff",
			async (sessionId?: string) => {
				const session = sessionId
					? diffManager.sessions.find((s) => s.id === sessionId)
					: diffManager.selectedSession;
				if (session) {
					diffManager.selectSession(session.id);
					await diffManager.showDiff(session);
				}
			},
		),
		vscode.commands.registerCommand(
			"omen.acceptSessionDiff",
			async (sessionId?: string) => {
				const targetId = sessionId || diffManager.selectedSession?.id;
				if (targetId) {
					await diffManager.acceptSessionDiff(targetId);
				}
			},
		),
		vscode.commands.registerCommand(
			"omen.rejectSessionDiff",
			async (sessionId?: string) => {
				const targetId = sessionId || diffManager.selectedSession?.id;
				if (targetId) {
					await diffManager.rejectSessionDiff(targetId);
				}
			},
		),
	);

	// 7. Keep LanguageModelChatProvider synced when LAN Cluster state changes
	const clusterStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		105,
	);
	const updateClusterStatus = () => {
		clusterStatusBarItem.text = clusterProvider.getStatusSummary();
		clusterStatusBarItem.tooltip =
			"Click to open Omen Compute Cluster & LAN Worker Pairing Portal";
		provider.refresh();
		void vscode.lm.selectChatModels({ vendor: "omen" });
	};
	updateClusterStatus();
	clusterStatusBarItem.command = "omen.openClusterHub";
	clusterStatusBarItem.show();
	context.subscriptions.push(
		clusterStatusBarItem,
		clusterProvider.onDidChangeState(() => updateClusterStatus()),
	);

	const docsStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		104,
	);
	docsStatusBarItem.text = "$(book) Docs & RAG";
	docsStatusBarItem.tooltip =
		"Open Side-by-Side Documentation Reader & Local Vector DB";
	docsStatusBarItem.command = "omen.openDocsHub";
	docsStatusBarItem.show();
	context.subscriptions.push(docsStatusBarItem);
}

export function deactivate(): void {}
