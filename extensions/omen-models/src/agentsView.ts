/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
 
import * as vscode from 'vscode';
import { AgentDiffManager } from './agentDiffManager.js';
import { OmenConversationsSidebarProvider } from './conversationsSidebar.js';

/**
 * Provides the Bionic-style Agent Chat + Edited Files (+add/-del) card inside the Explorer sidebar,
 * delegating to OmenConversationsSidebarProvider.
 */
export class OmenAgentsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'omen.agentsView';
	private readonly _delegate: OmenConversationsSidebarProvider;

	constructor(context: vscode.ExtensionContext, diffManager: AgentDiffManager) {
		this._delegate = new OmenConversationsSidebarProvider(context, diffManager);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken,
	): void {
		this._delegate.resolveWebviewView(webviewView, context, token);
	}
}
