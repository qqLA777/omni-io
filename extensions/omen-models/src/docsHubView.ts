/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";

interface RagCollection {
	id: string;
	name: string;
	embeddingModel: "nomic-embed-text" | "bge-m3" | "all-minilm";
	enabled: boolean;
	documents: { id: string; name: string; path: string; tokens: number }[];
}

export class OmenDocsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.docsView";
	private _view?: vscode.WebviewView;
	private _collections: RagCollection[] = [];
	private _activeDocTitle = "No Document Open";
	private _activeDocContent = "";
	private _activeDocUri?: vscode.Uri;

	constructor(private readonly _context: vscode.ExtensionContext) {
		void this._context;

		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.uri.scheme === "file") {
				this._updateWithRealDocument(editor.document);
			}
		});

		const currentEditor = vscode.window.activeTextEditor;
		if (currentEditor && currentEditor.document.uri.scheme === "file") {
			this._updateWithRealDocument(currentEditor.document);
		}
	}

	private _updateWithRealDocument(doc: vscode.TextDocument): void {
		this._activeDocTitle = path.basename(doc.fileName);
		this._activeDocUri = doc.uri;
		this._activeDocContent = doc.getText();
		this._postDocState();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready": {
					this._postDocState();
					break;
				}
				case "syncLeftFile": {
					const activeEditor = vscode.window.activeTextEditor;
					if (activeEditor) {
						this._updateWithRealDocument(activeEditor.document);
					} else {
						vscode.window.showInformationMessage(
							"No active file open in editor to sync.",
						);
					}
					break;
				}
				case "addRagCollection": {
					const name = await vscode.window.showInputBox({
						prompt: "Collection Name",
						placeHolder: "e.g. Project Knowledge Base",
					});
					if (name && name.trim()) {
						this._collections.push({
							id: `col-${Date.now()}`,
							name: name.trim(),
							embeddingModel: "nomic-embed-text",
							enabled: true,
							documents: [],
						});
						this._postDocState();
					}
					break;
				}
				case "openInEditor": {
					if (this._activeDocUri) {
						await vscode.window.showTextDocument(this._activeDocUri);
					}
					break;
				}
			}
		});

		this._postDocState();
	}

	private _postDocState(): void {
		if (this._view) {
			void this._view.webview.postMessage({
				type: "docUpdate",
				title: this._activeDocTitle,
				content: this._activeDocContent,
				collections: this._collections,
			});
		}
	}

	private _getHtml(): string {
		const nonce = crypto.randomBytes(16).toString("base64");

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	:root {
		--bg: #161616;
		--card-bg: #1C1C1C;
		--border: #262626;
		--fg: #E6E6E6;
		--muted: #858585;
		--accent-blue: #007acc;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 11.5px;
		color: var(--fg);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		height: 100vh;
		gap: 8px;
		user-select: none;
	}
	.header-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}
	.tab-group {
		display: flex;
		gap: 6px;
	}
	.btn-tab {
		background: #212121;
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.btn-tab.active {
		background: #2A2A2A;
		border-color: #383838;
		color: #FFF;
	}
	.btn-action {
		background: #242424;
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.btn-action:hover {
		background: #2e2e2e;
		color: #FFF;
	}
	.doc-viewer {
		flex: 1;
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.doc-title {
		font-weight: 600;
		font-size: 12px;
		color: #EDEDED;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.doc-pre {
		margin: 0;
		font-family: monospace;
		font-size: 11px;
		color: #CFCFCF;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.empty-hint {
		color: var(--muted);
		font-size: 11px;
		text-align: center;
		padding: 30px 10px;
	}
</style>
</head>
<body>
	<div class="header-bar">
		<div class="tab-group">
			<button class="btn-tab active">Docs Reader</button>
			<button class="btn-tab" data-action="addCollection">+ Vector DB</button>
		</div>
		<button class="btn-action" data-action="syncFile">Sync Active File</button>
	</div>

	<div class="doc-viewer">
		<div class="doc-title">
			<span id="docTitle">No Document Open</span>
			<button class="btn-action" style="font-size: 10px; padding: 2px 6px;" data-action="openEditor">Open ↗</button>
		</div>
		<div id="contentBox">
			<div class="empty-hint">Open any Markdown or code file in the editor to read side-by-side.</div>
		</div>
	</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();

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
		if (msg.type === 'docUpdate') {
			const titleEl = document.getElementById('docTitle');
			const contentBox = document.getElementById('contentBox');
			titleEl.textContent = msg.title;

			if (msg.content && msg.content.trim()) {
				contentBox.innerHTML = '<pre class="doc-pre">' + escapeHtml(msg.content) + '</pre>';
			} else {
				contentBox.innerHTML = '<div class="empty-hint">Open any Markdown or code file in the editor to read side-by-side.</div>';
			}
		}
	});

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl) return;

		const action = actionEl.getAttribute('data-action');
		if (action === 'syncFile') {
			vscode.postMessage({ type: 'syncLeftFile' });
		} else if (action === 'addCollection') {
			vscode.postMessage({ type: 'addRagCollection' });
		} else if (action === 'openEditor') {
			vscode.postMessage({ type: 'openInEditor' });
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
