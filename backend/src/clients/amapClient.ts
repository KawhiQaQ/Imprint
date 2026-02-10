import { BaseClient, ClientConfig } from './baseClient';

// POI 类型编码
export const POI_TYPES = {
  // 餐饮
  RESTAURANT: '050000', // 餐饮服务
  CHINESE_FOOD: '050100', // 中餐厅
  FOREIGN_FOOD: '050200', // 外国餐厅
  FAST_FOOD: '050300', // 快餐厅
  CAFE: '050500', // 咖啡厅
  TEA_HOUSE: '050600', // 茶艺馆
  
  // 住宿
  HOTEL: '100000', // 住宿服务
  STAR_HOTEL: '100100', // 星级酒店
  BUDGET_HOTEL: '100200', // 经济型酒店
  APARTMENT_HOTEL: '100300', // 公寓式酒店
  HOSTEL: '100400', // 民宿/客栈
  
  // 景点
  SCENIC: '110000', // 风景名胜
  PARK: '110101', // 公园
  MUSEUM: '140000', // 科教文化
  
  // 交通
  TRAIN_STATION: '150200', // 火车站
  AIRPORT: '150100', // 机场
  BUS_STATION: '150300', // 长途汽车站
};

export interface AmapPOI {
  id: string;
  name: string;
  type: string;
  typecode: string;
  address: string;
  location: string; // "经度,纬度"
  tel?: string;
  rating?: string; // 评分 1-5
  cost?: string; // 人均消费
  photos?: Array<{ url: string }>;
  opentime?: string;
  city: string;
  district: string;
}

export interface AmapSearchResponse {
  status: string;
  count: string;
  pois: AmapPOI[];
}

export interface AmapDetailResponse {
  status: string;
  pois: AmapPOI[];
}

export interface SearchOptions {
  city: string;
  keywords?: string;
  types?: string;
  page?: number;
  pageSize?: number;
  sortRule?: 'distance' | 'weight'; // 排序规则
  extensions?: 'base' | 'all'; // all 返回更多信息
}

export interface HotelSearchOptions extends SearchOptions {
  minPrice?: number;
  maxPrice?: number;
}

export interface RestaurantSearchOptions extends SearchOptions {
  cuisine?: string; // 菜系
}

export class AmapClient extends BaseClient {
  constructor(config?: Partial<ClientConfig>) {
    const baseUrl = config?.baseUrl || 'https://restapi.amap.com/v3';
    const apiKey = config?.apiKey || process.env.AMAP_API_KEY || '';

    super({ baseUrl, apiKey, timeout: config?.timeout || 10000 });
  }

  /**
   * 关键词搜索 POI
   */
  async searchPOI(options: SearchOptions): Promise<AmapPOI[]> {
    try {
      const params: Record<string, string | number> = {
        key: this.apiKey,
        city: options.city,
        citylimit: 'true', // 限制在指定城市
        output: 'json',
        offset: options.pageSize || 20,
        page: options.page || 1,
        extensions: options.extensions || 'all',
      };

      if (options.keywords) {
        params.keywords = options.keywords;
      }
      if (options.types) {
        params.types = options.types;
      }
      if (options.sortRule) {
        params.sortrule = options.sortRule;
      }

      const response = await this.request<AmapSearchResponse>({
        method: 'GET',
        url: '/place/text',
        params,
      });

      if (response.status !== '1') {
        console.error('Amap search failed:', response);
        return [];
      }

      return response.pois || [];
    } catch (error) {
      console.error('Amap search error:', error);
      return [];
    }
  }

  /**
   * 搜索酒店
   */
  async searchHotels(options: HotelSearchOptions): Promise<AmapPOI[]> {
    const pois = await this.searchPOI({
      ...options,
      types: options.types || POI_TYPES.HOTEL,
      extensions: 'all',
    });

    // 按价格筛选
    let filtered = pois;
    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
      filtered = pois.filter(poi => {
        if (!poi.cost) return true; // 没有价格信息的保留
        const price = parseFloat(poi.cost);
        if (isNaN(price)) return true;
        
        if (options.minPrice !== undefined && price < options.minPrice) return false;
        if (options.maxPrice !== undefined && price > options.maxPrice) return false;
        return true;
      });
    }

    return filtered;
  }

  /**
   * 搜索餐厅
   */
  async searchRestaurants(options: RestaurantSearchOptions): Promise<AmapPOI[]> {
    let keywords = options.keywords || '';
    if (options.cuisine) {
      keywords = options.cuisine + (keywords ? ' ' + keywords : '');
    }

    return this.searchPOI({
      ...options,
      keywords,
      types: options.types || POI_TYPES.RESTAURANT,
      extensions: 'all',
    });
  }

  /**
   * 搜索景点
   */
  async searchAttractions(options: SearchOptions): Promise<AmapPOI[]> {
    return this.searchPOI({
      ...options,
      types: options.types || POI_TYPES.SCENIC,
      extensions: 'all',
    });
  }

  /**
   * 获取 POI 详情
   */
  async getPOIDetail(poiId: string): Promise<AmapPOI | null> {
    try {
      const response = await this.request<AmapDetailResponse>({
        method: 'GET',
        url: '/place/detail',
        params: {
          key: this.apiKey,
          id: poiId,
          output: 'json',
        },
      });

      if (response.status !== '1' || !response.pois?.length) {
        return null;
      }

      return response.pois[0];
    } catch (error) {
      console.error('Amap detail error:', error);
      return null;
    }
  }

  /**
   * 格式化 POI 为行程节点格式
   */
  formatPOIForItinerary(poi: AmapPOI, type: 'attraction' | 'restaurant' | 'hotel'): {
    name: string;
    type: string;
    address: string;
    description: string;
    rating?: number;
    price?: number;
    tel?: string;
  } {
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
    };
  }
}

// 延迟初始化
let _amapClient: AmapClient | null = null;
export const amapClient = new Proxy({} as AmapClient, {
  get(_target, prop) {
    if (!_amapClient) {
      _amapClient = new AmapClient();
    }
    const value = (_amapClient as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_amapClient);
    }
    return value;
  }
});
