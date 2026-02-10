import { BaseClient, ClientConfig } from './baseClient';

export interface WanxTaskResponse {
  output: {
    task_id: string;
    task_status: string;
  };
  request_id: string;
}

export interface WanxResultResponse {
  output: {
    task_id: string;
    task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    results?: Array<{
      url: string;
    }>;
  };
  request_id: string;
}

// 可用的万相模型版本
export type WanxModel = 'wanx-v1' | 'wanx2.1-t2i-turbo';

export class WanxClient extends BaseClient {
  private model: WanxModel;

  constructor(config?: Partial<ClientConfig>) {
    const baseUrl =
      config?.baseUrl || process.env.WANX_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
    const apiKey = config?.apiKey || process.env.WANX_API_KEY || '';

    super({ baseUrl, apiKey, timeout: config?.timeout || 120000 });

    this.client.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
    this.client.defaults.headers.common['X-DashScope-Async'] = 'enable';

    // 从环境变量读取模型版本，默认使用 wanx-v1（更便宜）
    const envModel = process.env.WANX_MODEL as WanxModel;
    this.model = envModel === 'wanx2.1-t2i-turbo' ? 'wanx2.1-t2i-turbo' : 'wanx-v1';
    
    console.log(`[WanxClient] 初始化完成，使用模型: ${this.model}`);
  }

  async generateImage(prompt: string, style = 'watercolor', orientation: 'square' | 'portrait' | 'landscape' | 'polaroid' | 'polaroid-landscape' = 'square'): Promise<string> {
    console.log(`[WanxClient] 开始生成图片`);
    console.log(`[WanxClient] 模型版本: ${this.model}`);
    console.log(`[WanxClient] 方向: ${orientation}`);
    console.log(`[WanxClient] Prompt: ${prompt}`);
    
    // 根据方向选择尺寸
    // wanx-v1 支持: 1024*1024, 720*1280, 1280*720
    // wanx2.1-t2i-turbo 支持: 1024*1024, 768*1024, 1024*768, 720*1280, 1280*720
    let size: string;
    if (this.model === 'wanx2.1-t2i-turbo') {
      // wanx2.1 支持 3:4 和 4:3 比例
      const sizeMap: Record<string, string> = {
        square: '1024*1024',
        portrait: '768*1024',         // 竖版 3:4
        polaroid: '768*1024',         // 拍立得竖版 3:4
        landscape: '1024*768',        // 横版 4:3
        'polaroid-landscape': '1024*768',  // 拍立得横版 4:3
      };
      size = sizeMap[orientation];
    } else {
      // wanx-v1 只支持 9:16 和 16:9
      const sizeMap: Record<string, string> = {
        square: '1024*1024',
        portrait: '720*1280',         // 竖版 9:16
        polaroid: '720*1280',         // 拍立得用 9:16
        landscape: '1280*720',        // 横版 16:9
        'polaroid-landscape': '1280*720',  // 拍立得横版 16:9
      };
      size = sizeMap[orientation];
    }
    
    // 根据模型版本构建不同的请求参数
    const requestData = this.model === 'wanx-v1' 
      ? {
          model: 'wanx-v1',
          input: {
            prompt: `${style} style, ${prompt}`,
          },
          parameters: {
            style: '<watercolor>',
            size,
            n: 1,
          },
        }
      : {
          model: 'wanx2.1-t2i-turbo',
          input: {
            prompt: prompt,
          },
          parameters: {
            size,
            n: 1,
          },
        };

    // Submit task
    const taskResponse = await this.request<WanxTaskResponse>({
      method: 'POST',
      url: '/services/aigc/text2image/image-synthesis',
      data: requestData,
    });

    const taskId = taskResponse.output.task_id;
    console.log(`[WanxClient] 任务已提交, taskId: ${taskId}`);

    // Poll for result
    const result = await this.pollForResult(taskId);
    console.log(`[WanxClient] 图片生成完成, URL: ${result}`);
    return result;
  }

  private async pollForResult(taskId: string, maxAttempts = 60): Promise<string> {
    for (let i = 0; i < maxAttempts; i++) {
      await this.delay(2000);

      const result = await this.request<WanxResultResponse>({
        method: 'GET',
        url: `/tasks/${taskId}`,
      });

      console.log(`[WanxClient] 轮询任务状态 (${i + 1}/${maxAttempts}): ${result.output.task_status}`);

      if (result.output.task_status === 'SUCCEEDED') {
        return result.output.results?.[0]?.url || '';
      }

      if (result.output.task_status === 'FAILED') {
        console.error('[WanxClient] 图片生成失败');
        throw new Error('Image generation failed');
      }
    }

    console.error('[WanxClient] 图片生成超时');
    throw new Error('Image generation timed out');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// 延迟初始化
let _wanxClient: WanxClient | null = null;
export const wanxClient = new Proxy({} as WanxClient, {
  get(_target, prop) {
    if (!_wanxClient) {
      _wanxClient = new WanxClient();
    }
    const value = (_wanxClient as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_wanxClient);
    }
    return value;
  }
});
