/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
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

/** Upper bound on characters sent to the preview, to keep the webview responsive on large files. */
const MAX_PREVIEW_CHARS = 200_000;

export class OmenDocsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "omen.docsView";
	private _view?: vscode.WebviewView;
	private _collections: RagCollection[] = [];
	private _activeDocTitle = "";
	private _activeDocContent = "";
	private _activeDocLanguage = "";
	private _activeDocLineCount = 0;
	private _activeDocRelativePath = "";
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
		this._activeDocLanguage = doc.languageId;
		this._activeDocLineCount = doc.lineCount;
		this._activeDocRelativePath = vscode.workspace.asRelativePath(doc.uri, false);
		this._postDocState();
	}

	/** Syncs the preview with the active editor. Bound to the view title `sync` action. */
	public syncActiveFile(): void {
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			this._updateWithRealDocument(activeEditor.document);
		} else {
			vscode.window.showInformationMessage(
				"No active file open in editor to sync.",
			);
		}
	}

	/** Prompts for and creates a new vector collection. Bound to the view title `database` action. */
	public async addCollection(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: "New Vector Collection",
			prompt: "Collection name",
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
	}

	/** Reveals the previewed document in the editor. */
	public async openInEditor(): Promise<void> {
		if (this._activeDocUri) {
			await vscode.window.showTextDocument(this._activeDocUri);
		}
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
					this.syncActiveFile();
					break;
				}
				case "addRagCollection": {
					await this.addCollection();
					break;
				}
				case "toggleCollection": {
					const col = this._collections.find((c) => c.id === msg.id);
					if (col) {
						col.enabled = !col.enabled;
						this._postDocState();
					}
					break;
				}
				case "openInEditor": {
					await this.openInEditor();
					break;
				}
				case "toggleSidebar": {
					await vscode.commands.executeCommand(
						"workbench.action.toggleSidebarVisibility",
					);
					break;
				}
			}
		});

		this._postDocState();
	}

	private _postDocState(): void {
		if (this._view) {
			const truncated = this._activeDocContent.length > MAX_PREVIEW_CHARS;
			void this._view.webview.postMessage({
				type: "docUpdate",
				hasDoc: !!this._activeDocUri,
				title: this._activeDocTitle,
				relativePath: this._activeDocRelativePath,
				language: this._activeDocLanguage,
				lineCount: this._activeDocLineCount,
				content: truncated
					? this._activeDocContent.slice(0, MAX_PREVIEW_CHARS)
					: this._activeDocContent,
				truncated,
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
		/* Derive every color from the active theme so the view matches the workbench */
		--fg: var(--vscode-foreground, #cccccc);
		--muted: var(--vscode-descriptionForeground, rgba(204,204,204,0.6));
		--surface: color-mix(in srgb, var(--fg) 4%, transparent);
		--surface-hover: color-mix(in srgb, var(--fg) 7%, transparent);
		--border: color-mix(in srgb, var(--fg) 9%, transparent);
		--accent: var(--vscode-button-background, #4f8cff);
		--accent-fg: var(--vscode-button-foreground, #ffffff);
		--accent-hover: var(--vscode-button-hoverBackground, #3d7bf0);
		--ok: var(--vscode-testing-iconPassed, #3fb950);
		--focus: var(--vscode-focusBorder, #4f8cff);
		--mono: var(--vscode-editor-font-family, "SF Mono", Menlo, monospace);
		--radius: 8px;
	}
	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body {
		margin: 0;
		padding: 10px 10px 14px;
		font-family: var(--vscode-font-family, -apple-system, sans-serif);
		font-size: var(--vscode-font-size, 13px);
		color: var(--fg);
		display: flex;
		flex-direction: column;
		gap: 11px;
		user-select: none;
		-webkit-font-smoothing: antialiased;
	}
	body::-webkit-scrollbar { width: 4px; }
	body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 4px; }
	svg { width: 16px; height: 16px; flex-shrink: 0; }

	/* Active file card */
	.file {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 8px 10px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.file-icon {
		width: 28px;
		height: 28px;
		border-radius: 6px;
		display: grid;
		place-items: center;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.file.empty-file .file-icon { color: var(--muted); background: var(--surface-hover); }
	.file-text { min-width: 0; }
	.file-name {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.file-sub {
		font-size: 11px;
		color: var(--muted);
		margin-top: 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.actions { display: flex; gap: 2px; }

	/* Sections */
	.section { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
	.section.grow { flex: 1; }
	.section-head { display: flex; align-items: center; gap: 6px; min-height: 20px; }
	.section-title {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.count {
		font-size: 10px;
		font-weight: 600;
		min-width: 16px;
		padding: 0 5px;
		line-height: 15px;
		text-align: center;
		border-radius: 999px;
		background: var(--vscode-badge-background, var(--surface-hover));
		color: var(--vscode-badge-foreground, var(--fg));
	}
	.spacer { flex: 1; }

	/* Collections */
	.list { display: flex; flex-direction: column; gap: 4px; }
	.row {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		padding: 6px 8px;
		border-radius: 6px;
	}
	.row:hover { background: var(--surface-hover); }
	.row > svg { color: var(--muted); }
	.row-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.row-sub { font-size: 11px; color: var(--muted); }
	.hint {
		font-size: 11.5px;
		color: var(--muted);
		padding: 6px 8px;
		border: 1px dashed var(--border);
		border-radius: var(--radius);
	}
	.link {
		font: inherit;
		color: var(--vscode-textLink-foreground, var(--accent));
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
	}
	.link:hover { text-decoration: underline; }

	/* Toggle switch */
	.switch {
		position: relative;
		width: 28px;
		height: 16px;
		border: 0;
		padding: 0;
		border-radius: 999px;
		background: var(--surface-hover);
		box-shadow: inset 0 0 0 1px var(--border);
		cursor: pointer;
		transition: background 120ms ease;
	}
	.switch::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--muted);
		transition: transform 120ms ease, background 120ms ease;
	}
	.switch[aria-checked="true"] { background: var(--accent); box-shadow: none; }
	.switch[aria-checked="true"]::after { transform: translateX(12px); background: var(--accent-fg); }

	/* Preview */
	.preview {
		flex: 1;
		min-height: 60px;
		max-height: 140px;
		overflow: auto;
		background: var(--vscode-editor-background, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius);
		user-select: text;
	}
	.preview pre {
		margin: 0;
		padding: 8px 10px;
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--vscode-editor-foreground, var(--fg));
		white-space: pre;
		tab-size: 4;
	}
	.preview.wrap pre { white-space: pre-wrap; word-break: break-word; }
	.truncated { font-size: 10.5px; color: var(--muted); padding: 4px 10px 8px; }

	/* Empty state */
	.empty {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		gap: 4px;
		padding: 12px 10px;
		user-select: none;
	}
	.empty-icon {
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--muted);
		background: var(--surface-hover);
		margin-bottom: 2px;
	}
	.empty-title { font-size: 12px; font-weight: 600; }
	.empty-desc { font-size: 11px; line-height: 1.4; color: var(--muted); max-width: 220px; }

	/* Buttons */
	.icon-btn {
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--surface-hover)); color: var(--fg); }
	.icon-btn[aria-pressed="true"] { color: var(--fg); background: var(--surface-hover); }
	.icon-btn:disabled { opacity: 0.4; cursor: default; background: transparent; }
	button:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
</style>
</head>
<body>
	<div class="file empty-file" id="fileCard">
		<div class="file-icon">
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/></svg>
		</div>
		<div class="file-text">
			<div class="file-name" id="docTitle">No file open</div>
			<div class="file-sub" id="docSub">Open a file to preview it here</div>
		</div>
		<div class="actions">
			<button class="icon-btn" data-action="syncFile" title="Sync active file" aria-label="Sync active file">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5"/><path d="M11.8 1.8v2.9H8.9M4.2 14.2v-2.9h2.9"/></svg>
			</button>
			<button class="icon-btn" data-action="openEditor" id="openBtn" title="Open in editor" aria-label="Open in editor" disabled>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4"/></svg>
			</button>
		</div>
	</div>

	<section class="section" aria-labelledby="colTitle">
		<div class="section-head">
			<span class="section-title" id="colTitle">Vector collections</span>
			<span class="count" id="colCount">0</span>
			<span class="spacer"></span>
			<button class="icon-btn" data-action="addCollection" title="New collection" aria-label="New collection">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>
			</button>
		</div>
		<div class="list" id="colList"></div>
	</section>

	<section class="section grow" aria-labelledby="previewTitle">
		<div class="section-head">
			<span class="section-title" id="previewTitle">Preview</span>
			<span class="spacer"></span>
			<button class="icon-btn" data-action="toggleWrap" id="wrapBtn" title="Toggle word wrap" aria-label="Toggle word wrap" aria-pressed="false">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5M2.5 12h3"/><path d="M10 10.5L8.5 12l1.5 1.5"/></svg>
			</button>
		</div>
		<div class="preview" id="contentBox"></div>
	</section>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const persisted = vscode.getState() || {};

	const ICONS = {
		file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/></svg>',
		database: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="8" cy="3.75" rx="5" ry="2"/><path d="M3 3.75v8.5c0 1.1 2.2 2 5 2s5-.9 5-2v-8.5M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>'
	};

	function escapeHtml(str) {
		if (str === undefined || str === null) return '';
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function applyWrap(on) {
		document.getElementById('contentBox').classList.toggle('wrap', on);
		document.getElementById('wrapBtn').setAttribute('aria-pressed', String(on));
	}
	applyWrap(!!persisted.wrap);

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'docUpdate') {
			renderFile(msg);
			renderCollections(msg.collections || []);
		}
	});

	function renderFile(msg) {
		const card = document.getElementById('fileCard');
		const titleEl = document.getElementById('docTitle');
		const subEl = document.getElementById('docSub');
		const contentBox = document.getElementById('contentBox');
		const openBtn = document.getElementById('openBtn');

		card.classList.toggle('empty-file', !msg.hasDoc);
		openBtn.disabled = !msg.hasDoc;

		if (!msg.hasDoc) {
			titleEl.textContent = 'No file open';
			subEl.textContent = 'Open a file to preview it here';
			contentBox.innerHTML = '<div class="empty"><div class="empty-icon">' + ICONS.file
				+ '</div><div class="empty-title">Nothing to preview</div>'
				+ '<div class="empty-desc">Open any Markdown or code file in the editor to read it side by side.</div></div>';
			return;
		}

		titleEl.textContent = msg.title;
		titleEl.title = msg.relativePath || msg.title;
		const lines = Number(msg.lineCount) || 0;
		subEl.textContent = [msg.language, lines + (lines === 1 ? ' line' : ' lines')].filter(Boolean).join(' · ');

		if (msg.content && msg.content.trim()) {
			contentBox.innerHTML = '<pre>' + escapeHtml(msg.content) + '</pre>'
				+ (msg.truncated ? '<div class="truncated">Preview truncated. Open in editor to see the full file.</div>' : '');
		} else {
			contentBox.innerHTML = '<div class="empty"><div class="empty-title">Empty file</div></div>';
		}
	}

	function renderCollections(collections) {
		document.getElementById('colCount').textContent = String(collections.length);
		const list = document.getElementById('colList');
		if (collections.length === 0) {
			list.innerHTML = '<div class="hint">No collections yet. <button class="link" data-action="addCollection">Create one</button> to index docs for RAG.</div>';
			return;
		}
		list.innerHTML = collections.map(c => {
			const docs = c.documents ? c.documents.length : 0;
			return '<div class="row">' + ICONS.database
				+ '<div style="min-width:0"><div class="row-name">' + escapeHtml(c.name) + '</div>'
				+ '<div class="row-sub">' + escapeHtml(c.embeddingModel) + ' · ' + docs + (docs === 1 ? ' doc' : ' docs') + '</div></div>'
				+ '<button class="switch" role="switch" aria-checked="' + (c.enabled ? 'true' : 'false') + '" aria-label="Enable ' + escapeHtml(c.name)
				+ '" data-action="toggleCollection" data-id="' + escapeHtml(c.id) + '"></button></div>';
		}).join('');
	}

	document.addEventListener('click', e => {
		const actionEl = e.target.closest('[data-action]');
		if (!actionEl || actionEl.disabled) return;

		const action = actionEl.getAttribute('data-action');
		if (action === 'syncFile') {
			vscode.postMessage({ type: 'syncLeftFile' });
		} else if (action === 'addCollection') {
			vscode.postMessage({ type: 'addRagCollection' });
		} else if (action === 'openEditor') {
			vscode.postMessage({ type: 'openInEditor' });
		} else if (action === 'toggleCollection') {
			vscode.postMessage({ type: 'toggleCollection', id: actionEl.getAttribute('data-id') });
		} else if (action === 'toggleWrap') {
			const on = !document.getElementById('contentBox').classList.contains('wrap');
			applyWrap(on);
			vscode.setState({ ...(vscode.getState() || {}), wrap: on });
		}
	});

	window.addEventListener('keydown', e => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
			e.preventDefault();
			vscode.postMessage({ type: 'toggleSidebar' });
		}
	});

	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
