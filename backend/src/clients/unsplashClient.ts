import { BaseClient, ClientConfig } from './baseClient';

export interface UnsplashPhoto {
  id: string;
  urls: {
    raw: string;
    full: string;
    regular: string;
    small: string;
    thumb: string;
  };
  alt_description: string | null;
  description: string | null;
  user: {
    name: string;
    username: string;
  };
}

export interface UnsplashSearchResponse {
  total: number;
  total_pages: number;
  results: UnsplashPhoto[];
}

// 常见中国城市的英文名映射
const CITY_NAME_MAP: Record<string, string> = {
  '北京': 'Beijing',
  '上海': 'Shanghai',
  '广州': 'Guangzhou',
  '深圳': 'Shenzhen',
  '成都': 'Chengdu',
  '杭州': 'Hangzhou',
  '重庆': 'Chongqing',
  '西安': 'Xian',
  '南京': 'Nanjing',
  '武汉': 'Wuhan',
  '苏州': 'Suzhou',
  '丽江': 'Lijiang',
  '大理': 'Dali Yunnan',
  '昆明': 'Kunming',
  '三亚': 'Sanya beach',
  '厦门': 'Xiamen',
  '青岛': 'Qingdao',
  '桂林': 'Guilin landscape',
  '张家界': 'Zhangjiajie',
  '黄山': 'Huangshan mountain',
  '西宁': 'Qinghai lake',
  '拉萨': 'Lhasa Tibet',
  '康定': 'Kangding Sichuan mountain',
  '九寨沟': 'Jiuzhaigou',
  '香格里拉': 'Shangri-La Yunnan',
  '凤凰': 'Fenghuang ancient town',
  '乌镇': 'Wuzhen water town',
  '周庄': 'Zhouzhuang',
  '平遥': 'Pingyao ancient city',
  '敦煌': 'Dunhuang desert',
  '哈尔滨': 'Harbin ice',
  '长沙': 'Changsha',
  '贵阳': 'Guiyang',
  '兰州': 'Lanzhou',
  '银川': 'Yinchuan',
  '呼和浩特': 'Inner Mongolia grassland',
  '乌鲁木齐': 'Xinjiang',
  '稻城': 'Daocheng Yading',
  '色达': 'Seda Sichuan',
  '泸沽湖': 'Lugu Lake',
  '洱海': 'Erhai Lake Dali',
  '阳朔': 'Yangshuo Guilin',
  '婺源': 'Wuyuan Jiangxi',
  '西塘': 'Xitang water town',
  '南浔': 'Nanxun ancient town',
  // 新增城市
  '嘉兴': 'Jiaxing water town',
  '绍兴': 'Shaoxing',
  '宁波': 'Ningbo',
  '温州': 'Wenzhou',
  '无锡': 'Wuxi',
  '常州': 'Changzhou',
  '镇江': 'Zhenjiang',
  '扬州': 'Yangzhou',
  '南通': 'Nantong',
  '徐州': 'Xuzhou',
  '合肥': 'Hefei',
  '福州': 'Fuzhou',
  '泉州': 'Quanzhou',
  '南昌': 'Nanchang',
  '九江': 'Jiujiang',
  '景德镇': 'Jingdezhen porcelain',
  '济南': 'Jinan',
  '烟台': 'Yantai',
  '威海': 'Weihai',
  '郑州': 'Zhengzhou',
  '洛阳': 'Luoyang',
  '开封': 'Kaifeng',
  '太原': 'Taiyuan',
  '大同': 'Datong',
  '石家庄': 'Shijiazhuang',
  '秦皇岛': 'Qinhuangdao',
  '承德': 'Chengde',
  '天津': 'Tianjin',
  '沈阳': 'Shenyang',
  '大连': 'Dalian',
  '长春': 'Changchun',
  '海口': 'Haikou',
  '北海': 'Beihai',
  '南宁': 'Nanning',
  '西双版纳': 'Xishuangbanna',
  '腾冲': 'Tengchong',
  '乐山': 'Leshan Buddha',
  '峨眉山': 'Mount Emei',
  '都江堰': 'Dujiangyan',
};

