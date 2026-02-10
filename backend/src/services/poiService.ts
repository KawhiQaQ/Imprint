import { amapClient, AmapPOI, POI_TYPES } from '../clients/amapClient';
import { deepseekClient, ChatMessage } from '../clients/deepseekClient';

export interface POISearchParams {
  city: string;
  type: 'hotel' | 'restaurant' | 'attraction';
  keywords?: string;
  cuisine?: string; // 餐厅菜系
  minPrice?: number;
  maxPrice?: number;
  count?: number;
}

export interface EnrichedPOI {
  name: string;
  type: 'attraction' | 'restaurant' | 'hotel';
  address: string;
  description: string;
  rating?: number;
  price?: number;
  tel?: string;
  location?: string;
  amapId?: string;
}

export class POIService {
  /**
   * 搜索 POI 并返回格式化结果
   */
  async searchPOIs(params: POISearchParams): Promise<EnrichedPOI[]> {
    const { city, type, keywords, cuisine, minPrice, maxPrice, count = 10 } = params;

    let pois: AmapPOI[] = [];

    switch (type) {
      case 'hotel':
        pois = await amapClient.searchHotels({
          city,
          keywords,
          minPrice,
          maxPrice,
          pageSize: count,
        });
        break;

      case 'restaurant':
        pois = await amapClient.searchRestaurants({
          city,
          keywords,
          cuisine,
          pageSize: count,
        });
        break;

      case 'attraction':
        pois = await amapClient.searchAttractions({
          city,
          keywords,
          pageSize: count,
        });
        break;
    }

    return pois.map(poi => this.formatPOI(poi, type));
  }

  /**
   * 根据用户偏好搜索酒店
   */
  async searchHotelsByPreference(
    city: string,
    preferences: {
      budgetLevel?: string;
      style?: string;
      keywords?: string;
    }
  ): Promise<EnrichedPOI[]> {
    // 根据预算级别设置价格区间
    let minPrice: number | undefined;
    let maxPrice: number | undefined;

    switch (preferences.budgetLevel) {
      case '经济':
      case '低':
        maxPrice = 300;
        break;
      case '中等':
        minPrice = 200;
        maxPrice = 600;
        break;
      case '高端':
      case '奢华':
        minPrice = 500;
        break;
    }

    // 根据风格选择酒店类型
    let types = POI_TYPES.HOTEL;
    if (preferences.style?.includes('民宿') || preferences.style?.includes('特色')) {
      types = POI_TYPES.HOSTEL;
    } else if (preferences.style?.includes('高端') || preferences.style?.includes('奢华')) {
      types = POI_TYPES.STAR_HOTEL;
    }

    const pois = await amapClient.searchHotels({
      city,
      keywords: preferences.keywords,
      types,
      minPrice,
      maxPrice,
      pageSize: 10,
    });

    return pois.map(poi => this.formatPOI(poi, 'hotel'));
  }

  /**
   * 根据用户偏好搜索餐厅
   */
  async searchRestaurantsByPreference(
    city: string,
    preferences: {
      foodPreferences?: string[];
      budgetLevel?: string;
      keywords?: string;
    }
  ): Promise<EnrichedPOI[]> {
    const results: EnrichedPOI[] = [];

    // 根据美食偏好搜索
    const cuisines = preferences.foodPreferences?.length 
      ? preferences.foodPreferences 
      : ['美食', '餐厅']; // 使用更通用的搜索词
    
    for (const cuisine of cuisines.slice(0, 3)) { // 最多搜索3种菜系
      const pois = await amapClient.searchRestaurants({
        city,
        cuisine,
        keywords: preferences.keywords,
        pageSize: 5,
      });

      results.push(...pois.map(poi => this.formatPOI(poi, 'restaurant')));
    }

    // 如果没有结果，尝试不带关键词直接搜索餐饮类型
    if (results.length === 0) {
      const pois = await amapClient.searchPOI({
        city,
        types: POI_TYPES.RESTAURANT,
        pageSize: 10,
      });
      results.push(...pois.map(poi => this.formatPOI(poi, 'restaurant')));
    }

    // 去重
    const seen = new Set<string>();
    return results.filter(poi => {
      if (seen.has(poi.name)) return false;
      seen.add(poi.name);
      return true;
    });
  }

  /**
   * 搜索景点
   */
  async searchAttractionsByPreference(
    city: string,
    preferences: {
      activityTypes?: string[];
      keywords?: string;
    }
  ): Promise<EnrichedPOI[]> {
    const results: EnrichedPOI[] = [];

    // 根据活动类型搜索
    const activities = preferences.activityTypes || ['观光'];
    
    for (const activity of activities.slice(0, 3)) {
      const pois = await amapClient.searchAttractions({
        city,
        keywords: activity,
        pageSize: 5,
      });

      results.push(...pois.map(poi => this.formatPOI(poi, 'attraction')));
    }

    // 去重
    const seen = new Set<string>();
    return results.filter(poi => {
      if (seen.has(poi.name)) return false;
      seen.add(poi.name);
      return true;
    });
  }

  /**
   * 使用 AI 从 POI 列表中选择最合适的
   */
  async selectBestPOIs(
    pois: EnrichedPOI[],
    userPreferences: string,
    count: number = 5
  ): Promise<EnrichedPOI[]> {
    if (pois.length <= count) {
      return pois;
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个旅行规划助手。根据用户偏好，从以下POI列表中选择最合适的${count}个。
只返回选中的POI名称，用逗号分隔，不要其他内容。`,
      },
      {
        role: 'user',
        content: `用户偏好：${userPreferences}

POI列表：
${pois.map((p, i) => `${i + 1}. ${p.name} - ${p.description} (${p.address})`).join('\n')}

请选择最合适的${count}个：`,
      },
    ];

    try {
      const response = await deepseekClient.chat(messages, 0.3);
      const selectedNames = response.split(/[,，]/).map(s => s.trim());

      // 按选择顺序返回
      const selected: EnrichedPOI[] = [];
      for (const name of selectedNames) {
        const poi = pois.find(p => p.name.includes(name) || name.includes(p.name));
        if (poi && !selected.includes(poi)) {
          selected.push(poi);
        }
      }

      // 如果选择不够，补充剩余的
      if (selected.length < count) {
        for (const poi of pois) {
          if (!selected.includes(poi)) {
            selected.push(poi);
            if (selected.length >= count) break;
          }
        }
      }

      return selected.slice(0, count);
    } catch (error) {
      console.error('AI selection failed:', error);
      return pois.slice(0, count);
    }
  }

  /**
   * 格式化 POI
   */
  private formatPOI(poi: AmapPOI, type: 'attraction' | 'restaurant' | 'hotel'): EnrichedPOI {
    let description = '';
    if (poi.rating) {
      description += `评分${poi.rating}`;
    }
    if (poi.cost) {
      description += description ? '，' : '';
      description += `人均¥${poi.cost}`;
    }
    if (poi.opentime) {
      description += description ? '，' : '';
      description += poi.opentime;
    }

    // 安全拼接地址，过滤掉 undefined/null/空字符串
    const addressParts = [poi.city, poi.district, poi.address].filter(Boolean);
    const fullAddress = addressParts.join('') || '地址未知';

    return {
      name: poi.name,
      type,
      address: fullAddress,
      description: description || poi.type || '',
      rating: poi.rating ? parseFloat(poi.rating) : undefined,
      price: poi.cost ? parseFloat(poi.cost) : undefined,
      tel: poi.tel,
      location: poi.location,
      amapId: poi.id,
    };
  }
}

export const poiService = new POIService();
