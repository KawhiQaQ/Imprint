import { deepseekClient, DeepSeekClient, ChatMessage } from '../clients/deepseekClient';
import { unsplashClient } from '../clients/unsplashClient';
import { SearchConditions } from './storageService';

// Default placeholder image when Unsplash is disabled or fails
const DEFAULT_COVER_IMAGE = 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800';

/**
 * Check if Unsplash API is enabled
 */
function isUnsplashEnabled(): boolean {
  return process.env.UNSPLASH_ENABLED === 'true';
}

export interface DestinationCard {
  id: string;
  cityName: string;
  province: string;
  coverImageUrl: string;
  recommendReason: string;
  hotSpots: string[];
  matchScore: number;
}

export interface DestinationRecommendation {
  success: boolean;
  destinations: DestinationCard[];
  excludedCities: string[];
  errorMessage?: string;
}

interface DeepSeekDestinationResponse {
  destinations: Array<{
    cityName: string;
    province: string;
    recommendReason: string;
    hotSpots: string[];
    matchScore: number;
  }>;
}

export interface CitySearchResult {
  cityName: string;
  province: string;
  description: string;
}

export class DestinationService {
  private getDeepSeek(): DeepSeekClient {
    return deepseekClient;
  }

  /**
   * Recommends 3-4 destinations based on search conditions
   * Supports excluding cities for "换一批" feature
   */
  async recommendDestinations(
    conditions: SearchConditions,
    excludedCities: string[] = []
  ): Promise<DestinationRecommendation> {
    try {
      // Generate destination recommendations using DeepSeek
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: this.getDestinationPrompt(excludedCities),
        },
        {
          role: 'user',
          content: this.formatConditionsForPrompt(conditions),
        },
      ];

      const response = await this.getDeepSeek().chatWithJson<DeepSeekDestinationResponse>(messages);

      // Validate response
      if (!response.destinations || !Array.isArray(response.destinations)) {
        return {
          success: false,
          destinations: [],
          excludedCities,
          errorMessage: '无法获取目的地推荐，请稍后重试',
        };
      }

      // Filter out any excluded cities that might have slipped through
      const filteredDestinations = response.destinations.filter(
        (d) => !excludedCities.includes(d.cityName)
      );

      // Ensure we have 3-4 destinations
      const limitedDestinations = filteredDestinations.slice(0, 4);

      if (limitedDestinations.length < 3) {
        return {
          success: false,
          destinations: [],
          excludedCities,
          errorMessage: '符合条件的目的地不足，请尝试调整您的旅行愿景',
        };
      }

      // 提取用户偏好关键词用于图片搜索
      const userKeywords = [
        ...conditions.geographicFeatures,
        ...conditions.foodPreferences,
        ...conditions.activityTypes,
      ];

      // Fetch cover images for each destination with context
      const destinationsWithImages = await this.addCoverImages(limitedDestinations, userKeywords);

