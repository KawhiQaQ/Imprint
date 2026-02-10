import { BaseClient, ClientConfig } from './baseClient';

export interface QwenVLMessage {
  role: 'system' | 'user' | 'assistant';
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    image?: string;
  }>;
}

export interface QwenVLResponse {
  output: {
    choices: Array<{
      message: {
        content: Array<{ text: string }>;
      };
    }>;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  request_id: string;
}

export class QwenVLClient extends BaseClient {
  constructor(config?: Partial<ClientConfig>) {
    const baseUrl =
      config?.baseUrl || process.env.QWEN_VL_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
    const apiKey = config?.apiKey || process.env.QWEN_VL_API_KEY || '';

    super({ baseUrl, apiKey, timeout: config?.timeout || 60000 });

    this.client.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
  }

  async analyzeImage(imageUrl: string, prompt?: string): Promise<string> {
    const defaultPrompt = '请详细描述这张图片的内容，包括场景、人物、情绪和氛围。';

    const response = await this.request<QwenVLResponse>({
      method: 'POST',
      url: '/services/aigc/multimodal-generation/generation',
      data: {
        model: 'qwen-vl-plus',
        input: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', image: imageUrl },
                { type: 'text', text: prompt || defaultPrompt },
              ],
            },
          ],
        },
      },
    });

    return response.output?.choices?.[0]?.message?.content?.[0]?.text || '';
  }
}

// 延迟初始化
let _qwenVLClient: QwenVLClient | null = null;
export const qwenVLClient = new Proxy({} as QwenVLClient, {
  get(_target, prop) {
    if (!_qwenVLClient) {
      _qwenVLClient = new QwenVLClient();
    }
    const value = (_qwenVLClient as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_qwenVLClient);
    }
    return value;
  }
});