// 关键词到搜索词的映射
const KEYWORD_SEARCH_MAP: Record<string, string[]> = {
  '雪山': ['snow mountain', 'snowy peak', 'glacier'],
  '海滩': ['beach', 'seaside', 'ocean coast'],
  '海边': ['beach', 'seaside', 'coastal'],
  '古镇': ['ancient town', 'old town', 'traditional village'],
  '古城': ['ancient city', 'old city wall', 'historic'],
  '草原': ['grassland', 'prairie', 'meadow'],
  '沙漠': ['desert', 'sand dunes', 'gobi'],
  '森林': ['forest', 'woods', 'nature'],
  '湖泊': ['lake', 'lakeside', 'water reflection'],
  '山水': ['landscape', 'mountain river', 'scenic'],
  '火锅': ['hotpot restaurant', 'Sichuan food', 'spicy cuisine'],
  '美食': ['food street', 'local cuisine', 'restaurant'],
  '米线': ['Yunnan cuisine', 'noodle', 'local food'],
  '小吃': ['street food', 'snack', 'local delicacy'],
  '温泉': ['hot spring', 'spa', 'thermal'],
  '滑雪': ['ski resort', 'skiing', 'winter sport'],
  '潜水': ['diving', 'underwater', 'coral reef'],
  '徒步': ['hiking', 'trekking', 'trail'],
  '寺庙': ['temple', 'buddhist', 'pagoda'],
  '少数民族': ['ethnic minority', 'traditional costume', 'tribal'],
  '文化': ['culture', 'heritage', 'traditional'],
  '夜景': ['night view', 'city lights', 'skyline night'],
  '日出': ['sunrise', 'dawn', 'morning glow'],
  '日落': ['sunset', 'dusk', 'golden hour'],
};

export class UnsplashClient extends BaseClient {
  constructor(config?: Partial<ClientConfig>) {
    const baseUrl = config?.baseUrl || 'https://api.unsplash.com';
    const apiKey = config?.apiKey || process.env.UNSPLASH_ACCESS_KEY || '';

    super({ baseUrl, apiKey, timeout: config?.timeout });

    this.client.defaults.headers.common['Authorization'] = `Client-ID ${this.apiKey}`;
  }

  async searchPhotos(query: string, count = 1, page = 1): Promise<string[]> {
    try {
      const response = await this.request<UnsplashSearchResponse>({
        method: 'GET',
        url: '/search/photos',
        params: {
          query,
          per_page: count,
          page,
          orientation: 'landscape',
        },
      });

      return response.results.map((photo) => photo.urls.regular);
    } catch (error) {
      console.warn(`Unsplash search failed for "${query}":`, error);
      return [];
    }
  }

  /**
   * 根据城市名和用户偏好搜索相关图片
   * @param cityName 城市名（中文）
   * @param keywords 用户偏好关键词（如雪山、火锅等）
   * @param hotSpots 热门景点
   */
  async getContextualCityPhoto(
    cityName: string,
    keywords: string[] = [],
    hotSpots: string[] = []
  ): Promise<string> {
    // 如果城市名在映射表中，使用映射的英文名；否则尝试提取可能的英文部分或使用通用搜索
    let englishCity = CITY_NAME_MAP[cityName];
    
    if (!englishCity) {
      // 对于未知城市，使用 "China city travel" 作为通用搜索词
      console.log(`City "${cityName}" not in mapping, using generic search`);
      englishCity = 'China city';
    }
    
    // 构建多个搜索查询，按优先级尝试
    const searchQueries: string[] = [];
    
    // 1. 结合城市和用户偏好关键词
    for (const keyword of keywords) {
      const searchTerms = KEYWORD_SEARCH_MAP[keyword];
      if (searchTerms) {
        // 随机选择一个搜索词增加多样性
        const randomTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];
        searchQueries.push(`${englishCity} ${randomTerm}`);
      }
    }
    
    // 2. 使用热门景点搜索
    if (hotSpots.length > 0) {
      // 随机选择一个景点
      const randomSpot = hotSpots[Math.floor(Math.random() * hotSpots.length)];
      searchQueries.push(`${randomSpot} China travel`);
    }
    
    // 3. 城市 + travel/landscape
    const suffixes = ['travel', 'landscape', 'scenery', 'tourism', 'landmark'];
    const randomSuffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    searchQueries.push(`${englishCity} ${randomSuffix}`);
    
    // 4. 纯城市名
    searchQueries.push(`${englishCity} China`);

    // 尝试每个查询，使用随机页码增加多样性
    for (const query of searchQueries) {
      // 随机选择前3页中的一页
      const randomPage = Math.floor(Math.random() * 3) + 1;
      const photos = await this.searchPhotos(query, 5, randomPage);
      
      if (photos.length > 0) {
        // 随机选择一张图片
        return photos[Math.floor(Math.random() * photos.length)];
      }
    }

    return '';
  }

  // 保留原方法以兼容
  async getCityPhoto(cityName: string): Promise<string> {
    return this.getContextualCityPhoto(cityName);
  }
}

// 延迟初始化
let _unsplashClient: UnsplashClient | null = null;
export const unsplashClient = new Proxy({} as UnsplashClient, {
  get(_target, prop) {
    if (!_unsplashClient) {
      _unsplashClient = new UnsplashClient();
    }
    const value = (_unsplashClient as any)[prop];
    if (typeof value === 'function') {
      return value.bind(_unsplashClient);
    }
    return value;
  }
});