      return {
        success: true,
        destinations: destinationsWithImages,
        excludedCities: [...excludedCities, ...destinationsWithImages.map((d) => d.cityName)],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '推荐服务暂时不可用，请稍后重试';
      return {
        success: false,
        destinations: [],
        excludedCities,
        errorMessage,
      };
    }
  }

  /**
   * Fetches a cover image for a city from Unsplash with context
   * Falls back to default image on failure or when disabled
   */
  async fetchCoverImage(
    cityName: string, 
    keywords: string[] = [], 
    hotSpots: string[] = []
  ): Promise<string> {
    // Skip Unsplash API if disabled
    if (!isUnsplashEnabled()) {
      return DEFAULT_COVER_IMAGE;
    }

    try {
      const imageUrl = await unsplashClient.getContextualCityPhoto(cityName, keywords, hotSpots);
      return imageUrl || DEFAULT_COVER_IMAGE;
    } catch (error) {
      console.warn(`Failed to fetch cover image for ${cityName}:`, error);
      return DEFAULT_COVER_IMAGE;
    }
  }

  /**
   * Adds cover images to destination cards
   */
  private async addCoverImages(
    destinations: DeepSeekDestinationResponse['destinations'],
    userKeywords: string[] = []
  ): Promise<DestinationCard[]> {
    // 并行获取所有图片以提高速度
    const imagePromises = destinations.map(dest => 
      this.fetchCoverImage(dest.cityName, userKeywords, dest.hotSpots)
    );
    
    const images = await Promise.all(imagePromises);

    return destinations.map((dest, index) => ({
      id: this.generateDestinationId(dest.cityName),
      cityName: dest.cityName,
      province: dest.province,
      coverImageUrl: images[index],
      recommendReason: dest.recommendReason,
      hotSpots: dest.hotSpots || [],
      matchScore: dest.matchScore || 80,
    }));
  }

  /**
   * Generates a unique ID for a destination
   */
  private generateDestinationId(cityName: string): string {
    return `dest_${cityName}_${Date.now()}`;
  }

  /**
   * Creates the system prompt for destination recommendation
   */
  private getDestinationPrompt(excludedCities: string[]): string {
    const exclusionClause =
      excludedCities.length > 0
        ? `\n\n重要：请不要推荐以下城市（用户已经看过）：${excludedCities.join('、')}`
        : '';

    return `你是一个专业的中国旅行规划专家。根据用户的旅行偏好，推荐3-4个最适合的中国城市作为旅行目的地。

请以JSON格式返回推荐结果（不要包含任何其他文字，只返回JSON）：
{
  "destinations": [
    {
      "cityName": "城市名称",
      "province": "所属省份",
      "recommendReason": "推荐理由（50-100字，说明为什么这个城市符合用户需求）",
      "hotSpots": ["热门景点1", "热门景点2", "热门景点3"],
      "matchScore": 85
    }
  ]
}

要求：
1. 推荐3-4个城市，不多不少
2. 每个城市必须有完整的信息：城市名、省份、推荐理由、至少3个热门景点
3. matchScore是匹配度分数（0-100），根据用户需求与城市特点的契合度评分
4. 推荐理由要具体说明城市如何满足用户的地理特征、气候、美食等需求
5. 热门景点要是真实存在的知名景点${exclusionClause}`;
  }

  /**
   * Formats search conditions into a prompt for DeepSeek
   */
  private formatConditionsForPrompt(conditions: SearchConditions): string {
    const parts: string[] = [];

    if (conditions.geographicFeatures.length > 0) {
      parts.push(`地理特征偏好：${conditions.geographicFeatures.join('、')}`);
    }

    if (conditions.climatePreference) {
      parts.push(`气候偏好：${conditions.climatePreference}`);
    }

    if (conditions.foodPreferences.length > 0) {
      parts.push(`美食需求：${conditions.foodPreferences.join('、')}`);
    }

    if (conditions.activityTypes.length > 0) {
      parts.push(`活动类型：${conditions.activityTypes.join('、')}`);
    }

    if (conditions.budgetLevel) {
      parts.push(`预算级别：${conditions.budgetLevel}`);
    }

    if (conditions.travelStyle) {
      parts.push(`旅行风格：${conditions.travelStyle}`);
    }

    return parts.length > 0 ? parts.join('\n') : '请推荐适合休闲旅行的热门城市';
  }

  /**
   * Search cities by name using DeepSeek
   * Returns matching Chinese cities with basic info
   */
  async searchCities(query: string): Promise<CitySearchResult[]> {
    if (!query || query.trim().length < 1) {
      return [];
    }

    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `你是一个中国城市数据库。根据用户输入的关键词，返回匹配的中国城市列表。

请以JSON格式返回（不要包含任何其他文字，只返回JSON）：
{
  "cities": [
    {
      "cityName": "城市名称",
      "province": "所属省份",
      "description": "城市简短描述（20字以内）"
    }
  ]
}

要求：
1. 只返回真实存在的中国城市（地级市或以上）
2. 最多返回8个匹配结果
3. 按匹配度和城市知名度排序
4. 支持拼音、城市名、省份名等多种搜索方式
5. 如果没有匹配的城市，返回空数组`,
        },
        {
          role: 'user',
          content: `搜索城市：${query.trim()}`,
        },
      ];

      const response = await this.getDeepSeek().chatWithJson<{ cities: CitySearchResult[] }>(messages);

      if (!response.cities || !Array.isArray(response.cities)) {
        return [];
      }

      return response.cities.slice(0, 8);
    } catch (error) {
      console.error('City search error:', error);
      return [];
    }
  }

  /**
   * Get city details for direct selection
   */
  async getCityDetails(cityName: string): Promise<DestinationCard | null> {
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `你是一个中国旅行专家。根据城市名称，返回该城市的旅行信息。

请以JSON格式返回（不要包含任何其他文字，只返回JSON）：
{
  "cityName": "城市名称",
  "province": "所属省份",
  "recommendReason": "城市旅行亮点（50-80字）",
  "hotSpots": ["热门景点1", "热门景点2", "热门景点3"]
}

要求：
1. 必须是真实存在的中国城市
2. 推荐理由要突出城市特色
3. 热门景点要是真实存在的知名景点`,
        },
        {
          role: 'user',
          content: `城市：${cityName}`,
        },
      ];

      const response = await this.getDeepSeek().chatWithJson<{
        cityName: string;
        province: string;
        recommendReason: string;
        hotSpots: string[];
      }>(messages);

      if (!response.cityName) {
        return null;
      }

      // Fetch cover image
      const coverImageUrl = await this.fetchCoverImage(response.cityName, [], response.hotSpots);

      return {
        id: this.generateDestinationId(response.cityName),
        cityName: response.cityName,
        province: response.province,
        coverImageUrl,
        recommendReason: response.recommendReason,
        hotSpots: response.hotSpots || [],
        matchScore: 100, // Direct selection always 100%
      };
    } catch (error) {
      console.error('Get city details error:', error);
      return null;
    }
  }
}

export const destinationService = new DestinationService();
