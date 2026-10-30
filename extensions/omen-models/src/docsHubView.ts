/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from "vscode";
import * as path from "path";

interface RagDocumentItem {
	id: string;
	name: string;
	path: string;
	tokens: number;
	chunks: number;
	indexedAt: string;
}

interface RagCollection {
	id: string;
	name: string;
	embeddingModel: "nomic-embed-text" | "bge-m3" | "all-minilm";
	enabled: boolean;
	documents: RagDocumentItem[];
}

const DEFAULT_OMEN_SPEC_MD = `# Omen Architecture Specification
## Modular Agentic IDE & Hybrid Compute Orchestrator

### 1. Core Architectural Philosophy: Developer-Composable Modularity
Omen (\`omen-dev\` / \`omni-io\`) is a modular Agentic AI IDE and Hybrid Compute Orchestrator built on Code - OSS.
Every subsystem—compute pooling, cloud offloading, external AI APIs, and RAG vector databases—is strictly modular and optional:
- **Setup A (Cloud API Agent)**: Fast cloud generation (DeepSeek, OpenAI, Meta) with optional local RAG.
- **Setup B (Flagship Distributed Local Cluster)**: Runs local \`.gguf\` / Ollama LLMs across pooled local CPUs and GPUs (Apple M4 Mac + Acer Nitro 5 RTX 3050 + Intel CPU threads) over LAN.
- **Setup C (Elastic Cloud Burst)**: Connects to Modal (\`modal.com\`) serverless GPUs (T4, A10G, A100, H100) on demand, scaling to $0 when idle.

### 2. Workbench Layout: Code Left, Documentation & AI Right
- **Left / Center-Left**: Compact File Explorer + Full-featured Code Editor.
- **Top-Right Title Bar**: Global Accounts & Settings controls alongside layout toggles.
- **Right Secondary Side Bar**:
  1. **Chat**: Multi-model Agentic Chat.
  2. **Docs & RAG**: Side-by-side Documentation Reader/Editor, API Reference Lookup, and Local Vector DB Manager.
  3. **Cluster**: Multi-Device LAN Pairing Portal & Hardware Thread Allocator.
`;

