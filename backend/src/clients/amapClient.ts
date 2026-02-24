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
  business_status?: string; // 营业状态
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

export interface AmapDistanceResponse {
  status: string;
  results: Array<{
    origin_id: string;
    dest_id: string;
    distance: string; // 距离，单位：米
    duration: string; // 时间，单位：秒
  }>;
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

    super({ baseUrl, apiKey, timeout: config?.timeout || 15000 });
  }

  /**
   * 过滤掉暂停营业、已关闭等不可用的 POI
   */
  private filterAvailablePOIs(pois: AmapPOI[]): AmapPOI[] {
    const closedPattern = /暂停营业|停业整顿|已关闭|已停业|装修中|暂未营业/;
    return pois.filter(p => !closedPattern.test(p.name));
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

      return this.filterAvailablePOIs(response.pois || []);
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
   * 周边搜索 POI（基于坐标）
   * @param location 中心点坐标，格式 "经度,纬度"
   * @param radius 搜索半径，单位米，最大 50000
   * @param options 搜索选项
   */
  async searchAround(
    location: string,
    radius: number,
    options: {
      keywords?: string;
      types?: string;
      pageSize?: number;
      sortRule?: 'distance' | 'weight';
    } = {}
  ): Promise<AmapPOI[]> {
    try {
      const params: Record<string, string | number> = {
        key: this.apiKey,
        location,
        radius: Math.min(radius, 50000), // 最大 50km
        output: 'json',
        offset: options.pageSize || 20,
        extensions: 'all',
        sortrule: options.sortRule || 'distance', // 默认按距离排序
      };

      if (options.keywords) {
        params.keywords = options.keywords;
      }
      if (options.types) {
        params.types = options.types;
      }

      const response = await this.request<AmapSearchResponse>({
        method: 'GET',
        url: '/place/around',
        params,
      });

      if (response.status !== '1') {
        console.error('Amap around search failed:', response);
        return [];
      }

      return this.filterAvailablePOIs(response.pois || []);
    } catch (error) {
      console.error('Amap around search error:', error);
      return [];
    }
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

      const poi = response.pois[0];
      const closedPattern = /暂停营业|停业整顿|已关闭|已停业|装修中|暂未营业/;
      if (closedPattern.test(poi.name)) return null;
      return poi;
    } catch (error) {
      console.error('Amap detail error:', error);
      return null;
    }
  }

  /**
   * 计算两点之间的直线距离（Haversine 公式）
   * @param loc1 位置1，格式 "经度,纬度"
   * @param loc2 位置2，格式 "经度,纬度"
   * @returns 距离（公里）
   */
  calculateDistance(loc1: string, loc2: string): number {
    const [lng1, lat1] = loc1.split(',').map(Number);
    const [lng2, lat2] = loc2.split(',').map(Number);
    
    if (isNaN(lng1) || isNaN(lat1) || isNaN(lng2) || isNaN(lat2)) {
      return 0;
    }

    const R = 6371; // 地球半径（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10; // 保留一位小数
  }

  /**
   * 批量计算距离（使用高德距离测量 API）
   * @param origins 起点坐标数组，格式 ["经度,纬度", ...]
   * @param destinations 终点坐标数组，格式 ["经度,纬度", ...]
   * @param type 计算类型：0-直线距离，1-驾车距离
   */
  async batchCalculateDistance(
    origins: string[],
    destinations: string[],
    type: 0 | 1 = 1
  ): Promise<Array<{ distance: number; duration: number }>> {
    try {
      const response = await this.request<AmapDistanceResponse>({
        method: 'GET',
        url: '/distance',
        params: {
          key: this.apiKey,
          origins: origins.join('|'),
          destination: destinations.join('|'),
          type,
          output: 'json',
        },
      });

      if (response.status !== '1' || !response.results) {
        // 如果 API 失败，使用直线距离计算
        return origins.map((origin, i) => ({
          distance: this.calculateDistance(origin, destinations[i] || destinations[0]),
          duration: 0,
        }));
      }

      return response.results.map(r => ({
        distance: Math.round(parseInt(r.distance) / 100) / 10, // 转换为公里，保留一位小数
        duration: Math.round(parseInt(r.duration) / 60), // 转换为分钟
      }));
    } catch (error) {
      console.error('Amap distance error:', error);
      // 失败时使用直线距离
      return origins.map((origin, i) => ({
        distance: this.calculateDistance(origin, destinations[i] || destinations[0]),
        duration: 0,
      }));
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
    const descParts: string[] = [];
    
    if (poi.rating) {
      descParts.push(`评分${poi.rating}`);
    }
    if (poi.cost) {
      descParts.push(`人均¥${poi.cost}`);
    }
    if (poi.opentime && poi.opentime !== '[]') {
      descParts.push(poi.opentime);
    }

    // 生成有意义的描述，不使用高德的分类信息
    let description = descParts.join('，');
    if (!description) {
      if (type === 'restaurant') {
        description = '当地特色餐厅';
      } else if (type === 'hotel') {
        description = '舒适住宿';
      } else {
        description = '值得一游的景点';
      }
    }

    // 安全拼接地址，过滤掉 undefined/null/空字符串
    const addressParts = [poi.city, poi.district, poi.address].filter(Boolean);
    const fullAddress = addressParts.join('') || '地址未知';

    return {
      name: poi.name,
      type,
      address: fullAddress,
      description,
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
