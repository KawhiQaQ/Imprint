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

  protected async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response: AxiosResponse<T> = await this.client.request(config);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || error.message;
        throw new Error(`API request failed: ${message}`);
      }
      throw error;
    }
  }
}