export class OmenDocsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.docsView";
	private _view?: vscode.WebviewView;
	private _collections: RagCollection[] = [];
	private _activeDocTitle = "Omen Architecture Spec.md";
	private _activeDocContent = DEFAULT_OMEN_SPEC_MD;
	private _activeDocUri?: vscode.Uri;
	private _contextWindowLimit = 128000;

	constructor(private readonly _context: vscode.ExtensionContext) {
		const saved = this._context.globalState.get<RagCollection[]>(
			"omen.rag.collections",
		);
		if (saved && saved.length > 0) {
			this._collections = saved;
		} else {
			this._collections = [
				{
					id: "col-arch",
					name: "Omen Architecture & Specs",
					embeddingModel: "nomic-embed-text",
					enabled: true,
					documents: [
						{
							id: "doc-1",
							name: "Omen-Architecture-Spec.md",
							path: "builtin://omen-spec.md",
							tokens: 640,
							chunks: 5,
							indexedAt: "Indexed locally",
						},
					],
				},
			];
		}

		// Live update token meter when active editor or document text changes
		this._context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => this._sendState()),
			vscode.workspace.onDidChangeTextDocument(() => this._sendTokenUpdate()),
		);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "ready":
					await this._sendState();
					break;
				case "openProjectDoc": {
					if (msg.path === "builtin://omen-spec.md") {
						this._activeDocUri = undefined;
						this._activeDocTitle = "Omen Architecture Spec.md";
						this._activeDocContent = DEFAULT_OMEN_SPEC_MD;
						await this._sendState();
						return;
					}
					try {
						const uri = vscode.Uri.file(msg.path);
						const bytes = await vscode.workspace.fs.readFile(uri);
						this._activeDocUri = uri;
						this._activeDocTitle = path.basename(msg.path);
						this._activeDocContent = Buffer.from(bytes).toString("utf8");
						await this._sendState();
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to read document: ${err}`);
					}
					break;
				}
				case "syncActiveEditor": {
					const editor = vscode.window.activeTextEditor;
					if (!editor) {
						vscode.window.showInformationMessage(
							"Open a file in the Left Code Editor first to inspect or document it.",
						);
						return;
					}
					const doc = editor.document;
					const fileName = path.basename(doc.uri.fsPath);
					if (fileName.endsWith(".md") || fileName.endsWith(".txt")) {
						this._activeDocUri = doc.uri;
						this._activeDocTitle = fileName;
						this._activeDocContent = doc.getText();
					} else {
						this._activeDocUri = undefined;
						this._activeDocTitle = `Notes: ${fileName}`;
						this._activeDocContent = `# Documentation: ${fileName}\n\n- **File Path**: \`${doc.uri.fsPath}\`\n- **Language**: \`${doc.languageId}\`\n- **Lines**: ${doc.lineCount}\n\n## Module Summary\nWrite side-by-side documentation or architectural notes for \`${fileName}\` here while coding on the left.\n`;
					}
					await this._sendState();
					break;
				}
				case "saveDocContent": {
					this._activeDocContent = msg.content;
					if (this._activeDocUri) {
						try {
							await vscode.workspace.fs.writeFile(
								this._activeDocUri,
								Buffer.from(msg.content, "utf8"),
							);
							vscode.window.showInformationMessage(
								`Saved ${this._activeDocTitle}`,
							);
						} catch (err) {
							vscode.window.showErrorMessage(`Save failed: ${err}`);
						}
					} else {
						const folders = vscode.workspace.workspaceFolders;
						const defaultUri = folders?.[0]
							? vscode.Uri.joinPath(
									folders[0].uri,
									this._activeDocTitle.replace(/[^a-zA-Z0-9._-]/g, "_"),
								)
							: undefined;
						const saveUri = await vscode.window.showSaveDialog({
							defaultUri,
							filters: { Markdown: ["md", "txt"] },
						});
						if (saveUri) {
							await vscode.workspace.fs.writeFile(
								saveUri,
								Buffer.from(msg.content, "utf8"),
							);
							this._activeDocUri = saveUri;
							this._activeDocTitle = path.basename(saveUri.fsPath);
							vscode.window.showInformationMessage(
								`Saved ${this._activeDocTitle}`,
							);
						}
					}
					await this._sendState();
					break;
				}
				case "addFilesToRag": {
					const uris = await vscode.window.showOpenDialog({
						canSelectMany: true,
						canSelectFiles: true,
						canSelectFolders: false,
						openLabel: "Index into Local Vector DB",
						filters: {
							"Docs & Code": [
								"md",
								"txt",
								"json",
								"ts",
								"js",
								"py",
								"rs",
								"go",
								"pdf",
							],
						},
					});
					if (!uris || uris.length === 0) {
						return;
					}
					const targetCol = this._collections[0];
					for (const uri of uris) {
						try {
							const bytes = await vscode.workspace.fs.readFile(uri);
							const text = Buffer.from(bytes).toString("utf8");
							const estTokens = Math.max(1, Math.ceil(text.length / 4));
							const chunks = Math.max(1, Math.ceil(estTokens / 256));
							targetCol.documents.push({
								id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
								name: path.basename(uri.fsPath),
								path: uri.fsPath,
								tokens: estTokens,
								chunks,
								indexedAt: new Date().toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
								}),
							});
						} catch {
							// Ignore binary/unreadable files
						}
					}
					await this._saveCollections();
					await this._sendState();
					break;
				}
				case "toggleRagCollection": {
					const col = this._collections.find((c) => c.id === msg.id);
					if (col) {
						col.enabled = !col.enabled;
						await this._saveCollections();
						await this._sendState();
					}
					break;
				}
				case "changeEmbeddingModel": {
					const col = this._collections[0];
					if (col && msg.model) {
						col.embeddingModel = msg.model;
						await this._saveCollections();
						await this._sendState();
					}
					break;
				}
				case "removeRagDoc": {
					const col = this._collections[0];
					if (col) {
						col.documents = col.documents.filter((d) => d.id !== msg.docId);
						await this._saveCollections();
						await this._sendState();
					}
					break;
				}
				case "openExternalDocs": {
					if (msg.url) {
						await vscode.commands.executeCommand(
							"simpleBrowser.show",
							msg.url,
						);
					}
					break;
				}
			}
		});
	}

	private async _saveCollections(): Promise<void> {
		await this._context.globalState.update(
			"omen.rag.collections",
			this._collections,
		);
	}

	private _calculateTokens(): {
		editorTokens: number;
		ragTokens: number;
		totalTokens: number;
		activeFileName: string;
	} {
		const editor = vscode.window.activeTextEditor;
		const editorText = editor ? editor.document.getText() : "";
		const editorTokens = Math.ceil(editorText.length / 4);
		const activeFileName = editor
			? path.basename(editor.document.uri.fsPath)
			: "No active file";

		let ragTokens = 0;
		for (const col of this._collections) {
			if (col.enabled) {
				for (const d of col.documents) {
					ragTokens += d.tokens;
				}
			}
		}

		return {
			editorTokens,
			ragTokens,
			totalTokens: editorTokens + ragTokens,
			activeFileName,
		};
	}

	private _sendTokenUpdate(): void {
		if (!this._view) {
			return;
		}
		this._view.webview.postMessage({
			type: "tokenUpdate",
			tokens: this._calculateTokens(),
			limit: this._contextWindowLimit,
		});
	}

	private async _discoverWorkspaceDocs(): Promise<
		{ name: string; path: string }[]
	> {
		const list: { name: string; path: string }[] = [
			{
				name: "Omen Architecture Spec.md (Built-in)",
				path: "builtin://omen-spec.md",
			},
		];
		try {
			const files = await vscode.workspace.findFiles(
				"**/*.md",
				"**/node_modules/**",
				25,
			);
			for (const f of files) {
				list.push({
					name: vscode.workspace.asRelativePath(f),
					path: f.fsPath,
				});
			}
		} catch {
			// Ignore if no workspace open
		}
		return list;
	}

	private async _sendState(): Promise<void> {
		if (!this._view) {
			return;
		}
		const workspaceDocs = await this._discoverWorkspaceDocs();
		this._view.webview.postMessage({
			type: "state",
			activeDocTitle: this._activeDocTitle,
			activeDocContent: this._activeDocContent,
			workspaceDocs,
			collections: this._collections,
			tokens: this._calculateTokens(),
			limit: this._contextWindowLimit,
		});
	}

	private _getHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
	:root {
		--bg: transparent;
		--fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
		--border: var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.1));
		--input-bg: var(--vscode-input-background);
		--input-fg: var(--vscode-input-foreground);
		--input-border: var(--vscode-input-border, rgba(255,255,255,0.15));
		--btn-bg: var(--vscode-button-background);
		--btn-fg: var(--vscode-button-foreground);
		--btn-hover: var(--vscode-button-hoverBackground);
		--accent: var(--vscode-textLink-foreground, #EDEDED);
		--card-bg: #212121;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 0;
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
		font-size: 12px;
		color: var(--fg);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}
	.subnav {
		display: flex;
		gap: 4px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.12);
	}
	.subnav button {
		flex: 1;
		background: transparent;
		color: var(--fg);
		border: 1px solid transparent;
		padding: 5px 8px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 11px;
		font-weight: 600;
		opacity: 0.75;
	}
	.subnav button.active {
		opacity: 1;
		background: var(--card-bg);
		border-color: var(--accent);
		color: var(--accent);
	}
	.pane {
		display: none;
		flex: 1;
		overflow-y: auto;
		padding: 10px;
		gap: 10px;
		flex-direction: column;
	}
	.pane.active {
		display: flex;
	}
	.toolbar {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	select, input[type="text"], textarea {
		background: var(--input-bg);
		color: var(--input-fg);
		border: 1px solid var(--input-border);
		border-radius: 4px;
		padding: 5px 7px;
		font-size: 11.5px;
		font-family: inherit;
	}
	select { flex: 1; min-width: 0; }
	.btn {
		background: var(--btn-bg);
		color: var(--btn-fg);
		border: none;
		border-radius: 4px;
		padding: 5px 9px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn:hover { background: var(--btn-hover); }
	.btn-secondary {
		background: rgba(255,255,255,0.08);
		color: var(--fg);
	}
	.doc-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-weight: 600;
		font-size: 12px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--border);
	}
	.doc-reader {
		flex: 1;
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 12px;
		overflow-y: auto;
		line-height: 1.55;
		white-space: pre-wrap;
		font-size: 12px;
	}
	.doc-editor {
		flex: 1;
		width: 100%;
		resize: none;
		line-height: 1.5;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 12px;
		display: none;
	}
	.card {
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px;
	}
	.card-title {
		font-weight: 600;
		font-size: 12px;
		margin-bottom: 6px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.doc-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 8px;
		border-radius: 4px;
		background: rgba(0,0,0,0.15);
		margin-top: 6px;
	}
	.doc-meta {
		font-size: 10.5px;
		opacity: 0.7;
	}
	.ref-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}
	.ref-btn {
		padding: 8px;
		text-align: left;
		background: var(--card-bg);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		cursor: pointer;
		font-size: 11.5px;
	}
	.ref-btn:hover {
		border-color: var(--accent);
	}
	.token-footer {
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		background: rgba(0, 0, 0, 0.2);
		font-size: 11px;
	}
	.meter-bar {
		height: 6px;
		background: rgba(255,255,255,0.1);
		border-radius: 3px;
		overflow: hidden;
		margin: 5px 0;
	}
	.meter-fill {
		height: 100%;
		background: #27C93F;
		width: 2%;
		transition: width 0.2s ease;
	}
	.meter-labels {
		display: flex;
		justify-content: space-between;
		opacity: 0.85;
		font-size: 10.5px;
	}
