/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
 

export interface OllamaModelTag {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaModelTag[];
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

export interface OmenModelDefinition {
  id: string;
  vendor: 'omen';
  name: string;
  family: string;
  provider: 'ollama' | 'deepseek' | 'openai' | 'meta';
  maxContextWindowTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  isBYOK: boolean;
  isUserSelectable: boolean;
}
