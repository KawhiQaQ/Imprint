import { BaseClient, ClientConfig } from './baseClient';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface DeepSeekConfig extends ClientConfig {
  model?: string;
}

export class DeepSeekClient extends BaseClient {
  private model: string;

  constructor(config?: Partial<DeepSeekConfig>) {
    const baseUrl = config?.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    const apiKey = config?.apiKey || process.env.DEEPSEEK_API_KEY || '';

    // DeepSeek 生成复杂内容需要较长时间，设置 300 秒超时（5分钟）
    super({ baseUrl, apiKey, timeout: config?.timeout || 300000 });

    this.model = config?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    this.client.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
  }

  async chat(messages: ChatMessage[], temperature = 0.7): Promise<string> {
    const response = await this.request<ChatCompletionResponse>({
      method: 'POST',
      url: '/chat/completions',
      data: {
        model: this.model,
        messages,
        temperature,
        max_tokens: 8192, // 增加到 8192 以支持更长的行程响应
      },
    });

    const content = response.choices[0]?.message?.content || '';
    const finishReason = response.choices[0]?.finish_reason;
    
    // 检查是否因为长度限制被截断
    if (finishReason === 'length') {
      console.warn('DeepSeek response was truncated due to max_tokens limit');
    }

    return content;
  }

  async chatWithJson<T>(messages: ChatMessage[], temperature = 0.3): Promise<T> {
    const response = await this.chat(messages, temperature);
    console.log('DeepSeek raw response length:', response.length);
    console.log('DeepSeek raw response preview:', response.substring(0, 500));

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    
    // 移除 markdown 代码块标记
    // 处理 ```json ... ``` 或 ``` ... ``` 格式
    if (jsonStr.startsWith('```')) {
      // 找到第一个换行符后的内容
      const firstNewline = jsonStr.indexOf('\n');
      if (firstNewline > 0) {
        jsonStr = jsonStr.substring(firstNewline + 1);
      }
      // 移除结尾的 ```
      const lastBackticks = jsonStr.lastIndexOf('```');
      if (lastBackticks > 0) {
        jsonStr = jsonStr.substring(0, lastBackticks);
      }
      jsonStr = jsonStr.trim();
    }
    
    console.log('Extracted JSON length:', jsonStr.length);
    console.log('Extracted JSON preview:', jsonStr.substring(0, 300));

    // 尝试修复常见的 JSON 问题
    // 1. 移除可能的尾部不完整内容
    // 2. 确保数组/对象正确闭合
    try {
      return JSON.parse(jsonStr) as T;
    } catch (firstError) {
      console.error('First JSON parse attempt failed:', firstError);
      
      // 尝试修复：如果是对象（updateWithPreference 返回的格式）
      if (jsonStr.startsWith('{')) {
        // 方法1：找到完整的 JSON 对象
        let braceCount = 0;
        let endIndex = -1;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') braceCount++;
          if (jsonStr[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIndex = i;
            break;
          }
        }
        if (endIndex > 0) {
          const fixedJson = jsonStr.substring(0, endIndex + 1);
          try {
            console.log('Trying fixed JSON (object complete):', fixedJson.substring(0, 200));
            return JSON.parse(fixedJson) as T;
          } catch {
            // 继续尝试其他修复
          }
        }
        
        // 方法2：尝试补全被截断的 JSON 对象
        // 检查是否有 updatedNodes 数组被截断
        if (jsonStr.includes('"updatedNodes"') && jsonStr.includes('[')) {
          // 找到 updatedNodes 数组的开始位置
          const arrayStart = jsonStr.indexOf('[', jsonStr.indexOf('"updatedNodes"'));
          if (arrayStart > 0) {
            // 尝试找到最后一个完整的对象
            let lastCompleteObj = -1;
            let depth = 0;
            for (let i = arrayStart; i < jsonStr.length; i++) {
              if (jsonStr[i] === '{') depth++;
              if (jsonStr[i] === '}') {
                depth--;
                if (depth === 0) {
                  lastCompleteObj = i;
                }
              }
            }
            
            if (lastCompleteObj > arrayStart) {
              // 截取到最后一个完整对象，然后补全
              const truncated = jsonStr.substring(0, lastCompleteObj + 1);
              const fixedJson = truncated + ']}';
              try {
                console.log('Trying fixed JSON (truncated array):', fixedJson.substring(0, 200));
                return JSON.parse(fixedJson) as T;
              } catch {
                // 继续尝试
              }
            }
          }
        }
        
        // 方法3：如果 updatedNodes 完全缺失或为空，返回一个默认结构
        if (!jsonStr.includes('"updatedNodes"') || jsonStr.includes('"updatedNodes": null')) {
          // 尝试提取 response 字段
          const responseMatch = jsonStr.match(/"response"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
          if (responseMatch) {
            const defaultResult = {
              response: responseMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
              updatedNodes: null,
              newPreference: null
            };
            console.log('Returning default structure with extracted response');
            return defaultResult as T;
          }
        }
      }
      
      // 尝试修复：如果是数组，确保以 ] 结尾
      if (jsonStr.startsWith('[')) {
        // 找到最后一个完整的对象
        let lastCompleteObj = -1;
        let depth = 0;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') depth++;
          if (jsonStr[i] === '}') {
            depth--;
            if (depth === 0) {
              lastCompleteObj = i;
            }
          }
        }
        
        if (lastCompleteObj > 0) {
          const fixedJson = jsonStr.substring(0, lastCompleteObj + 1) + ']';
          try {
            console.log('Trying fixed JSON (array):', fixedJson.substring(0, 200));
            return JSON.parse(fixedJson) as T;
          } catch {
            // 继续尝试其他修复
          }
        }
      }

      console.error('All JSON parse attempts failed. Raw response:', response);
      throw new Error(`Failed to parse JSON response: ${response.substring(0, 500)}...`);
    }
  }
}

// 使用函数获取实例，确保每次调用时读取最新的环境变量
let _instance: DeepSeekClient | null = null;
export function getDeepSeekClient(): DeepSeekClient {
  if (!_instance) {
    _instance = new DeepSeekClient();
  }
  return _instance;
}

// 为了兼容现有代码，提供一个 proxy
export const deepseekClient = new Proxy({} as DeepSeekClient, {
  get(_target, prop) {
    const instance = getDeepSeekClient();
    const value = (instance as any)[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  }
});