</style>
</head>
<body>
	<div class="subnav">
		<button class="active" onclick="switchTab('reader', this)">Docs Reader & Pad</button>
		<button onclick="switchTab('rag', this)">Vector DB (RAG)</button>
		<button onclick="switchTab('ref', this)">API Reference</button>
	</div>

	<!-- TAB 1: Side-by-Side Documentation Reader & Editor -->
	<div id="pane-reader" class="pane active">
		<div class="toolbar">
			<select id="docSelect" onchange="onSelectDoc(this.value)"></select>
			<button class="btn btn-secondary" onclick="syncActiveEditor()" title="Load or create documentation for the active code file on the left">Sync Left File</button>
		</div>
		<div class="doc-header">
			<span id="docTitle">Omen Architecture Spec.md</span>
			<div style="display:flex; gap:4px;">
				<button id="toggleEditBtn" class="btn btn-secondary" onclick="toggleEditMode()">Edit</button>
				<button id="saveDocBtn" class="btn" style="display:none;" onclick="saveDoc()">Save</button>
			</div>
		</div>
		<div id="docReader" class="doc-reader"></div>
		<textarea id="docEditor" class="doc-editor"></textarea>
	</div>

	<!-- TAB 2: Local Vector Database (LM Studio Style) -->
	<div id="pane-rag" class="pane">
		<div class="card">
			<div class="card-title">
				<span>Local Vector Database (LM Studio Style)</span>
				<label style="font-weight:normal; font-size:11px; display:flex; align-items:center; gap:4px; cursor:pointer;">
					<input type="checkbox" id="ragEnabledToggle" checked onchange="toggleRag()" />
					Inject into AI Prompt
				</label>
			</div>
			<div style="font-size:11px; opacity:0.8; margin-bottom:8px;">
				Index PDFs, Markdown specs, and code folders locally. Retrieved chunks feed into Local Clustered LLMs, Modal GPUs, or Cloud APIs.
			</div>
			<div class="toolbar" style="margin-bottom:8px;">
				<span style="font-size:11px; opacity:0.8;">Embedder:</span>
				<select id="embeddingModelSelect" onchange="changeEmbedder(this.value)">
					<option value="nomic-embed-text">nomic-embed-text (Local v1.5)</option>
					<option value="bge-m3">BAAI/bge-m3 (Multi-Lingual Dense)</option>
					<option value="all-minilm">all-MiniLM-L6-v2 (Fast CPU)</option>
				</select>
				<button class="btn" onclick="addFilesToRag()">+ Index Files</button>
			</div>
			<div id="ragDocsList"></div>
		</div>
	</div>

	<!-- TAB 3: Quick Developer Reference Browser -->
	<div id="pane-ref" class="pane">
		<div class="card">
			<div class="card-title">Open Official Docs in Side-by-Side Viewer</div>
			<div class="toolbar" style="margin-bottom:8px;">
				<input type="text" id="customDocUrl" placeholder="https://docs.python.org or https://modal.com/docs" style="flex:1;" />
				<button class="btn" onclick="openCustomUrl()">Open</button>
			</div>
			<div class="ref-grid">
				<button class="ref-btn" onclick="openUrl('https://developer.mozilla.org/en-US/')"><strong>MDN Web Docs</strong><div class="doc-meta">JS / TS / HTML / CSS</div></button>
				<button class="ref-btn" onclick="openUrl('https://www.typescriptlang.org/docs/')"><strong>TypeScript Docs</strong><div class="doc-meta">Handbook & Reference</div></button>
				<button class="ref-btn" onclick="openUrl('https://modal.com/docs/guide')"><strong>Modal Serverless</strong><div class="doc-meta">Cloud GPU Containers</div></button>
				<button class="ref-btn" onclick="openUrl('https://github.com/ollama/ollama/blob/main/docs/api.md')"><strong>Ollama REST API</strong><div class="doc-meta">Local Model Endpoints</div></button>
				<button class="ref-btn" onclick="openUrl('https://docs.python.org/3/')"><strong>Python 3 Docs</strong><div class="doc-meta">Standard Library</div></button>
				<button class="ref-btn" onclick="openUrl('https://doc.rust-lang.org/book/')"><strong>Rust Book</strong><div class="doc-meta">Language Reference</div></button>
			</div>
		</div>
	</div>

	<!-- Persistent Live Context Token & KV-Cache Meter -->
	<div class="token-footer">
		<div style="display:flex; justify-content:space-between; font-weight:600;">
			<span>Live Context Token & KV-Cache Meter</span>
			<span id="tokenSummary">0 / 128,000 tk (0.0%)</span>
		</div>
		<div class="meter-bar">
			<div id="tokenBarFill" class="meter-fill"></div>
		</div>
		<div class="meter-labels">
			<span id="editorTokenLabel">Left Editor: 0 tk</span>
			<span id="ragTokenLabel">RAG Docs: 0 tk</span>
		</div>
	</div>

