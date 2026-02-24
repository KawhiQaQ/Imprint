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

/**
 * 旅行角色标签 —— 决定景点在行程中扮演的角色
 * 
 * CORE_ATTRACTION:  来这座城市的理由，必去的核心景点（如西湖、故宫、兵马俑）
 * MAJOR_AREA:       可以逛 2-4 小时的区域（如古镇、老街、大型公园、景区）
 * NATURE_RELAX:     自然休闲（湖、绿道、滨江步道、湿地公园）
 * NIGHT_EXPERIENCE: 夜景/夜市/灯光秀/酒吧街
 * CULTURAL_SITE:    文化场馆（博物馆、美术馆、纪念馆）
 * VIEWPOINT:        打卡拍照点（观景台、地标建筑、雕塑）
 * SHOPPING_AREA:    商圈/步行街/市集
 * FILLER:           顺路看看的小景点（祠堂、小广场、街头雕塑、普通公园）
 */
export type TourismRole = 
  | 'CORE_ATTRACTION'
  | 'MAJOR_AREA'
  | 'NATURE_RELAX'
  | 'NIGHT_EXPERIENCE'
  | 'CULTURAL_SITE'
  | 'VIEWPOINT'
  | 'SHOPPING_AREA'
  | 'FILLER';

/**
 * 体验域标签 —— 比 category 更高层的语义抽象
 * 直接对应城市的体验需求
 */
export type ExperienceDomain =
  | 'NATURAL_LANDSCAPE'    // 山、湖、海、森林等自然风光
  | 'CULTURAL_LANDMARK'    // 文化地标（祖庙、故宫、钟楼）
  | 'HISTORIC_TOWN'        // 古镇/古城/老街
  | 'WATER_SCENERY'        // 水乡/江河/湖泊特色
  | 'URBAN_LIFE'           // 城市生活（商圈、步行街、夜市）
  | 'ENTERTAINMENT'        // 娱乐休闲（游乐园、演出）
  | 'RELIGIOUS_SITE'       // 宗教场所（寺庙、道观）
  | 'MUSEUM_ART'           // 博物馆/美术馆
  | 'PARK_GARDEN';         // 公园/园林

/**
 * 城市体验画像 —— 来这座城市"必须体验"和"可选体验"
 */
export interface CityProfile {
  city: string;
  mustHave: ExperienceDomain[];   // 必须覆盖的体验域
  optional: ExperienceDomain[];   // 可选的体验域
}

/**
 * 锚点 POI —— 在规划前就确定必须出现的景点
 */
export interface AnchorPOI {
  poi: EnrichedPOI;
  domain: ExperienceDomain;
  score: number;
  /** 锚点被分配到的天（在聚类后确定） */
  assignedDay?: number;
  /** 锚点占用的时间权重：1.0 = 整天（大景点如山），0.5 = 半天（中景点如祖庙） */
  timeWeight?: number;
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
  typecode?: string;
  category?: string;
  tourismRole?: TourismRole;
  experienceDomain?: ExperienceDomain;
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

    // 默认搜索连锁酒店品牌
    const chainBrands = ['如家', '全季', '亚朵', '汉庭', '维也纳', '锦江', '7天', '格林豪泰', '城市便捷', '桔子'];
    const defaultKeywords = preferences.keywords || chainBrands.slice(0, 5).join('|');

    // 先搜索连锁酒店
    const chainPois = await amapClient.searchHotels({
      city,
      keywords: defaultKeywords,
      types,
      minPrice,
      maxPrice,
      pageSize: 25,
    });

    // 再搜索一般酒店作为补充
    const generalPois = await amapClient.searchHotels({
      city,
      keywords: preferences.keywords || '酒店',
      types,
      minPrice,
      maxPrice,
      pageSize: 15,
    });

    // 合并去重，连锁酒店在前
    const seen = new Set<string>();
    const allPois: EnrichedPOI[] = [];
    for (const poi of [...chainPois, ...generalPois]) {
      const formatted = this.formatPOI(poi, 'hotel');
      if (!seen.has(formatted.name)) {
        seen.add(formatted.name);
        allPois.push(formatted);
      }
    }

