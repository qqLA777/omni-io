/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable local/code-no-unexternalized-strings */
import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";

export interface LlamaCppStatus {
	running: boolean;
	baseUrl: string;
	modelPath: string;
	rpcServers: string;
	pid?: number;
	lastError?: string;
	models: string[];
}

export class LlamaCppManager implements vscode.Disposable {
	private proc: ChildProcess | undefined;
	private output: vscode.OutputChannel;
	private lastError: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel("Omen llama.cpp");
		this.context.subscriptions.push(this.output);
	}

	static getConfig() {
		const cfg = vscode.workspace.getConfiguration("omen.providers.llamacpp");
		const port = cfg.get<number>("port", 8080);
		const baseUrl = cfg
			.get<string>("baseUrl", `http://127.0.0.1:${port}`)
			.replace(/\/+$/, "");
		return {
			enabled: cfg.get<boolean>("enabled", true),
			baseUrl,
			port,
			binaryPath: cfg.get<string>("binaryPath", "llama-server") || "llama-server",
			modelPath: cfg.get<string>("modelPath", "") || "",
			rpcServers: cfg.get<string>("rpcServers", "") || "",
			contextSize: cfg.get<number>("contextSize", 2048),
			gpuLayers: cfg.get<number>("gpuLayers", 99),
		};
	}

	static getBaseUrl(): string {
		return LlamaCppManager.getConfig().baseUrl;
	}

	isRunning(): boolean {
		return !!this.proc && !this.proc.killed;
	}

	async getStatus(): Promise<LlamaCppStatus> {
		const config = LlamaCppManager.getConfig();
		const models = await this.listModels().catch(() => [] as string[]);
		return {
			running: this.isRunning() || models.length > 0,
			baseUrl: config.baseUrl,
			modelPath: config.modelPath,
			rpcServers: config.rpcServers,
			pid: this.proc?.pid,
			lastError: this.lastError,
			models,
		};
	}

	static async fetchModels(baseUrl: string): Promise<string[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2500);
		try {
			const resp = await fetch(`${baseUrl}/v1/models`, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});
			if (!resp.ok) {
				return [];
			}
			const data = (await resp.json()) as { data?: Array<{ id?: string }> };
			return (data.data || []).map((m) => m.id || "").filter(Boolean);
		} catch {
			return [];
		} finally {
			clearTimeout(timer);
		}
	}

	async listModels(): Promise<string[]> {
		const { baseUrl } = LlamaCppManager.getConfig();
		return LlamaCppManager.fetchModels(baseUrl);
	}

	async checkHealth(): Promise<boolean> {
		const { baseUrl } = LlamaCppManager.getConfig();
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 2500);
			const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
			clearTimeout(timer);
			return resp.ok;
		} catch {
			return false;
		}
	}

	async start(): Promise<void> {
		const config = LlamaCppManager.getConfig();
		if (!config.modelPath) {
			const picked = await vscode.window.showOpenDialog({
				title: "Select GGUF model file for llama-server",
				canSelectMany: false,
				filters: { Models: ["gguf"] },
			});
			if (!picked || picked.length === 0) {
				return;
			}
			await vscode.workspace
				.getConfiguration("omen.providers.llamacpp")
				.update("modelPath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
		}
		const fresh = LlamaCppManager.getConfig();
		if (this.isRunning()) {
			vscode.window.showInformationMessage("llama-server is already running.");
			return;
		}

		const args = [
			"-m",
			fresh.modelPath,
			"-c",
			String(fresh.contextSize),
			"-ngl",
			String(fresh.gpuLayers),
			"--host",
			"127.0.0.1",
			"--port",
			String(fresh.port),
		];
		if (fresh.rpcServers.trim()) {
			args.push("--rpc", fresh.rpcServers.trim());
		}

		this.lastError = undefined;
		this.output.appendLine(`Starting: ${fresh.binaryPath} ${args.join(" ")}`);
		await new Promise<void>((resolve, reject) => {
			try {
				this.proc = spawn(fresh.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			if (!this.proc) {
				reject(new Error("Failed to spawn llama-server."));
				return;
			}
			this.proc.stdout?.on("data", (chunk) => this.output.append(String(chunk)));
			this.proc.stderr?.on("data", (chunk) => {
				const text = String(chunk);
				this.output.append(text);
				if (/error|failed|exception/i.test(text)) {
					this.lastError = text.trim().split("\n").pop();
				}
			});
			this.proc.on("error", (err) => {
				this.lastError = err.message;
				this.output.appendLine(`llama-server error: ${err.message}`);
				reject(err);
			});
			this.proc.on("exit", (code) => {
				this.output.appendLine(`llama-server exited with code ${code}.`);
				this.proc = undefined;
			});
			resolve();
		});

		const healthy = await this.waitForHealth(15000);
		if (healthy) {
			vscode.window.showInformationMessage(
				`llama-server is ready at ${fresh.baseUrl}.`,
			);
		} else {
			vscode.window.showWarningMessage(
				`llama-server started but health check failed. See Output > Omen llama.cpp.${this.lastError ? ` Last error: ${this.lastError}` : ""}`,
			);
		}
	}

	async stop(): Promise<void> {
		if (!this.proc) {
			return;
		}
		const proc = this.proc;
		this.proc = undefined;
		await new Promise<void>((resolve) => {
			proc.once("exit", () => resolve());
			try {
				proc.kill("SIGTERM");
			} catch {
				resolve();
			}
			setTimeout(() => {
				try {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				} catch {
					// Ignore
				}
				resolve();
			}, 3000).unref?.();
		});
		vscode.window.showInformationMessage("llama-server stopped.");
	}

	async setModelPath(): Promise<void> {
		const current = LlamaCppManager.getConfig().modelPath;
		const picked = await vscode.window.showOpenDialog({
			title: "Select GGUF model file for llama-server",
			canSelectMany: false,
			filters: { Models: ["gguf"] },
		});
		if (picked && picked.length > 0) {
			await vscode.workspace
				.getConfiguration("omen.providers.llamacpp")
				.update("modelPath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Model set to ${picked[0].fsPath}. Restart llama-server to apply.`);
		} else if (current) {
			const typed = await vscode.window.showInputBox({
				title: "GGUF model path",
				value: current,
				prompt: "Enter the full path to your .gguf file",
			});
			if (typed !== undefined) {
				await vscode.workspace
					.getConfiguration("omen.providers.llamacpp")
					.update("modelPath", typed.trim(), vscode.ConfigurationTarget.Global);
			}
		}
	}

	async setWorker(): Promise<void> {
		const current = LlamaCppManager.getConfig().rpcServers;
		const input = await vscode.window.showInputBox({
			title: "RPC worker address",
			value: current,
			placeHolder: "192.168.68.54:50052",
			prompt: "Enter the LAN rpc-server address. Leave empty for single-device mode.",
		});
		if (input !== undefined) {
			await vscode.workspace
				.getConfiguration("omen.providers.llamacpp")
				.update("rpcServers", input.trim(), vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(
				input.trim()
					? `RPC worker set to ${input.trim()}. Restart llama-server to apply.`
					: "RPC worker cleared. llama-server will run on this device only.",
			);
		}
	}

	private async waitForHealth(timeoutMs: number): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.checkHealth()) {
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (!this.isRunning()) {
				break;
			}
		}
		return this.checkHealth();
	}

	dispose(): void {
		try {
			this.proc?.kill("SIGTERM");
		} catch {
			// Ignore
		}
		this.proc = undefined;
	}
}