<script>
	const vscode = acquireVsCodeApi();
	let isEditing = false;
	let currentCollectionId = 'col-arch';

	function switchTab(tab, btn) {
		document.querySelectorAll('.subnav button').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
		document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
		document.getElementById('pane-' + tab).classList.add('active');
	}

	function onSelectDoc(path) {
		if (path) {
			vscode.postMessage({ type: 'openProjectDoc', path });
		}
	}

	function syncActiveEditor() {
		vscode.postMessage({ type: 'syncActiveEditor' });
	}

	function toggleEditMode() {
		isEditing = !isEditing;
		const reader = document.getElementById('docReader');
		const editor = document.getElementById('docEditor');
		const editBtn = document.getElementById('toggleEditBtn');
		const saveBtn = document.getElementById('saveDocBtn');
		if (isEditing) {
			reader.style.display = 'none';
			editor.style.display = 'block';
			editBtn.textContent = 'Preview';
			saveBtn.style.display = 'inline-block';
		} else {
			reader.textContent = editor.value;
			reader.style.display = 'block';
			editor.style.display = 'none';
			editBtn.textContent = 'Edit';
			saveBtn.style.display = 'none';
		}
	}

	function saveDoc() {
		const content = document.getElementById('docEditor').value;
		document.getElementById('docReader').textContent = content;
		vscode.postMessage({ type: 'saveDocContent', content });
	}

	function addFilesToRag() {
		vscode.postMessage({ type: 'addFilesToRag' });
	}

	function toggleRag() {
		vscode.postMessage({ type: 'toggleRagCollection', id: currentCollectionId });
	}

	function changeEmbedder(model) {
		vscode.postMessage({ type: 'changeEmbeddingModel', model });
	}

	function removeDoc(docId) {
		vscode.postMessage({ type: 'removeRagDoc', docId });
	}

	function openUrl(url) {
		vscode.postMessage({ type: 'openExternalDocs', url });
	}

	function openCustomUrl() {
		const val = document.getElementById('customDocUrl').value.trim();
		if (val) {
			openUrl(val.startsWith('http') ? val : 'https://' + val);
		}
	}

	function updateTokensUI(tokens, limit) {
		const pct = Math.min(100, (tokens.totalTokens / limit) * 100);
		document.getElementById('tokenSummary').textContent =
			tokens.totalTokens.toLocaleString() + ' / ' + limit.toLocaleString() + ' tk (' + pct.toFixed(1) + '%)';
		document.getElementById('tokenBarFill').style.width = Math.max(1.5, pct) + '%';
		document.getElementById('editorTokenLabel').textContent =
			'Left Code (' + tokens.activeFileName + '): ' + tokens.editorTokens.toLocaleString() + ' tk';
		document.getElementById('ragTokenLabel').textContent =
			'Right RAG Docs: ' + tokens.ragTokens.toLocaleString() + ' tk';
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'state') {
			document.getElementById('docTitle').textContent = msg.activeDocTitle;
			document.getElementById('docReader').textContent = msg.activeDocContent;
			document.getElementById('docEditor').value = msg.activeDocContent;

			const sel = document.getElementById('docSelect');
			sel.innerHTML = '';
			(msg.workspaceDocs || []).forEach(d => {
				const opt = document.createElement('option');
				opt.value = d.path;
				opt.textContent = d.name;
				if (d.name.includes(msg.activeDocTitle)) {
					opt.selected = true;
				}
				sel.appendChild(opt);
			});

			const col = (msg.collections || [])[0];
			if (col) {
				currentCollectionId = col.id;
				document.getElementById('ragEnabledToggle').checked = col.enabled;
				document.getElementById('embeddingModelSelect').value = col.embeddingModel;
				const listEl = document.getElementById('ragDocsList');
				listEl.innerHTML = '';
				col.documents.forEach(doc => {
					const row = document.createElement('div');
					row.className = 'doc-item';
					row.innerHTML =
						'<div><strong>' + doc.name + '</strong><div class="doc-meta">' +
						doc.chunks + ' chunks • ' + doc.tokens.toLocaleString() + ' tokens • ' + doc.indexedAt +
						'</div></div>' +
						'<button class="btn btn-secondary" onclick="removeDoc(\\'' + doc.id + '\\')">Remove</button>';
					listEl.appendChild(row);
				});
			}

			if (msg.tokens) {
				updateTokensUI(msg.tokens, msg.limit || 128000);
			}
		} else if (msg.type === 'tokenUpdate') {
			updateTokensUI(msg.tokens, msg.limit || 128000);
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}

