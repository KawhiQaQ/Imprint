import { BaseClient, ClientConfig } from './baseClient';

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;
}

export interface PlaceVerification {
  exists: boolean;
  address?: string;
  openingHours?: string;
  rating?: number;
  description?: string;
}

export class TavilyClient extends BaseClient {
  constructor(config?: Partial<ClientConfig>) {
    const baseUrl = config?.baseUrl || 'https://api.tavily.com';
    const apiKey = config?.apiKey || process.env.TAVILY_API_KEY || '';

    super({ baseUrl, apiKey, timeout: config?.timeout });
  }

  async search(query: string, maxResults = 5): Promise<TavilySearchResult[]> {
    const response = await this.request<TavilySearchResponse>({
      method: 'POST',
      url: '/search',
      data: {
        api_key: this.apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: true,
      },
    });

    return response.results;
  }

  async verifyPlace(placeName: string, city: string): Promise<PlaceVerification> {
    try {
      console.log(`Verifying place: ${placeName} in ${city}`);
      const query = `${placeName} ${city} 地址 营业时间 评分`;
      const results = await this.search(query, 3);

      console.log(`Tavily search results for "${placeName}":`, results.length);

      if (results.length === 0) {
        return { exists: false };
      }

      // Extract information from search results
      const combinedContent = results.map((r) => r.content).join(' ');

      // Basic extraction (can be enhanced with NLP)
      const addressMatch = combinedContent.match(/地址[：:]\s*([^，。\n]+)/);
      const hoursMatch = combinedContent.match(/营业时间[：:]\s*([^，。\n]+)/);
      const ratingMatch = combinedContent.match(/(\d+\.?\d*)\s*分/);

      return {
        exists: true,
        address: addressMatch?.[1],
        openingHours: hoursMatch?.[1],
        rating: ratingMatch ? parseFloat(ratingMatch[1]) : undefined,
        description: results[0]?.content?.substring(0, 200),
      };
    } catch (error) {
      console.error('Tavily verify error:', error);
      return { exists: false };
    }
  }
}

// 延迟初始化
let _tavilyClient: TavilyClient | null = null;
export const tavilyClient = new Proxy({} as TavilyClient, {
  get(_target, prop) {
    if (!_tavilyClient) {
      _tavilyClient = new TavilyClient();
    }
    const value = (_tavilyClient as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_tavilyClient);
    }
    return value;
  }
});
