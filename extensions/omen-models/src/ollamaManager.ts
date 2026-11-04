/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
 

import * as vscode from 'vscode';
import { OllamaTagsResponse, OllamaPullProgress, OllamaModelTag } from './types.js';

export class OllamaManager {
  private static readonly CURATED_MODELS = [
    { name: 'llama3.2:3b', description: 'Meta Llama 3.2 (3B) — Ultra-Fast (2.0 GB)' },
    { name: 'qwen2.5-coder:7b', description: 'Qwen 2.5 Coder (7B) — Balanced Coding (4.7 GB)' },
    { name: 'qwen2.5-coder:14b', description: 'Qwen 2.5 Coder (14B) — Deep Coding Specialist (9.0 GB)' },
    { name: 'deepseek-r1:14b', description: 'DeepSeek R1 (14B) — Chain-of-Thought Reasoning (9.0 GB)' },
    { name: 'mistral:7b', description: 'Mistral (7B) — General Instruction (4.1 GB)' }
  ];

  static getBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('omen.providers.ollama');
    return config.get<string>('baseUrl', 'http://localhost:11434').replace(/\/+$/, '');
  }

  static async listInstalledModels(): Promise<OllamaModelTag[]> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/api/tags`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) {
        return [];
      }
      const data = await response.json() as OllamaTagsResponse;
      return data.models || [];
    } catch {
      return [];
    }
  }

  static async pullModel(modelName: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Omen: Pulling ${modelName} from Ollama`,
        cancellable: true
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const response = await fetch(`${this.getBaseUrl()}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName, stream: true }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Failed to pull ${modelName}: HTTP ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('No streaming body returned from Ollama');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastReportedPercent = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            try {
              const chunk = JSON.parse(line) as OllamaPullProgress;
              if (chunk.error) {
                throw new Error(chunk.error);
              }

              if (chunk.total && chunk.completed) {
                const percent = Math.floor((chunk.completed / chunk.total) * 100);
                const increment = percent - lastReportedPercent;
                if (increment > 0) {
                  const completedMB = (chunk.completed / (1024 * 1024)).toFixed(0);
                  const totalMB = (chunk.total / (1024 * 1024)).toFixed(0);
                  progress.report({
                    increment,
                    message: `${chunk.status} (${percent}% - ${completedMB}/${totalMB} MB)`
                  });
                  lastReportedPercent = percent;
                }
              } else if (chunk.status) {
                progress.report({ message: chunk.status });
              }
            } catch (err: any) {
              if (err.message && err.message !== 'Unexpected end of JSON input') {
                throw err;
              }
            }
          }
        }

        vscode.window.showInformationMessage(`✓ Model '${modelName}' downloaded and ready in Omen!`);
      }
    );
  }

  static async deleteModel(modelName: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete local model '${modelName}' from Ollama storage?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    const response = await fetch(`${this.getBaseUrl()}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });

    if (response.ok) {
      vscode.window.showInformationMessage(`✓ Model '${modelName}' deleted from local storage.`);
    } else {
      vscode.window.showErrorMessage(`Failed to delete '${modelName}': HTTP ${response.status}`);
    }
  }

  static async showManageModelsDialog(): Promise<void> {
    const installed = await this.listInstalledModels();
    const installedNames = new Set(installed.map(m => m.name));

    interface ModelItem extends vscode.QuickPickItem {
      action: 'pull' | 'delete' | 'custom';
      modelName?: string;
    }

    const items: ModelItem[] = [];

    // Section 1: Installed Models (Can Delete)
    if (installed.length > 0) {
      items.push({
        label: 'INSTALLED LOCAL MODELS',
        kind: vscode.QuickPickItemKind.Separator,
        action: 'pull'
      });
      for (const m of installed) {
        const sizeGB = (m.size / (1024 * 1024 * 1024)).toFixed(1);
        items.push({
          label: `$(check) ${m.name}`,
          description: `${sizeGB} GB — ${m.details?.parameter_size || ''} (${m.details?.quantization_level || ''})`,
          detail: 'Click to manage or delete',
          action: 'delete',
          modelName: m.name
        });
      }
    }

    // Section 2: Quick-Download Curated Models
    items.push({
      label: 'AVAILABLE TO DOWNLOAD (OLLAMA REGISTRY)',
      kind: vscode.QuickPickItemKind.Separator,
      action: 'pull'
    });

    for (const curated of this.CURATED_MODELS) {
      if (!installedNames.has(curated.name)) {
        items.push({
          label: `$(cloud-download) ${curated.name}`,
          description: curated.description,
          action: 'pull',
          modelName: curated.name
        });
      }
    }

    // Section 3: Custom Model Pull
    items.push({
      label: '$(edit) Download custom model by name...',
      description: 'Enter any model from ollama.com/library',
      action: 'custom'
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Omen: Local Models Manager (Ollama)',
      placeHolder: 'Select a model to download, or an installed model to manage'
    });

    if (!selected) {
      return;
    }

    if (selected.action === 'custom') {
      const customName = await vscode.window.showInputBox({
        title: 'Download Model from Ollama Library',
        placeHolder: 'e.g. codellama:13b, phi4, deepseek-coder-v2',
        prompt: 'Enter the exact model name from ollama.com/library'
      });
      if (customName && customName.trim()) {
        await this.pullModel(customName.trim());
      }
    } else if (selected.action === 'pull' && selected.modelName) {
      await this.pullModel(selected.modelName);
    } else if (selected.action === 'delete' && selected.modelName) {
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(trash) Delete Model', description: `Remove ${selected.modelName} to free up SSD space`, action: 'delete' },
          { label: '$(sync) Re-download / Update', description: `Pull latest weights for ${selected.modelName}`, action: 'pull' }
        ],
        { title: `Manage Model: ${selected.modelName}` }
      );
      if (action?.action === 'delete') {
        await this.deleteModel(selected.modelName);
      } else if (action?.action === 'pull') {
        await this.pullModel(selected.modelName);
      }
    }
  }
}
