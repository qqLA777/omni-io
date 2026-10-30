/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SecretManager } from './secretManager.js';
import { OllamaManager } from './ollamaManager.js';

export interface OmenChatModelInfo extends vscode.LanguageModelChatInformation {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxContextWindowTokens: number;
  capabilities: vscode.LanguageModelChatCapabilities;
  provider: 'deepseek' | 'openai' | 'ollama' | 'meta';
  baseUrl: string;
}

export class OmenLanguageModelChatProvider implements vscode.LanguageModelChatProvider<OmenChatModelInfo> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private readonly secretManager: SecretManager) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<OmenChatModelInfo[]> {
    const models: OmenChatModelInfo[] = [];

    // 1. DeepSeek Models
    const deepseekConfig = vscode.workspace.getConfiguration('omen.providers.deepseek');
    if (deepseekConfig.get<boolean>('enabled', true)) {
      const baseUrl = deepseekConfig.get<string>('baseUrl', 'https://api.deepseek.com/v1').replace(/\/+$/, '');
      models.push({
        id: 'deepseek-chat',
        name: 'DeepSeek-V3 (Chat)',
        family: 'deepseek',
        version: 'v3',
        maxInputTokens: 64000,
        maxOutputTokens: 8192,
        maxContextWindowTokens: 65536,
        capabilities: { toolCalling: true },
        provider: 'deepseek',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
      models.push({
        id: 'deepseek-reasoner',
        name: 'DeepSeek-R1 (Reasoning)',
        family: 'deepseek',
        version: 'r1',
        maxInputTokens: 64000,
        maxOutputTokens: 8192,
        maxContextWindowTokens: 65536,
        capabilities: { toolCalling: true },
        provider: 'deepseek',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
    }

    // 2. OpenAI Models
    const openaiConfig = vscode.workspace.getConfiguration('omen.providers.openai');
    if (openaiConfig.get<boolean>('enabled', true)) {
      const baseUrl = openaiConfig.get<string>('baseUrl', 'https://api.openai.com/v1').replace(/\/+$/, '');
      models.push({
        id: 'gpt-4o',
        name: 'OpenAI GPT-4o',
        family: 'openai',
        version: '2024-11-20',
        maxInputTokens: 124000,
        maxOutputTokens: 16384,
        maxContextWindowTokens: 128000,
        capabilities: { toolCalling: true, imageInput: true },
        provider: 'openai',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
      models.push({
        id: 'gpt-4o-mini',
        name: 'OpenAI GPT-4o-mini',
        family: 'openai',
        version: '2024-07-18',
        maxInputTokens: 124000,
        maxOutputTokens: 16384,
        maxContextWindowTokens: 128000,
        capabilities: { toolCalling: true, imageInput: true },
        provider: 'openai',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
    }

    // 3. Meta Muse & Llama Models (Meta Model API)
    const metaConfig = vscode.workspace.getConfiguration('omen.providers.meta');
    if (metaConfig.get<boolean>('enabled', true)) {
      const baseUrl = metaConfig.get<string>('baseUrl', 'https://api.meta.com/v1').replace(/\/+$/, '');
      models.push({
        id: 'muse-spark',
        name: 'Meta Muse Spark (Agentic Reasoning & Coding)',
        family: 'meta-muse',
        version: '1.3',
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        maxContextWindowTokens: 1000000,
        capabilities: { toolCalling: true, imageInput: true },
        provider: 'meta',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
      models.push({
        id: 'muse-wonder',
        name: 'Meta Muse Wonder (Frontier Reasoning)',
        family: 'meta-muse',
        version: '1.0',
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        maxContextWindowTokens: 128000,
        capabilities: { toolCalling: true, imageInput: true },
        provider: 'meta',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
      models.push({
        id: 'llama-3.3-70b-instruct',
        name: 'Meta Llama 3.3 70B Instruct',
        family: 'meta-llama',
        version: '3.3',
        maxInputTokens: 124000,
        maxOutputTokens: 8192,
        maxContextWindowTokens: 128000,
        capabilities: { toolCalling: true },
        provider: 'meta',
        baseUrl,
        isBYOK: true,
        isUserSelectable: true
      });
    }

    // 3. Local Ollama Models (Dynamically queried from localhost:11434)
    const ollamaConfig = vscode.workspace.getConfiguration('omen.providers.ollama');
    if (ollamaConfig.get<boolean>('enabled', true)) {
      const baseUrl = OllamaManager.getBaseUrl();
      const localModels = await OllamaManager.listInstalledModels();
      for (const m of localModels) {
        models.push({
          id: `ollama/${m.name}`,
          name: `Ollama: ${m.name}`,
          family: m.details?.family || 'ollama',
          version: m.digest.slice(0, 8),
          maxInputTokens: 30000,
          maxOutputTokens: 4096,
          maxContextWindowTokens: 32768,
          capabilities: { toolCalling: true },
          provider: 'ollama',
          baseUrl: `${baseUrl}/v1`,
          isBYOK: false,
          isUserSelectable: true
        });
      }
    }

    return models;
  }

  async provideTokenCount(
    _model: OmenChatModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    let totalLen = 0;
    if (Array.isArray(text.content)) {
      for (const part of text.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          totalLen += part.value.length;
        } else if (typeof part === 'string') {
          totalLen += (part as string).length;
        }
      }
    }
    return Math.ceil(totalLen / 4);
  }

  async provideLanguageModelChatResponse(
    model: OmenChatModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    let apiKey = '';
    if (model.provider === 'deepseek') {
      apiKey = await this.secretManager.getDeepSeekApiKey() || '';
      if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
          'DeepSeek API Key is missing. Please set your API key to proceed.',
          'Set Key'
        );
        if (action === 'Set Key') {
          await this.secretManager.promptForApiKey();
        }
        return;
      }
    } else if (model.provider === 'openai') {
      apiKey = await this.secretManager.getOpenAIApiKey() || '';
      if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
          'OpenAI API Key is missing. Please set your API key to proceed.',
          'Set Key'
        );
        if (action === 'Set Key') {
          await this.secretManager.promptForApiKey();
        }
        return;
      }
    } else if (model.provider === 'meta') {
      apiKey = await this.secretManager.getMetaApiKey() || '';
      if (!apiKey) {
        const action = await vscode.window.showErrorMessage(
          'Meta (Muse / Llama) API Key is missing. Please set your API key to proceed.',
          'Set Key'
        );
        if (action === 'Set Key') {
          await this.secretManager.promptForApiKey();
        }
        return;
      }
    }

    // Convert VS Code messages into OpenAI-compatible format
    const formattedMessages: { role: string; content: string }[] = [];
    for (const msg of messages) {
      let role = 'user';
      if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      } else if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      }

      let textContent = '';
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part instanceof vscode.LanguageModelTextPart) {
            textContent += part.value;
          }
        }
      }

      formattedMessages.push({ role, content: textContent });
    }

    const targetModelId = model.id.startsWith('ollama/')
      ? model.id.replace('ollama/', '')
      : model.id;

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: targetModelId,
        messages: formattedMessages,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${model.name} error (HTTP ${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('No streaming response body received');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              // Handle standard content tokens
              if (delta.content) {
                progress.report(new vscode.LanguageModelTextPart(delta.content));
              }
              // Handle DeepSeek R1 reasoning tokens
              if (delta.reasoning_content) {
                progress.report(new vscode.LanguageModelTextPart(delta.reasoning_content));
              }
            }
          } catch {
            // Ignore incomplete JSON chunks in SSE stream
          }
        }
      }
    }
  }
}