    return allPois;
  }

  /**
   * 根据用户偏好搜索餐厅
   * @param city 城市
   * @param preferences 偏好设置
   * @param days 旅行天数，用于计算需要搜索的餐厅数量
   */
  async searchRestaurantsByPreference(
    city: string,
    preferences: {
      foodPreferences?: string[];
      budgetLevel?: string;
      keywords?: string;
    },
    days: number = 3
  ): Promise<EnrichedPOI[]> {
    const results: EnrichedPOI[] = [];

    // 根据天数计算需要的餐厅数量
    // 每天 3 顿饭，再多搜 50% 作为备选
    const mealsNeeded = days * 3;
    const targetCount = Math.ceil(mealsNeeded * 1.5);
    
    // 每种菜系搜索的数量，确保总数足够
    const cuisineCount = Math.min(8, Math.max(5, Math.ceil(days / 2) + 3));
    const perCuisineCount = Math.ceil(targetCount / cuisineCount);
    
    console.log(`[POIService] Searching restaurants for ${days} days: need ${mealsNeeded} meals, target ${targetCount}, ${cuisineCount} cuisines x ${perCuisineCount} each`);

    // 根据美食偏好搜索
    const defaultCuisines = ['美食', '餐厅', '特色菜', '小吃', '早餐', '夜宵', '茶餐厅', '地方菜'];
    const cuisines = preferences.foodPreferences?.length 
      ? [...preferences.foodPreferences, ...defaultCuisines.filter(c => !preferences.foodPreferences!.includes(c))]
      : defaultCuisines;
    
    for (const cuisine of cuisines.slice(0, cuisineCount)) {
      const pois = await amapClient.searchRestaurants({
        city,
        cuisine,
        keywords: preferences.keywords,
        pageSize: perCuisineCount,
      });

      results.push(...pois.map(poi => this.formatPOI(poi, 'restaurant')));
    }

    // 如果结果不够，补充搜索
    if (results.length < targetCount) {
      console.log(`[POIService] Only got ${results.length} restaurants, need more...`);
      const pois = await amapClient.searchPOI({
        city,
        types: POI_TYPES.RESTAURANT,
        pageSize: Math.min(50, targetCount - results.length + 20),
      });
      results.push(...pois.map(poi => this.formatPOI(poi, 'restaurant')));
    }

    // 如果还是严重不足（不到需求量的一半），尝试更多关键词
    if (results.length < Math.ceil(mealsNeeded / 2)) {
      console.log(`[POIService] Still critically low: ${results.length} restaurants. Trying broader search...`);
      const broadKeywords = ['饭店', '面馆', '粉店', '快餐', '烧烤', '火锅', '粥', '包子'];
      for (const kw of broadKeywords) {
        if (results.length >= targetCount) break;
        const pois = await amapClient.searchRestaurants({
          city,
          cuisine: kw,
          pageSize: 10,
        });
        results.push(...pois.map(poi => this.formatPOI(poi, 'restaurant')));
      }
    }

    // 去重
    const seen = new Set<string>();
    const uniqueResults = results.filter(poi => {
      if (seen.has(poi.name)) return false;
      seen.add(poi.name);
      return true;
    });
    
    console.log(`[POIService] Final restaurant count: ${uniqueResults.length} (target: ${targetCount})`);
    return uniqueResults;
  }

  /**
   * 多通道召回搜索景点（核心算法 v2）
   * 
   * 架构：多通道召回 → 配额采样 → 距离去偏 → 质量检查自修复 → 再规划
   * 
   * 核心理念：先保证池子结构正确，再让算法挑。
   * 召回要过量，排序才有意义。
   * 
   * 五个召回通道：
   * 1. 自然景观专用召回（NATURAL）—— 最重要，扩大半径+多页抓取
   * 2. 城市地标召回（LANDMARK）—— 解决高德相关性偏城市中心问题
   * 3. 用户兴趣召回（USER）—— 补充来源，不是主来源
   * 4. 类别枚举召回（TYPECODE）—— 按 typecode 定向扫，防漏
   * 5. 周边扩展召回（AROUND）—— 基于城市中心 50km 半径搜索
   */
  async searchAttractionsByPreference(
    city: string,
    preferences: {
      activityTypes?: string[];
      keywords?: string;
    },
    days: number = 3
  ): Promise<EnrichedPOI[]> {
    const seen = new Set<string>(); // 全局去重

    // 各通道独立收集（不再直接合并）
    const channelResults: Map<string, EnrichedPOI[]> = new Map();

    // 名称归一化：去掉常见子区域后缀，用于检测同一景点的不同入口/分区
    const normalizeAttractionName = (name: string): string => {
      return name.replace(/[\(（].*[\)）]|[A-Za-z]区$|[东南西北]区$|[东南西北]门$|分[馆店]$|[一二三四五六七八九十\d]+号?[门口入]$/g, '').trim();
    };

    // 检查候选名称是否与已有名称过于相似（互相包含 或 归一化后相同）
    const isSimilarToExisting = (name: string): boolean => {
      const normalized = normalizeAttractionName(name);
      for (const existing of seen) {
        if (name.includes(existing) || existing.includes(name)) return true;
        if (normalized === normalizeAttractionName(existing)) return true;
      }
      return false;
    };

    const collectToChannel = (pois: AmapPOI[], channel: string) => {
      if (!channelResults.has(channel)) channelResults.set(channel, []);
      const list = channelResults.get(channel)!;
      let added = 0;
      for (const poi of pois) {
        if (seen.has(poi.name)) continue;
        // 名称相似性去重：防止"广州塔"和"广州塔E区"同时进入候选池
        if (isSimilarToExisting(poi.name)) continue;
        seen.add(poi.name);
        list.push(this.formatPOI(poi, 'attraction'));
        added++;
      }
      if (added > 0) {
        console.log(`[POIService] ${channel}: +${added} POIs (channel total: ${list.length})`);
      }
    };

    console.log(`[POIService] Multi-channel recall v2 for ${city}, ${days} days`);

    // ========== Channel 1: 自然景观专用召回（最重要） ==========
    // 固定字典，不依赖用户输入。目的不是精准，是确保城市的大景点一定进入候选池。
    const naturalKeywords = [
      '山', '国家森林公园', '风景区', '景区', '自然保护区',
      '湖', '湿地', '瀑布', '绿道', '海岸',
      '峡谷', '地质公园', '自然风景', '国家公园',
    ];

    console.log(`[POIService] Channel 1: NATURAL recall (${naturalKeywords.length} keywords, multi-page)`);
    const naturalPromises = naturalKeywords.map(async (kw) => {
      const results: AmapPOI[] = [];
      // 多页抓取（最多 3 页），召回要过量
      for (let page = 1; page <= 3; page++) {
        const pois = await amapClient.searchPOI({
          city,
          keywords: kw,
          types: POI_TYPES.SCENIC,
          page,
          pageSize: 25,
          sortRule: 'weight', // 按权重排序，不按距离，避免只拿到城市中心的
        });
        results.push(...pois);
        if (pois.length < 25) break;
      }
      return { kw, results };
    });

    const naturalResults = await Promise.all(naturalPromises);
    for (const { results } of naturalResults) {
      if (results.length > 0) {
        collectToChannel(results, 'NATURAL');
      }
    }

    // ========== Channel 2: 城市地标召回 ==========
    // 很多著名景点不叫"风景名胜"（如广州塔、西樵山、千灯湖）
    // 策略：city + 多种后缀，解决"高德相关性偏城市中心"的关键
    const landmarkSuffixes = ['景区', '公园', '山', '湖', '古镇', '老街', '名胜', '风景', '地标', '塔'];

    console.log(`[POIService] Channel 2: LANDMARK recall (${landmarkSuffixes.length} queries)`);
    const landmarkPromises = landmarkSuffixes.map(async (suffix) => {
      const results: AmapPOI[] = [];
      // 每个后缀也抓 2 页
      for (let page = 1; page <= 2; page++) {
        const pois = await amapClient.searchPOI({
          city,
          keywords: `${city}${suffix}`,
          types: POI_TYPES.SCENIC,
          page,
          pageSize: 25,
        });
        results.push(...pois);
        if (pois.length < 25) break;
      }
      return { suffix, results };
    });

    const landmarkResults = await Promise.all(landmarkPromises);
    for (const { results } of landmarkResults) {
      if (results.length > 0) {
        collectToChannel(results, 'LANDMARK');
      }
    }

    // ========== Channel 3: 用户兴趣召回（补充来源，不是主来源） ==========
    const activities = preferences.activityTypes || ['观光'];
    console.log(`[POIService] Channel 3: USER recall (${activities.length} activities)`);

    const userPromises = activities.slice(0, 5).map(async (activity) => {
      const pois = await amapClient.searchAttractions({
        city,
        keywords: activity,
        pageSize: 25,
      });
      return pois;
    });
    const userResults = await Promise.all(userPromises);
    for (const pois of userResults) {
      collectToChannel(pois, 'USER');
    }

    // ========== Channel 4: 类别枚举召回（防漏召回） ==========
    // 直接用 typecode 定向抓，不要关键词，直接扫类型
    const typecodeChannels: Array<{ code: string; label: string }> = [
      { code: '110202', label: '山岳' },
      { code: '110203', label: '湖泊' },
      { code: '110204', label: '森林' },
      { code: '110205', label: '海滨' },
      { code: '110302', label: '古镇' },
      { code: '110101', label: '公园广场' },
      { code: '110200', label: '风景名胜' },
      { code: '110100', label: '5A景区' },
      { code: '110301', label: '文物古迹' },
    ];

    console.log(`[POIService] Channel 4: TYPECODE recall (${typecodeChannels.length} types)`);
    const typecodePromises = typecodeChannels.map(async ({ code, label }) => {
      const results: AmapPOI[] = [];
      for (let page = 1; page <= 2; page++) {
        const pois = await amapClient.searchPOI({
          city,
          types: code,
          page,
          pageSize: 25,
        });
        results.push(...pois);
        if (pois.length < 25) break;
      }
      return { label, results };
    });

    const typecodeResults = await Promise.all(typecodePromises);
    for (const { results } of typecodeResults) {
      if (results.length > 0) {
        collectToChannel(results, 'TYPECODE');
      }
    }

    // ========== Channel 5: 周边扩展召回（50km 半径） ==========
    // 用城市中心坐标做 searchAround，确保郊区大景点不被遗漏
    const allSoFar = Array.from(channelResults.values()).flat();
    const cityCenter = this.estimateCityCenter(allSoFar);

    if (cityCenter) {
      console.log(`[POIService] Channel 5: AROUND recall (50km radius from ${cityCenter})`);
      const aroundKeywords = ['风景区', '山', '森林公园', '景区', '湖'];
      const aroundPromises = aroundKeywords.map(async (kw) => {
        const pois = await amapClient.searchAround(cityCenter, 50000, {
          keywords: kw,
          types: POI_TYPES.SCENIC,
          pageSize: 25,
          sortRule: 'weight', // 按权重不按距离
        });
        return pois;
      });
      const aroundResults = await Promise.all(aroundPromises);
      for (const pois of aroundResults) {
        collectToChannel(pois, 'AROUND');
      }
    }

    // ========== 通用兜底 ==========
    const totalRaw = Array.from(channelResults.values()).reduce((s, l) => s + l.length, 0);
    if (totalRaw === 0) {
      console.warn(`[POIService] All channels returned 0 results, trying generic fallback`);
      const [scenic, parks, museums] = await Promise.all([
        amapClient.searchPOI({ city, types: POI_TYPES.SCENIC, pageSize: 30 }),
        amapClient.searchPOI({ city, types: POI_TYPES.PARK, pageSize: 15 }),
        amapClient.searchPOI({ city, types: POI_TYPES.MUSEUM, pageSize: 15 }),
      ]);
      collectToChannel(scenic, 'FALLBACK');
      collectToChannel(parks, 'FALLBACK');
      collectToChannel(museums, 'FALLBACK');
    }

    // 打印各通道召回量
    for (const [ch, list] of channelResults) {
      console.log(`[POIService] Channel "${ch}": ${list.length} POIs`);
    }
    console.log(`[POIService] Total raw recall: ${totalRaw} POIs`);

    // ========== Step 2: 配额采样 —— 各通道先各自保留TopN，再按比例混合 ==========
    const quotaSampled = this.quotaSample(channelResults);
    console.log(`[POIService] After quota sampling: ${quotaSampled.length} POIs`);

    // ========== Step 3: 距离去偏（Geo Debias）—— 打破城市中心密度偏置 ==========
    const geoDebiased = this.geoDebias(quotaSampled, city);
    console.log(`[POIService] After geo debias: ${geoDebiased.length} POIs`);

    // 过滤低质量景点
    const filteredResults = this.filterLowQualityAttractions(geoDebiased);
    console.log(`[POIService] After quality filter: ${geoDebiased.length} -> ${filteredResults.length}`);

    // 用 LLM 分类旅行角色和体验域
    await this.classifyTourismRoles(filteredResults, city);
    await this.classifyExperienceDomains(filteredResults, city);

    // ========== Step 4: 候选池质量检查 + 自修复 ==========
    const repaired = await this.qualityCheckAndRepair(filteredResults, city, seen);

    return repaired;
  }


  /**
   * 用 LLM 批量分类景点的旅行角色
   * 
   * 角色定义：
   * - CORE_ATTRACTION: 城市名片级景点，来这座城市的理由
   * - MAJOR_AREA: 可以逛 2-4 小时的大型区域
   * - NATURE_RELAX: 自然休闲类（湖、山、绿道、湿地）
   * - NIGHT_EXPERIENCE: 夜间体验（夜市、灯光秀、夜景）
   * - CULTURAL_SITE: 文化场馆（博物馆、美术馆、纪念馆）
   * - VIEWPOINT: 打卡拍照点
   * - SHOPPING_AREA: 商圈/步行街
   * - FILLER: 顺路看看的小景点
   */
  async classifyTourismRoles(pois: EnrichedPOI[], city: string): Promise<void> {
    if (pois.length === 0) return;
    
    // 先用规则做一轮快速预分类（减少 LLM 负担，也作为 fallback）
    for (const poi of pois) {
      poi.tourismRole = this.inferRoleByRules(poi);
    }
    
    // 用 LLM 精确分类
    const poiList = pois.map((p, i) => 
      `${i + 1}. ${p.name}（${p.category || '未知类型'}，${p.address}${p.rating ? `，评分${p.rating}` : ''}）`
    ).join('\n');
    
    const VALID_ROLES = [
      'CORE_ATTRACTION', 'MAJOR_AREA', 'NATURE_RELAX', 'NIGHT_EXPERIENCE',
      'CULTURAL_SITE', 'VIEWPOINT', 'SHOPPING_AREA', 'FILLER'
    ];
    
    const prompt = `你是一个资深旅行规划师。请为${city}的以下景点分配"旅行角色"。

角色说明：
- CORE_ATTRACTION: 城市名片，游客必去的核心景点（如西湖、故宫、外滩）。一个城市通常只有3-5个。
- MAJOR_AREA: 可以花2-4小时游览的大型区域（如古镇、大型景区、著名园林、国家级公园）
- NATURE_RELAX: 自然休闲（山、湖、江边绿道、湿地公园、森林公园）
- NIGHT_EXPERIENCE: 适合晚上去的（夜市、酒吧街、灯光秀、江边夜景）
- CULTURAL_SITE: 文化场馆（博物馆、美术馆、纪念馆、展览馆）
- VIEWPOINT: 打卡拍照点（观景台、地标建筑、著名桥梁、雕塑）
- SHOPPING_AREA: 购物/商业街（步行街、市集、特产街）
- FILLER: 小景点，顺路看看就好（小祠堂、街心花园、普通广场、小型纪念碑）

判断标准：
1. 知名度和规模是最重要的因素。全国知名 > 省级知名 > 本地知名
2. 大学一般是 FILLER（除非是清华北大厦大武大这种本身就是旅游景点的）
3. 普通城市公园是 FILLER，但大型国家级公园/森林公园是 NATURE_RELAX 或 MAJOR_AREA
4. 宗祠、小庙、街头雕塑一般是 FILLER
5. 5A/4A 景区通常是 CORE_ATTRACTION 或 MAJOR_AREA

景点列表：
${poiList}

请返回JSON数组，格式：[{"index": 1, "role": "CORE_ATTRACTION"}, ...]
只返回JSON，不要其他内容。`;

    try {
      const result = await deepseekClient.chatWithJson<Array<{ index: number; role: string }>>([
        { role: 'system', content: '你是旅行规划专家。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);
      
      let classified = 0;
      for (const item of result) {
        const idx = item.index - 1;
        if (idx >= 0 && idx < pois.length && VALID_ROLES.includes(item.role)) {
          pois[idx].tourismRole = item.role as TourismRole;
          classified++;
        }
      }
      
      // 统计角色分布
      const roleDist: Record<string, number> = {};
      for (const poi of pois) {
        const role = poi.tourismRole || 'UNKNOWN';
        roleDist[role] = (roleDist[role] || 0) + 1;
      }
      console.log(`[POIService] Tourism role classification: ${classified}/${pois.length} classified by LLM`);
      console.log(`[POIService] Role distribution:`, roleDist);
      
    } catch (error) {
      console.warn('[POIService] LLM role classification failed, using rule-based fallback:', error);
      // 规则预分类已经在前面做了，这里不需要额外处理
    }
  }

  /**
   * Step 2: 用 LLM 批量分类景点的体验域标签
   * 体验域比 category 更抽象，直接对应城市体验需求
   */
  async classifyExperienceDomains(pois: EnrichedPOI[], city: string): Promise<void> {
    if (pois.length === 0) return;
    
    // 先用规则预分类
    for (const poi of pois) {
      poi.experienceDomain = this.inferDomainByRules(poi);
    }
    
    const poiList = pois.map((p, i) => 
      `${i + 1}. ${p.name}（${p.category || '未知'}，${p.tourismRole || 'FILLER'}）`
    ).join('\n');
    
    const VALID_DOMAINS = [
      'NATURAL_LANDSCAPE', 'CULTURAL_LANDMARK', 'HISTORIC_TOWN', 'WATER_SCENERY',
      'URBAN_LIFE', 'ENTERTAINMENT', 'RELIGIOUS_SITE', 'MUSEUM_ART', 'PARK_GARDEN'
    ];
    
    const prompt = `为${city}的以下景点分配"体验域"标签。

体验域说明：
- NATURAL_LANDSCAPE: 自然风光（山、峰、峡谷、森林、瀑布、地质公园）
- CULTURAL_LANDMARK: 文化地标（城市标志性建筑、著名祠堂、历史遗迹）
- HISTORIC_TOWN: 古镇/古城/老街/历史街区
- WATER_SCENERY: 水景特色（湖泊、江河、水乡、海滨、温泉）
- URBAN_LIFE: 城市生活（商圈、步行街、夜市、美食街）
- ENTERTAINMENT: 娱乐休闲（游乐园、主题公园、演出场所）
- RELIGIOUS_SITE: 宗教场所（寺庙、道观、教堂）
- MUSEUM_ART: 文化场馆（博物馆、美术馆、纪念馆）
- PARK_GARDEN: 公园/园林（城市公园、植物园、动物园、园林）

景点列表：
${poiList}

返回JSON数组：[{"index": 1, "domain": "NATURAL_LANDSCAPE"}, ...]
只返回JSON。`;

    try {
      const result = await deepseekClient.chatWithJson<Array<{ index: number; domain: string }>>([
        { role: 'system', content: '你是旅行分类专家。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);
      
      let classified = 0;
      for (const item of result) {
        const idx = item.index - 1;
        if (idx >= 0 && idx < pois.length && VALID_DOMAINS.includes(item.domain)) {
          pois[idx].experienceDomain = item.domain as ExperienceDomain;
          classified++;
        }
      }
      
      const domainDist: Record<string, number> = {};
      for (const poi of pois) {
        const d = poi.experienceDomain || 'UNKNOWN';
        domainDist[d] = (domainDist[d] || 0) + 1;
      }
      console.log(`[POIService] Experience domain classification: ${classified}/${pois.length}`);
      console.log(`[POIService] Domain distribution:`, domainDist);
    } catch (error) {
      console.warn('[POIService] LLM domain classification failed, using rules:', error);
    }
  }

  /**
   * 规则推断体验域（LLM fallback）
   */
  private inferDomainByRules(poi: EnrichedPOI): ExperienceDomain {
    const cat = poi.category || 'other';
    
    if (['mountain', 'forest', 'scenic_area'].includes(cat)) return 'NATURAL_LANDSCAPE';
    if (['lake', 'river', 'sea'].includes(cat)) return 'WATER_SCENERY';
    if (cat === 'ancient_town') return 'HISTORIC_TOWN';
    if (cat === 'temple') return 'RELIGIOUS_SITE';
    if (['museum', 'art_gallery', 'memorial'].includes(cat)) return 'MUSEUM_ART';
    if (['garden', 'park', 'botanical', 'zoo'].includes(cat)) return 'PARK_GARDEN';
    if (['commercial_street', 'plaza'].includes(cat)) return 'URBAN_LIFE';
    if (cat === 'historic_building') return 'CULTURAL_LANDMARK';
    
    return 'URBAN_LIFE';
  }

  /**
   * Step 1: 生成城市体验画像
   */
  async generateCityProfile(city: string): Promise<CityProfile> {
    const prompt = `分析${city}这座城市，确定游客"必须体验"和"可选体验"的类型。

体验域选项：
- NATURAL_LANDSCAPE: 自然风光（山水、森林、地质奇观）
- CULTURAL_LANDMARK: 文化地标（标志性历史建筑、遗迹）
- HISTORIC_TOWN: 古镇/古城/老街
- WATER_SCENERY: 水景（湖泊、江河、水乡、海滨）
- URBAN_LIFE: 城市生活（商圈、夜市、美食街）
- ENTERTAINMENT: 娱乐休闲
- RELIGIOUS_SITE: 宗教场所
- MUSEUM_ART: 博物馆/美术馆
- PARK_GARDEN: 公园/园林

判断标准：
- must_have: 来这座城市不体验就白来了的（通常2-4个）
- optional: 有时间可以体验的

例如：
- 佛山: must_have=[CULTURAL_LANDMARK, NATURAL_LANDSCAPE, HISTORIC_TOWN], optional=[URBAN_LIFE, PARK_GARDEN]
- 杭州: must_have=[WATER_SCENERY, NATURAL_LANDSCAPE, CULTURAL_LANDMARK], optional=[HISTORIC_TOWN, MUSEUM_ART]
- 北京: must_have=[CULTURAL_LANDMARK, HISTORIC_TOWN, MUSEUM_ART], optional=[NATURAL_LANDSCAPE, URBAN_LIFE]

返回JSON：{"must_have": ["NATURAL_LANDSCAPE", ...], "optional": ["URBAN_LIFE", ...]}
只返回JSON。`;

    try {
      const result = await deepseekClient.chatWithJson<{ must_have: string[]; optional: string[] }>([
        { role: 'system', content: '你是中国旅行专家。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);
      
      const VALID_DOMAINS = [
        'NATURAL_LANDSCAPE', 'CULTURAL_LANDMARK', 'HISTORIC_TOWN', 'WATER_SCENERY',
        'URBAN_LIFE', 'ENTERTAINMENT', 'RELIGIOUS_SITE', 'MUSEUM_ART', 'PARK_GARDEN'
      ];
      
      const profile: CityProfile = {
        city,
        mustHave: (result.must_have || []).filter(d => VALID_DOMAINS.includes(d)) as ExperienceDomain[],
        optional: (result.optional || []).filter(d => VALID_DOMAINS.includes(d)) as ExperienceDomain[],
      };
      
      // 确保至少有一个 must_have
      if (profile.mustHave.length === 0) {
        profile.mustHave = ['CULTURAL_LANDMARK', 'NATURAL_LANDSCAPE'];
      }
      
      console.log(`[POIService] City profile for ${city}:`, profile);
      return profile;
    } catch (error) {
      console.warn(`[POIService] Failed to generate city profile for ${city}:`, error);
      return {
        city,
        mustHave: ['CULTURAL_LANDMARK', 'NATURAL_LANDSCAPE'],
        optional: ['URBAN_LIFE', 'PARK_GARDEN'],
      };
    }
  }
  
  /**
   * 基于规则的快速角色预分类（作为 LLM 的 fallback）
   */
  private inferRoleByRules(poi: EnrichedPOI): TourismRole {
    const name = poi.name;
    const cat = poi.category || 'other';
    
    // 自然景观大类 → NATURE_RELAX
    if (['mountain', 'lake', 'river', 'sea', 'forest'].includes(cat)) {
      // 知名大型自然景区可能是 CORE，但规则难判断，交给 LLM
      return 'NATURE_RELAX';
    }
    
    // 景区类
    if (cat === 'scenic_area') {
      if (/5A|4A|国家级|世界遗产/.test(name)) return 'CORE_ATTRACTION';
      return 'MAJOR_AREA';
    }
    
    // 古镇/古城
    if (cat === 'ancient_town') return 'MAJOR_AREA';
    
    // 博物馆/美术馆
    if (cat === 'museum') return 'CULTURAL_SITE';
    if (cat === 'art_gallery') return 'CULTURAL_SITE';
    
    // 园林
    if (cat === 'garden') return 'MAJOR_AREA';
    
    // 历史建筑
    if (cat === 'historic_building') {
      // 大型历史建筑群可能是 MAJOR_AREA，小的是 VIEWPOINT
      if (/故宫|城墙|古城|府邸/.test(name)) return 'MAJOR_AREA';
      return 'VIEWPOINT';
    }
    
    // 寺庙
    if (cat === 'temple') {
      if (/少林|灵隐|普陀|九华|峨眉/.test(name)) return 'CORE_ATTRACTION';
      return 'VIEWPOINT';
    }
    
    // 公园
    if (['park', 'botanical', 'zoo'].includes(cat)) {
      if (/国家|森林|地质|湿地/.test(name)) return 'NATURE_RELAX';
      if (/动物园|海洋|植物园/.test(name)) return 'MAJOR_AREA';
      return 'FILLER';
    }
    
    // 商业街
    if (cat === 'commercial_street') return 'SHOPPING_AREA';
    
    // 广场
    if (cat === 'plaza') return 'FILLER';
    
    // 大学
    if (cat === 'university') return 'FILLER';
    
    // 宗祠
    if (cat === 'ancestral_hall') return 'FILLER';
    
    // 纪念类
    if (cat === 'memorial') return 'CULTURAL_SITE';
    
    // 默认
    return 'FILLER';
  }

  /**
   * 过滤低质量景点
   * 移除社区、祠堂、停车场等不适合旅游的地点
   */
  /**
   * 配额采样：各通道先各自保留TopN，再按比例混合
   * 
   * 关键：不要直接合并所有结果，否则大景点仍然被淹没。
   * 各通道先各自保留配额内的 TopN，再按比例混合。
   * 这是召回配额，不是最终行程配额。
   */
  private quotaSample(channelResults: Map<string, EnrichedPOI[]>): EnrichedPOI[] {
    // 各通道的配额（最少保留数量）
    const channelQuotas: Record<string, number> = {
      NATURAL: 25,   // 自然景观：最重要，保底 25
      LANDMARK: 25,  // 文化地标：保底 25
      AROUND: 20,    // 周边扩展：保底 20（郊区大景点）
      TYPECODE: 20,  // 类别枚举：保底 20
      USER: 20,      // 用户兴趣：保底 20
      FALLBACK: 30,  // 兜底：保底 30
    };

    const result: EnrichedPOI[] = [];
    const usedNames = new Set<string>();

    // 第一轮：每个通道按配额取 TopN
    // 排序策略：有评分的优先，评分高的优先，有 typecode 的优先（说明是正规景点）
    for (const [channel, pois] of channelResults) {
      const quota = channelQuotas[channel] || 15;
      const sorted = [...pois].sort((a, b) => {
        // 有评分的排前面
        const hasRatingA = a.rating ? 1 : 0;
        const hasRatingB = b.rating ? 1 : 0;
        if (hasRatingA !== hasRatingB) return hasRatingB - hasRatingA;
        // 评分高的排前面
        const ra = a.rating || 0;
        const rb = b.rating || 0;
        if (ra !== rb) return rb - ra;
        // 有 typecode 的排前面（说明是正规景点分类）
        const hasTypeA = a.typecode ? 1 : 0;
        const hasTypeB = b.typecode ? 1 : 0;
        return hasTypeB - hasTypeA;
      });

      let taken = 0;
      for (const poi of sorted) {
        if (taken >= quota) break;
        if (usedNames.has(poi.name)) continue;
        usedNames.add(poi.name);
        result.push(poi);
        taken++;
      }
      console.log(`[POIService] Quota sample "${channel}": ${taken}/${pois.length} (quota=${quota})`);
    }

    // 第二轮：剩余的 POI 按评分补充进来（不超过总量 250）
    // 提高上限到 250，因为多了 AROUND 通道
    const MAX_TOTAL = 250;
    if (result.length < MAX_TOTAL) {
      // 收集所有剩余 POI，按评分排序后补充
      const remaining: EnrichedPOI[] = [];
      for (const [, pois] of channelResults) {
        for (const poi of pois) {
          if (!usedNames.has(poi.name)) {
            remaining.push(poi);
          }
        }
      }
      remaining.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      for (const poi of remaining) {
        if (result.length >= MAX_TOTAL) break;
        if (usedNames.has(poi.name)) continue;
        usedNames.add(poi.name);
        result.push(poi);
      }
    }

    return result;
  }

  /**
   * 距离去偏（Geo Debias）：打破城市中心密度偏置
   * 
   * 城市 POI 有中心密度偏置，必须打破。
   * 按距城市中心分桶，每桶有保底数量和上限，
   * 确保郊区的大景点（如山）不会被市中心的小景点淹没。
   */
  private geoDebias(pois: EnrichedPOI[], city: string): EnrichedPOI[] {
    const withLocation = pois.filter(p => p.location);
    if (withLocation.length === 0) return pois;

    // 计算所有 POI 的地理中心作为"城市中心"近似
    let sumLng = 0, sumLat = 0;
    for (const poi of withLocation) {
      const [lng, lat] = poi.location!.split(',').map(Number);
      sumLng += lng;
      sumLat += lat;
    }
    const centerLng = sumLng / withLocation.length;
    const centerLat = sumLat / withLocation.length;
    const centerLocation = `${centerLng},${centerLat}`;

    // 分桶：0-5km, 5-15km, 15-40km, 40km+
    // minKeep = 每桶保底数量（确保远距离桶有代表）
    // maxKeep = 每桶上限（防止近距离桶过度占据名额）
    interface GeoBucket {
      label: string;
      maxDist: number;
      minKeep: number;
      maxKeep: number;
      pois: EnrichedPOI[];
    }

    const buckets: GeoBucket[] = [
      { label: '0-5km', maxDist: 5, minKeep: 10, maxKeep: 60, pois: [] },
      { label: '5-15km', maxDist: 15, minKeep: 8, maxKeep: 50, pois: [] },
      { label: '15-40km', maxDist: 40, minKeep: 6, maxKeep: 40, pois: [] },
      { label: '40km+', maxDist: Infinity, minKeep: 4, maxKeep: 30, pois: [] },
    ];

    const noLocation: EnrichedPOI[] = [];

    for (const poi of pois) {
      if (!poi.location) {
        noLocation.push(poi);
        continue;
      }
      const dist = amapClient.calculateDistance(centerLocation, poi.location);
      const bucket = buckets.find(b => dist <= b.maxDist);
      if (bucket) {
        bucket.pois.push(poi);
      }
    }

    // 打印分桶情况
    for (const b of buckets) {
      console.log(`[POIService] GeoBucket "${b.label}": ${b.pois.length} POIs (min=${b.minKeep}, max=${b.maxKeep})`);
    }

    // 合并：每桶按评分排序，取 min(实际数量, maxKeep) 个，但至少 minKeep 个
    const result: EnrichedPOI[] = [];
    const usedNames = new Set<string>();

    for (const bucket of buckets) {
      // 按评分排序
      const sorted = bucket.pois.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      // 实际取的数量：不超过 maxKeep，但如果不够 minKeep 就全取
      const limit = Math.min(sorted.length, bucket.maxKeep);
      let taken = 0;
      for (const poi of sorted) {
        if (taken >= limit) break;
        if (usedNames.has(poi.name)) continue;
        usedNames.add(poi.name);
        result.push(poi);
        taken++;
      }
      console.log(`[POIService] GeoBucket "${bucket.label}": took ${taken}/${bucket.pois.length}`);
    }

    // 如果远距离桶不够 minKeep，从近距离桶的剩余中补充高评分的
    // （这种情况说明城市确实没有远郊景点，不强求）

    // 加回没有坐标的
    for (const poi of noLocation) {
      if (!usedNames.has(poi.name)) {
        usedNames.add(poi.name);
        result.push(poi);
      }
    }

    return result;
  }

  /**
   * 候选池质量检查 + 自修复
   * 
   * 检查关键体验域是否有足够的高质量候选。
   * 如果缺失，触发扩展召回：更大半径 + 更多关键词 + 翻页 + searchAround。
   * 让系统自我修复。
   */
  private async qualityCheckAndRepair(
    pois: EnrichedPOI[],
    city: string,
    seen: Set<string>
  ): Promise<EnrichedPOI[]> {
    // 关键域：必须有至少 1 个高质量候选
    const criticalDomains: Array<{ domain: ExperienceDomain; keywords: string[]; aroundKeywords: string[] }> = [
      { 
        domain: 'NATURAL_LANDSCAPE', 
        keywords: ['山', '风景名胜区', '国家级景区', '森林公园', '地质公园', '自然风景区', '峡谷', '瀑布'],
        aroundKeywords: ['山', '风景区', '森林公园', '自然保护区'],
      },
      { 
        domain: 'CULTURAL_LANDMARK', 
        keywords: ['文化遗产', '历史古迹', '名胜古迹', '文物保护', '古建筑', '历史文化'],
        aroundKeywords: ['古迹', '文化遗产', '历史'],
      },
      {
        domain: 'WATER_SCENERY',
        keywords: ['湖', '江', '河', '海滨', '水库', '温泉', '瀑布'],
        aroundKeywords: ['湖', '江', '海'],
      },
      {
        domain: 'HISTORIC_TOWN',
        keywords: ['古镇', '古城', '古村', '老街', '历史街区'],
        aroundKeywords: ['古镇', '古村', '老街'],
      },
    ];

    const QUALITY_THRESHOLD = 3.5; // rating >= 3.5 算高质量
    let repaired = [...pois];

    for (const { domain, keywords, aroundKeywords } of criticalDomains) {
      // 检查该域是否有高质量候选
      const domainPOIs = repaired.filter(p => p.experienceDomain === domain);
      const highQuality = domainPOIs.filter(p => (p.rating || 0) >= QUALITY_THRESHOLD);

      if (highQuality.length >= 1) {
        console.log(`[POIService] QualityCheck: ${domain} OK (${highQuality.length} high-quality POIs)`);
        continue;
      }

      console.warn(`[POIService] QualityCheck: ${domain} MISSING! Triggering repair recall...`);

      const addRepairPOI = (poi: AmapPOI) => {
        if (seen.has(poi.name)) return false;
        seen.add(poi.name);
        const enriched = this.formatPOI(poi, 'attraction');
        enriched.experienceDomain = this.inferDomainByRules(enriched);
        enriched.tourismRole = this.inferRoleByRules(enriched);
        repaired.push(enriched);
        return true;
      };

      // 修复策略 1：关键词 + 多页搜索
      for (const kw of keywords) {
        for (let page = 1; page <= 3; page++) {
          const results = await amapClient.searchPOI({
            city,
            keywords: kw,
            types: POI_TYPES.SCENIC,
            page,
            pageSize: 25,
          });

          let added = 0;
          for (const poi of results) {
            if (addRepairPOI(poi)) added++;
          }

          if (added > 0) {
            console.log(`[POIService] Repair[${domain}][${kw}] page ${page}: +${added} POIs`);
          }
          if (results.length < 25) break;
        }
      }

      // 修复策略 2：searchAround 扩大半径（50km）
      const cityCenter = this.estimateCityCenter(repaired);
      if (cityCenter) {
        for (const kw of aroundKeywords) {
          const results = await amapClient.searchAround(cityCenter, 50000, {
            keywords: kw,
            types: POI_TYPES.SCENIC,
            pageSize: 25,
            sortRule: 'weight',
          });

          let added = 0;
          for (const poi of results) {
            if (addRepairPOI(poi)) added++;
          }
          if (added > 0) {
            console.log(`[POIService] Repair[${domain}][AROUND:${kw}]: +${added} POIs`);
          }
        }
      }

      // 再次检查
      const afterRepair = repaired.filter(p => p.experienceDomain === domain);
      console.log(`[POIService] After repair: ${domain} has ${afterRepair.length} POIs (was ${domainPOIs.length})`);
    }

    return repaired;
  }

  /**
   * 从已有 POI 列表估算城市中心坐标
   * 用于 searchAround 的中心点
   */
  private estimateCityCenter(pois: EnrichedPOI[]): string | null {
    const withLocation = pois.filter(p => p.location);
    if (withLocation.length === 0) return null;

    let sumLng = 0, sumLat = 0;
    for (const poi of withLocation) {
      const [lng, lat] = poi.location!.split(',').map(Number);
      sumLng += lng;
      sumLat += lat;
    }
    return `${sumLng / withLocation.length},${sumLat / withLocation.length}`;
  }

  private filterLowQualityAttractions(pois: EnrichedPOI[]): EnrichedPOI[] {
    // 低质量景点关键词（直接过滤）
    const excludeKeywords = [
      // 行政/公共设施
      '社区', '居委会', '村委会', '街道办', '派出所', '公安局', '交警',
      '政府', '办事处', '服务中心', '便民',
      // 殡葬相关
      '墓地', '陵园', '殡仪', '公墓', '骨灰',
      // 交通设施
      '停车场', '加油站', '收费站', '服务区', '汽车站', '客运站',
      // 工商业
      '工厂', '厂房', '仓库', '物流', '批发', '市场',
      // 医疗
      '医院', '诊所', '卫生院', '药店', '药房',
      // 金融
      '银行', '保险', '证券', 'ATM',
      // 教育（除非是著名学府）
      '幼儿园', '小学', '中学', '培训', '驾校',
      // 商业
      '超市', '便利店', '菜市场', '商场', '购物中心',
      // 住宅
      '小区', '花园', '家园', '公寓', '住宅',
    ];
    
    // 低质量但可以保留的关键词（降低优先级，但不完全过滤）
    // 这些在 itineraryPipeline 的评分中处理
    
    return pois.filter(poi => {
      const name = poi.name;
      
      // 检查是否包含排除关键词
      if (excludeKeywords.some(kw => name.includes(kw))) {
        console.log(`[POIService] Filtered out: ${name}`);
        return false;
      }
      
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
      location: poi.location,
      amapId: poi.id,
      typecode: poi.typecode,
      category: type === 'attraction' ? this.inferCategory(poi.name, poi.typecode, poi.type) : undefined,
    };
  }

  /**
   * 根据名称和高德类型推断景点类别，用于多样性控制
   */
  private inferCategory(name: string, typecode?: string, amapType?: string): string {
    const text = `${name}|${amapType || ''}`;

    // 自然景观
    if (/山|峰|岭|崖|谷|峡|洞|溶洞/.test(text)) return 'mountain';
    if (/湖|潭|池|泉|温泉/.test(text)) return 'lake';
    if (/江|河|溪|瀑布|漂流/.test(text)) return 'river';
    if (/海|湾|岛|礁|沙滩|海滩/.test(text)) return 'sea';
    if (/森林|林场|湿地|草原|草地/.test(text)) return 'forest';

    // 历史人文
    if (/古镇|古村|古城|老街|古街/.test(text)) return 'ancient_town';
    if (/寺|庙|观|庵|道观|禅/.test(text)) return 'temple';
    if (/塔|阁|楼|城墙|城门|故居|府邸/.test(text)) return 'historic_building';
    if (/祠|宗祠|家庙|祠堂/.test(text)) return 'ancestral_hall';
    if (/陵|墓|纪念碑/.test(text)) return 'memorial';

    // 文化场馆
    if (/博物馆|展览馆|纪念馆|陈列馆/.test(text)) return 'museum';
    if (/美术馆|艺术馆|画廊/.test(text)) return 'art_gallery';
    if (/图书馆|书院/.test(text)) return 'library';

    // 教育
    if (/大学|学院|学府/.test(text)) return 'university';
    if (/学校|中学|小学/.test(text)) return 'school';

    // 公园/园林
    if (/园林|花园|御花园/.test(text)) return 'garden';
    if (/公园|乐园|游乐/.test(text)) return 'park';
    if (/植物园/.test(text)) return 'botanical';
    if (/动物园|海洋馆|水族/.test(text)) return 'zoo';

    // 景区
    if (/风景区|景区|名胜|旅游区|度假区/.test(text)) return 'scenic_area';

    // 商业/街区
    if (/步行街|商业街|夜市|美食街/.test(text)) return 'commercial_street';
    if (/广场/.test(text)) return 'plaza';

    // 根据高德 typecode 兜底
    if (typecode) {
      if (typecode.startsWith('1101')) return 'park';       // 公园
      if (typecode.startsWith('1102')) return 'scenic_area'; // 风景名胜
      if (typecode.startsWith('1103')) return 'temple';      // 寺庙
      if (typecode.startsWith('14'))   return 'museum';      // 科教文化
    }

    return 'other';
  }
}

export const poiService = new POIService();
