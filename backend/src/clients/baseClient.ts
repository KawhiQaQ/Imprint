import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export abstract class BaseClient {
  protected client: AxiosInstance;
  protected apiKey: string;

  constructor(config: ClientConfig) {
    this.apiKey = config.apiKey;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  protected async request<T>(config: AxiosRequestConfig, retries = 2, delayMs = 300): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, delayMs * attempt));
        }
        const response: AxiosResponse<T> = await this.client.request(config);
        return response.data;
      } catch (error) {
        if (attempt < retries && axios.isAxiosError(error) && (!error.response || error.code === 'ECONNABORTED')) {
          console.warn(`Request attempt ${attempt + 1} failed, retrying...`);
          continue;
        }
        if (axios.isAxiosError(error)) {
          const message = error.response?.data?.message || error.message;
          throw new Error(`API request failed: ${message}`);
        }
        throw error;
      }
    }
    throw new Error('Request failed after retries');
  }
}
