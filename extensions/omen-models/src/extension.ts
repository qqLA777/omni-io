/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import { SecretManager } from "./secretManager.js";
import { OllamaManager } from "./ollamaManager.js";
import { OmenLanguageModelChatProvider } from "./modelProvider.js";
import { OmenDocsViewProvider } from "./docsHubView.js";
import { OmenClusterViewProvider } from "./clusterView.js";
import { AgentDiffManager } from "./agentDiffManager.js";
import { OmenAgentsViewProvider } from "./agentsView.js";

export function activate(context: vscode.ExtensionContext): void {
	const secretManager = new SecretManager(context);
	const provider = new OmenLanguageModelChatProvider(secretManager);

	// 1. Register Omen Language Model Chat Provider
	const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
		"omen",
		provider,
	);
	context.subscriptions.push(providerDisposable);

	// Trigger immediate model resolution in LanguageModelsService so models appear in the Chat Model Picker at startup
	provider.refresh();
	void vscode.lm.selectChatModels({ vendor: "omen" });

	// 2. Register Agents Diff Engine & Primary Sidebar (Explorer) Webview View
	const diffManager = new AgentDiffManager(context, secretManager);
	const agentsProvider = new OmenAgentsViewProvider(context, diffManager);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			AgentDiffManager.scheme,
			diffManager,
		),
		vscode.window.registerWebviewViewProvider(
			OmenAgentsViewProvider.viewType,
			agentsProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
	);

	// 3. Register Right Secondary Side Bar Webview Views (Docs & RAG + Compute Cluster)
	const docsProvider = new OmenDocsViewProvider(context);
	const clusterProvider = new OmenClusterViewProvider(context);

	context.subscriptions.push(
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

	// 3. Apply Omen Dark theme, flat elevation model, and Cursor-style layout defaults
	void (async () => {
		try {
			const wbConfig = vscode.workspace.getConfiguration("workbench");
			await wbConfig.update(
				"colorTheme",
				"Omen Dark",
				vscode.ConfigurationTarget.Global,
			);
			await wbConfig.update(
				"shadows",
				false,
				vscode.ConfigurationTarget.Global,
			);
			await wbConfig.update(
				"startupEditor",
				"none",
				vscode.ConfigurationTarget.Global,
			);
			await wbConfig.update(
				"activityBar.location",
				"top",
				vscode.ConfigurationTarget.Global,
			);
			await wbConfig.update(
				"secondarySideBar.defaultVisibility",
				"visible",
				vscode.ConfigurationTarget.Global,
			);
			await wbConfig.update(
				"secondarySideBar.showLabels",
				true,
				vscode.ConfigurationTarget.Global,
			);
			// Close any open "Welcome" tab if present
			for (const tabGroup of vscode.window.tabGroups.all) {
				for (const tab of tabGroup.tabs) {
					if (tab.label === "Welcome") {
						await vscode.window.tabGroups.close(tab);
					}
				}
			}
		} catch {
			// Ignore if settings cannot be updated during startup
		}
	})();

	// 4. Register Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("omen.manageModels", async () => {
			await OllamaManager.showManageModelsDialog();
			provider.refresh();
		}),
		vscode.commands.registerCommand("omen.setApiKey", async () => {
			await secretManager.promptForApiKey();
			provider.refresh();
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
			await vscode.commands.executeCommand("omen.agentsView.focus");
		}),
		vscode.commands.registerCommand("omen.newAgent", async () => {
			const activeDoc = vscode.window.activeTextEditor?.document;
			const fileName = activeDoc
				? activeDoc.uri.path.split("/").pop()
				: undefined;
			const prompt = await vscode.window.showInputBox({
				prompt: fileName
					? `Describe task for Agent on "${fileName}"`
					: "Describe the task for the Agent to execute on your code",
				placeHolder: fileName
					? `e.g. Refactor ${fileName} to add validation and clean typing`
					: "e.g. Refactor components/admin/admin-sidebar.tsx to add route guards",
			});
			if (prompt && prompt.trim()) {
				void diffManager.executeRealAgent(prompt.trim(), activeDoc?.uri);
			}
		}),
	);

	// 5. Status Bar Live Cluster Telemetry & Quick-Action Pills
	const clusterStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		105,
	);
	const updateClusterStatus = () => {
		clusterStatusBarItem.text = clusterProvider.getStatusSummary();
		clusterStatusBarItem.tooltip =
			"Click to open Omen Compute Cluster & LAN Worker Pairing Portal (Right Side Bar)";
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
		"Open Side-by-Side Documentation Reader & Local Vector DB (Right Side Bar)";
	docsStatusBarItem.command = "omen.openDocsHub";
	docsStatusBarItem.show();
	context.subscriptions.push(docsStatusBarItem);
}

export function deactivate(): void {}
