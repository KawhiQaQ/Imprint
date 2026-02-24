import { v4 as uuidv4 } from 'uuid';
import { deepseekClient, ChatMessage } from '../clients/deepseekClient';
import { tavilyClient } from '../clients/tavilyClient';
import { amapClient, AmapPOI } from '../clients/amapClient';
import { storageService, Itinerary, TravelNode, SearchConditions } from './storageService';
import { poiService, EnrichedPOI } from './poiService';
import { clusterService, ClusterResult, POICluster } from './clusterService';
import { itineraryPipeline } from './itineraryPipeline';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ItineraryUpdateResult {
  itinerary: Itinerary;
  response: string;
}

export interface GeneratedNode {
  name: string;
  type: 'attraction' | 'restaurant' | 'hotel' | 'transport' | string;
  address: string;
  description: string;
  estimatedDuration: number;
  scheduledTime: string;
  dayIndex: number;
  order: number;
  timeSlot?: string; // 时段：arrival, breakfast, morning, lunch, afternoon, dinner, evening, hotel
  activity?: string; // 活动描述：如"游玩西湖景区"、"品尝杭帮菜"
  location?: string; // 经纬度坐标，用于路线优化
  isStartingPoint?: boolean; // 是否是大型景区的起点位置
  scenicAreaName?: string; // 如果是起点，对应的景区名称
  priceInfo?: string; // 价格信息：餐厅人均、酒店房价、景点门票
  ticketInfo?: string; // 门票/预约信息
  tips?: string; // 小贴士
  // 交通信息
  transportMode?: string; // 交通方式：walk, bus, subway, taxi, drive
  transportDuration?: number; // 交通时长（分钟）
  transportNote?: string; // 交通说明
}

// 类型映射：将 AI 可能返回的各种类型值映射到标准类型
const TYPE_MAPPING: Record<string, 'attraction' | 'restaurant' | 'hotel' | 'transport'> = {
  'attraction': 'attraction',
  'restaurant': 'restaurant',
  'hotel': 'hotel',
  'transport': 'transport',
  // 中文映射
  '景点': 'attraction',
  '餐厅': 'restaurant',
  '餐饮': 'restaurant',
  '美食': 'restaurant',
  '酒店': 'hotel',
  '住宿': 'hotel',
  '交通': 'transport',
  '自由活动': 'attraction',
  '休闲': 'attraction',
  '娱乐': 'attraction',
  // 其他可能的变体
  'scenic': 'attraction',
  'food': 'restaurant',
  'dining': 'restaurant',
  'accommodation': 'hotel',
  'lodging': 'hotel',
  'transit': 'transport',
  'transportation': 'transport',
  // 活动类型
  'activity': 'attraction',
  'shopping': 'attraction',
  '购物': 'attraction',
  '活动': 'attraction',
  'cafe': 'restaurant',
  '咖啡': 'restaurant',
  '咖啡厅': 'restaurant',
  'bar': 'restaurant',
  '酒吧': 'restaurant',
};

/**
 * 将 AI 返回的类型值标准化
 */
function normalizeNodeType(type: string): 'attraction' | 'restaurant' | 'hotel' | 'transport' {
  const normalized = TYPE_MAPPING[type?.toLowerCase?.() || type];
  if (normalized) {
    return normalized;
  }
  // 默认返回 attraction
  console.warn(`Unknown node type "${type}", defaulting to "attraction"`);
  return 'attraction';
}

/**
 * 检查节点名称是否是泛指（品类名而非具体店名）
 */
function isGenericName(name: string, type: string): boolean {
  // 去掉括号内的分店信息再检查，如 "猪腰一家(禅城店)" -> "猪腰一家"
  const nameWithoutBranch = name.replace(/[\(（][^)）]*[店分号][\)）]/g, '').trim();

  // 知名品牌白名单 - 这些名称即使匹配到泛指模式也不应被标记
  const knownBrands = [
    // 酒店品牌
    '希尔顿', '万豪', '喜来登', '洲际', '凯悦', '香格里拉', '丽思卡尔顿',
    '四季', '半岛', '文华东方', '瑰丽', '安缦', '悦榕庄', '柏悦', '华尔道夫',
    '威斯汀', '艾美', '雅高', '铂尔曼', '索菲特', '诺富特', '美居',
    '如家', '汉庭', '全季', '桔子', '亚朵', '维也纳', '锦江之星', '7天',
    '格林豪泰', '速8', '华住', '首旅', '开元', '碧桂园', '恒大',
    // 餐饮品牌
    '海底捞', '陶陶居', '点都德', '广州酒家', '莲香楼', '太二', '西贝',
    '外婆家', '绿茶', '新白鹿', '弄堂里', '南京大牌档', '鼎泰丰',
    '必胜客', '肯德基', '麦当劳', '星巴克', '喜茶', '奈雪',
  ];

  if (knownBrands.some(brand => name.includes(brand))) {
    return false;
  }

  // 通用泛指关键词（适用于所有类型）- 包含这些词的名称一定是泛指
  // 注意："一家" 需要特殊处理，只有 "选择一家"、"找一家" 这种才是泛指
  const universalGenericKeywords = [
    '某某', '附近', '周边', '区域', '一带', '或者', '可选', '任选',
    '景区内', '景区外', '市中心', '当地', '本地', '随便', '自由选择',
    '可供选择', '任意', '某家', '某个', '选择一家', '找一家',
  ];

  // 首先检查通用泛指关键词（对所有类型都适用）
  if (universalGenericKeywords.some(keyword => name.includes(keyword))) {
    console.log(`Generic name detected (universal keyword): "${name}"`);
    return true;
  }

  // 餐厅特定的泛指关键词 - 只有当名称本身就是这些词或 "地名+这些词" 时才算泛指
  const restaurantGenericKeywords = [
    '农家乐', '农家菜', '农家饭', '川菜', '湘菜', '粤菜', '东北菜', '西北菜',
    '特色餐厅', '特色餐馆', '特色饭店', '当地餐厅', '当地餐馆',
    '餐馆', '饭店', '饭馆', '菜馆', '食堂',
    '火锅店', '烧烤店', '面馆', '快餐店', '茶餐厅', '小吃店',
    '糖水店', '甜品店', '奶茶店', '咖啡店',
  ];

  // 餐厅泛指后缀 - 如果名称以这些词结尾，需要进一步检查前缀
  const restaurantGenericSuffixes = [
    '农家菜', '农家菜馆', '农家乐', '农家饭', '农家院',
    '菜馆', '餐馆', '饭馆', '饭店', '餐厅', '酒楼', '酒家', '食府',
    '美食城', '小吃城', '美食街',
    '火锅店', '火锅', '烧烤店', '烧烤', '面馆', '粉店', '米线店', '快餐店',
    '茶餐厅', '小吃店', '糖水店', '糖水铺', '甜品店', '甜品屋', '奶茶店',
  ];

  // 酒店泛指关键词
  const hotelGenericKeywords = [
    '经济型酒店', '商务酒店', '快捷酒店', '连锁酒店',
    '宾馆', '旅馆', '民宿', '客栈', '招待所',
  ];

  // 酒店泛指后缀
  const hotelGenericSuffixes = [
    '酒店', '宾馆', '旅馆', '客栈', '民宿', '公寓', '招待所', '旅社',
  ];

  // 常见城市名 - 这些作为前缀时不应被视为"地理特征"
  const commonCityNames = [
    '佛山', '中山', '昆山', '鞍山', '唐山', '黄山', '舟山', '眉山', '乐山',
    '山东', '山西', '海南', '海口', '海宁', '海盐', '海门', '海安',
    '青岛', '青海', '湖州', '湖南', '湖北', '江门', '江阴', '江山',
    '河源', '河池', '河南', '河北', '岛城',
    '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆',
    '武汉', '西安', '长沙', '厦门', '苏州', '无锡', '宁波', '东莞',
    '珠海', '汕头', '惠州', '肇庆', '清远', '韶关', '梅州', '潮州',
    '揭阳', '云浮', '阳江', '茂名', '湛江', '三亚', '桂林', '丽江',
    '大理', '昆明', '贵阳', '拉萨', '兰州', '银川', '西宁', '呼和浩特',
  ];

  // 地名/方位词模式 - 这些作为前缀时表示泛指
  // 改进：排除常见城市名，避免 "佛山" 被 "山" 匹配
  const locationPrefixPatterns = [
    /^[东西南北中][^\u4e00-\u9fa5]/, // 单独的方位词（后面不是汉字）
    /^[东西南北中](门|关|城|区|郊)/, // 方位词+区域词
  ];

  // 检查是否是纯地名+品类的组合（如"西樵山农家菜"、"景区农家菜"）
  const isLocationPlusCategoryName = (name: string, suffixes: string[]): boolean => {
    for (const suffix of suffixes) {
      if (name.endsWith(suffix) || name.includes(suffix)) {
        const prefix = name.replace(suffix, '').trim();
        // 如果前缀为空，则是泛指（如直接叫"餐厅"）
        if (prefix.length === 0) {
          return true;
        }

        // 前缀只有1个字，大概率是泛指
        if (prefix.length <= 1) {
          return true;
        }

        // 如果前缀是已知城市名，这是 "城市名+品类" 的模式
        // 但需要检查城市名后面是否还有品牌名
        // 例如 "佛山希尔顿酒店" -> 前缀 "佛山希尔顿" 包含城市名但也有品牌名
        // 而 "佛山酒店" -> 前缀 "佛山" 就是纯城市名
        const isCityPrefix = commonCityNames.some(city => prefix === city);
        if (isCityPrefix) {
          return true; // 纯 "城市名+品类"，如 "佛山餐厅"
        }

        // 检查前缀是否是方位词模式
        if (locationPrefixPatterns.some(p => p.test(prefix))) {
          return true;
        }

        // 检查前缀是否是纯地理名称（不含品牌/人名成分）
        // 改进：只有当前缀完全由地理词汇组成时才判定为泛指
        const geoSuffixWords = ['景区', '公园', '广场', '街', '路', '村', '镇'];
        const isGeoOnly = geoSuffixWords.some(w => prefix.endsWith(w));
        if (isGeoOnly) {
          return true;
        }

        // 检查 "XX山/湖/江..." 模式，但排除城市名
        // 例如 "西樵山" 是地名，"佛山希尔顿" 不是
        const geoFeaturePattern = /^.{1,3}(山|湖|江|河|海|岛)$/;
        if (geoFeaturePattern.test(prefix)) {
          // 前缀完全是 "X山/X湖" 这种地理名称
          return true;
        }
      }
    }
    return false;
  };

  if (type === 'restaurant') {
    // 检查餐厅特定的泛指关键词
    if (restaurantGenericKeywords.some(keyword => nameWithoutBranch.includes(keyword))) {
      // 进一步检查是否有品牌名
      if (isLocationPlusCategoryName(nameWithoutBranch, restaurantGenericKeywords)) {
        console.log(`Generic name detected (restaurant keyword + location): "${name}"`);
        return true;
      }
    }

    // 检查是否是"地名+后缀"的泛指模式
    if (isLocationPlusCategoryName(nameWithoutBranch, restaurantGenericSuffixes)) {
      console.log(`Generic name detected (location + restaurant suffix): "${name}"`);
      return true;
    }

    return false;
  }

  if (type === 'hotel') {
    if (hotelGenericKeywords.some(keyword => nameWithoutBranch.includes(keyword))) {
      if (isLocationPlusCategoryName(nameWithoutBranch, hotelGenericKeywords)) {
        console.log(`Generic name detected (hotel keyword + location): "${name}"`);
        return true;
      }
    }

    if (isLocationPlusCategoryName(nameWithoutBranch, hotelGenericSuffixes)) {
      console.log(`Generic name detected (location + hotel suffix): "${name}"`);
      return true;
    }

    return false;
  }

  // 景点类型 - 通常景点名称是固定的，只检查通用泛指关键词
  return false;
}


export class ItineraryService {
  private _isRetrying = false;

  /**
   * 选择最优酒店（靠近多个聚类中心的酒店）
   */
  private selectOptimalHotel(
    hotels: EnrichedPOI[],
    clusters: POICluster[]
  ): EnrichedPOI | null {
    const hotelsWithLocation = hotels.filter(h => h.location);
    if (hotelsWithLocation.length === 0) return null;
    if (clusters.length === 0) return hotelsWithLocation[0];

    // 计算每个酒店到所有聚类中心的总距离
    const hotelScores = hotelsWithLocation.map(hotel => {
      const [hotelLng, hotelLat] = hotel.location!.split(',').map(Number);
      let totalDistance = 0;
      
      clusters.forEach(cluster => {
        const dLng = (hotelLng - cluster.centroid.lng) * 111 * Math.cos((hotelLat * Math.PI) / 180);
        const dLat = (hotelLat - cluster.centroid.lat) * 111;
        totalDistance += Math.sqrt(dLng * dLng + dLat * dLat);
      });
      
      return {
        hotel,
        avgDistance: totalDistance / clusters.length,
      };
    });

    // 选择平均距离最小的酒店
    hotelScores.sort((a, b) => a.avgDistance - b.avgDistance);
    
    console.log('Hotel scores (avg distance to cluster centers):');
    hotelScores.slice(0, 3).forEach(({ hotel, avgDistance }) => {
      console.log(`  ${hotel.name}: ${avgDistance.toFixed(1)}km`);
    });

    return hotelScores[0].hotel;
  }

  /**
   * 验证每天行程框架的完整性
   * 检查是否缺少必要的环节（早餐、午餐、晚餐、晚上活动等）
   */
  private validateDailyFramework(
    nodes: GeneratedNode[],
    totalDays: number,
    arrivalTime?: string,
    departureTime?: string
  ): { valid: boolean; issues: string[]; missingSlots: Array<{ dayIndex: number; slot: string; afterSlot?: string }> } {
    const issues: string[] = [];
    const missingSlots: Array<{ dayIndex: number; slot: string; afterSlot?: string }> = [];
    
    const arrivalHour = arrivalTime ? parseInt(arrivalTime.split(':')[0], 10) : 10;
    const departureHour = departureTime ? parseInt(departureTime.split(':')[0], 10) : 17;
    
    // 按天分组
    const nodesByDay = new Map<number, GeneratedNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }
    
    for (let day = 1; day <= totalDays; day++) {
      const dayNodes = nodesByDay.get(day) || [];
      const slots = new Set(dayNodes.map(n => n.timeSlot));
      const isFirstDay = day === 1;
      const isLastDay = day === totalDays;
      
      // 根据抵达/离开时间确定当天应有的时段
      let requiredSlots: string[] = [];
      
      if (isFirstDay) {
        // 第一天根据抵达时间确定
        requiredSlots = ['arrival'];
        if (arrivalHour < 12) {
          requiredSlots.push('morning', 'lunch', 'afternoon', 'dinner', 'evening', 'hotel');
        } else if (arrivalHour < 14) {
          requiredSlots.push('lunch', 'afternoon', 'dinner', 'evening', 'hotel');
        } else if (arrivalHour < 18) {
          requiredSlots.push('afternoon', 'dinner', 'evening', 'hotel');
        } else if (arrivalHour < 21) {
          requiredSlots.push('dinner', 'evening', 'hotel');
        } else {
          requiredSlots.push('hotel');
        }
      } else if (isLastDay) {
        // 最后一天根据离开时间确定
        requiredSlots = ['breakfast'];
        if (departureHour > 12) {
          requiredSlots.push('morning', 'lunch');
        }
        if (departureHour > 15) {
          requiredSlots.push('afternoon');
        }
        if (departureHour > 18) {
          requiredSlots.push('dinner');
        }
        requiredSlots.push('departure');
      } else {
        // 中间天必须完整
        requiredSlots = ['breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening', 'hotel'];
      }
      
      // 检查缺失的时段
      const slotOrder = ['arrival', 'breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening', 'hotel', 'departure'];
      
      for (const slot of requiredSlots) {
        if (!slots.has(slot)) {
          issues.push(`第${day}天缺少${this.getSlotName(slot)}`);
          
          // 找到应该插入的位置（在哪个时段之后）
          const slotIndex = slotOrder.indexOf(slot);
          let afterSlot: string | undefined;
          for (let i = slotIndex - 1; i >= 0; i--) {
            if (slots.has(slotOrder[i])) {
              afterSlot = slotOrder[i];
              break;
            }
          }
          
          missingSlots.push({ dayIndex: day, slot, afterSlot });
        }
      }
    }
    
    return {
      valid: issues.length === 0,
      issues,
      missingSlots,
    };
  }
  
  /**
   * 获取时段的中文名称
   */
  private getSlotName(slot: string): string {
    const names: Record<string, string> = {
      arrival: '抵达',
      breakfast: '早餐',
      morning: '上午游玩',
      lunch: '午餐',
      afternoon: '下午游玩',
      dinner: '晚餐',
      evening: '晚上活动',
      hotel: '回酒店',
      departure: '返程',
    };
    return names[slot] || slot;
  }

  /**
   * 修复缺失的行程环节
   */
  private async fixMissingSlots(
    nodes: GeneratedNode[],
    missingSlots: Array<{ dayIndex: number; slot: string; afterSlot?: string }>,
    destination: string
  ): Promise<GeneratedNode[]> {
    if (missingSlots.length === 0) return nodes;
    
    console.log(`Fixing ${missingSlots.length} missing slots...`);
    
    const prompt = `你需要为${destination}的旅行行程补充缺失的环节。

当前行程节点：
${JSON.stringify(nodes.map(n => ({ day: n.dayIndex, time: n.scheduledTime, slot: n.timeSlot, name: n.name })), null, 2)}

缺失的环节：
${missingSlots.map(m => `- 第${m.dayIndex}天缺少${this.getSlotName(m.slot)}${m.afterSlot ? `（应在${this.getSlotName(m.afterSlot)}之后）` : ''}`).join('\n')}

请为每个缺失的环节生成一个具体的节点。要求：
1. 必须使用${destination}真实存在的具体店名/景点名
2. 时间要合理衔接（早餐08:00，上午09:30，午餐12:00，下午14:00，晚餐18:00，晚上20:00）
3. 包含完整的节点信息（priceInfo、transportMode等）

返回JSON数组，每个元素是一个完整的节点对象，格式：
{
  "name": "具体名称",
  "type": "restaurant/attraction/hotel/transport",
  "address": "地址",
  "description": "描述",
  "activity": "活动描述",
  "timeSlot": "时段",
  "estimatedDuration": 分钟数,
  "scheduledTime": "HH:MM",
  "dayIndex": 天数,
  "order": 顺序,
  "priceInfo": "价格信息",
  "ticketInfo": "门票信息（景点需要）",
  "transportMode": "交通方式",
  "transportDuration": 交通时长,
  "transportNote": "交通说明"
}

只返回JSON数组，不要其他内容。`;

    try {
      const newNodes = await deepseekClient.chatWithJson<GeneratedNode[]>([
        { role: 'system', content: '你是一个旅行规划助手，负责补充行程中缺失的环节。只返回JSON数组。' },
        { role: 'user', content: prompt }
      ]);
      
      // 合并新节点到原节点列表
      const allNodes = [...nodes, ...newNodes];
      
      // 重新排序
      allNodes.sort((a, b) => {
        if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
        const timeA = a.scheduledTime || '00:00';
        const timeB = b.scheduledTime || '00:00';
        return timeA.localeCompare(timeB);
      });
      
      // 重新分配 order
      let currentDay = 0;
      let order = 0;
      for (const node of allNodes) {
        if (node.dayIndex !== currentDay) {
          currentDay = node.dayIndex;
          order = 1;
        }
        node.order = order++;
      }
      
      console.log(`Added ${newNodes.length} nodes to fix missing slots`);
      return allNodes;
    } catch (error) {
      console.error('Failed to fix missing slots via AI:', error);
      
      // Fallback: 生成占位节点，确保框架完整
      console.log('Using fallback to generate placeholder nodes...');
      const placeholderNodes: GeneratedNode[] = [];
      
      const slotConfig: Record<string, { time: string; type: string; activity: string; duration: number }> = {
        breakfast: { time: '08:00', type: 'restaurant', activity: '早餐', duration: 45 },
        morning: { time: '09:30', type: 'attraction', activity: '上午游玩', duration: 120 },
        lunch: { time: '12:00', type: 'restaurant', activity: '午餐', duration: 60 },
        afternoon: { time: '14:00', type: 'attraction', activity: '下午游玩', duration: 150 },
        dinner: { time: '18:00', type: 'restaurant', activity: '晚餐', duration: 60 },
        evening: { time: '20:00', type: 'attraction', activity: '晚上活动', duration: 90 },
      };
      
      for (const missing of missingSlots) {
        const config = slotConfig[missing.slot];
        if (config) {
          placeholderNodes.push({
            name: `${destination}${config.activity === '早餐' ? '早餐店' : config.activity === '午餐' || config.activity === '晚餐' ? '餐厅' : '景点'}`,
            type: config.type as 'restaurant' | 'attraction',
            address: destination,
            description: `${destination}${config.activity}推荐`,
            activity: `${config.activity}：${destination}特色体验`,
            timeSlot: missing.slot,
            estimatedDuration: config.duration,
            scheduledTime: config.time,
            dayIndex: missing.dayIndex,
            order: 0, // 会在后面重新分配
          });
        }
      }
      
      if (placeholderNodes.length > 0) {
        const allNodes = [...nodes, ...placeholderNodes];
        
        // 重新排序
        allNodes.sort((a, b) => {
          if (a.dayIndex !== b.dayIndex) return a.dayIndex - b.dayIndex;
          const timeA = a.scheduledTime || '00:00';
          const timeB = b.scheduledTime || '00:00';
          return timeA.localeCompare(timeB);
        });
        
        // 重新分配 order
        let currentDay = 0;
        let order = 0;
        for (const node of allNodes) {
          if (node.dayIndex !== currentDay) {
            currentDay = node.dayIndex;
            order = 1;
          }
          node.order = order++;
        }
        
        console.log(`Added ${placeholderNodes.length} placeholder nodes as fallback`);
        return allNodes;
      }
      
      return nodes;
    }
  }

  /**
   * 验证生成的节点，检查是否有泛指名称
   */
  private validateGeneratedNodes(
    nodes: GeneratedNode[], 
    departureTime?: string
  ): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    
    nodes.forEach((node, index) => {
      // 跳过交通节点
      if (node.type === 'transport') return;
      
      // 检查是否是泛指名称
      if (isGenericName(node.name, node.type)) {
        issues.push(`节点${index + 1}（${node.name}）使用了泛指名称，应该是具体的${node.type === 'restaurant' ? '店名' : node.type === 'hotel' ? '酒店名' : '景点名'}`);
      }
      
      // 检查名称长度（太短可能是泛指）
      // 注意：景点名称2个字很常见（如祖庙、梁园、故宫、西湖、外滩），不应被标记
      if (node.name.length < 2 && node.type !== 'transport') {
        issues.push(`节点${index + 1}（${node.name}）名称过短，可能不是具体名称`);
      }
    });
    
    // 检查最后一天是否正确处理离开时间
    if (departureTime && nodes.length > 0) {
      const maxDay = Math.max(...nodes.map(n => n.dayIndex));
      const lastDayNodes = nodes.filter(n => n.dayIndex === maxDay);
      
      if (lastDayNodes.length > 0) {
        const lastNode = lastDayNodes[lastDayNodes.length - 1];
        const departureHour = parseInt(departureTime.split(':')[0], 10);
        
        // 检查最后一个节点是否是返程
        if (lastNode.timeSlot !== 'departure') {
          issues.push(`最后一天的最后一个节点应该是返程(departure)，但实际是 ${lastNode.timeSlot || lastNode.name}`);
        }
        
        // 检查最后一天是否有不合理的晚间安排
        if (departureHour <= 18) {
          const hasLateActivity = lastDayNodes.some(n => {
            if (!n.scheduledTime) return false;
            const hour = parseInt(n.scheduledTime.split(':')[0], 10);
            return hour >= departureHour && n.timeSlot !== 'departure';
          });
          
          if (hasLateActivity) {
            issues.push(`最后一天离开时间是 ${departureTime}，但安排了离开时间之后的活动`);
          }
          
          // 检查是否有回酒店节点（最后一天不应该有）
          const hasHotelReturn = lastDayNodes.some(n => n.timeSlot === 'hotel');
          if (hasHotelReturn) {
            issues.push(`最后一天不应该安排回酒店，应该直接返程`);
          }
        }
      }
    }
    
    // 检查餐厅名称重复
    const restaurantNames = new Map<string, number>();
    nodes.forEach((node, index) => {
      if (node.type === 'restaurant') {
        if (restaurantNames.has(node.name)) {
          issues.push(`餐厅重复：节点${index + 1}（${node.name}）与节点${restaurantNames.get(node.name)! + 1}重复`);
        } else {
          restaurantNames.set(node.name, index);
        }
      }
    });
    
    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * 去重 LLM 生成的餐厅节点：重复的餐厅名用候选池中未使用的替换，无候选则加后缀区分
   */
  private deduplicateGeneratedRestaurants(nodes: GeneratedNode[], restaurants: EnrichedPOI[]): void {
    const seen = new Set<string>();
    const usedNames = new Set(nodes.filter(n => n.type === 'restaurant').map(n => n.name));
    
    for (const node of nodes) {
      if (node.type !== 'restaurant') continue;
      if (!seen.has(node.name)) {
        seen.add(node.name);
        continue;
      }
      // 重复了，尝试从候选池找替代
      const replacement = restaurants.find(r => !seen.has(r.name) && !usedNames.has(r.name));
      if (replacement) {
        console.log(`[Dedup] Replacing duplicate "${node.name}" with "${replacement.name}"`);
        node.name = replacement.name;
        node.address = replacement.address || node.address;
        node.description = replacement.description || node.description;
        seen.add(replacement.name);
        usedNames.add(replacement.name);
      } else {
        // 无候选，加天数后缀避免完全重复
        const newName = `${node.name}(第${node.dayIndex}天)`;
        console.warn(`[Dedup] No replacement for duplicate "${node.name}", renaming to "${newName}"`);
        node.name = newName;
        seen.add(newName);
      }
    }
  }

  /**
   * 验证路线合理性，检查是否有来回跑的情况
   * 在距离计算完成后调用
   */
  private validateRouteReasonability(nodes: TravelNode[]): { 
    valid: boolean; 
    issues: string[];
    problematicDays: Array<{ dayIndex: number; totalDistance: number; longDistanceSegments: Array<{ from: string; to: string; distance: number }> }>;
  } {
    const issues: string[] = [];
    const problematicDays: Array<{ dayIndex: number; totalDistance: number; longDistanceSegments: Array<{ from: string; to: string; distance: number }> }> = [];
    
    // 按天分组
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }
    
    // 只检查硬性超标，不做软约束警告
    const DISTANCE_LIMITS = {
      fromHotelMax: 30,      // 从酒店出发到第一个景点的最大距离
      toHotelMax: 30,        // 最后回酒店的最大距离
      betweenNodesMax: 20,   // 中间节点（含餐厅）统一 20km 硬限制
      dailyTotalMax: 60,     // 一天总移动距离上限
    };
    
    // 检查每天的路线
    for (const [day, dayNodes] of nodesByDay) {
      dayNodes.sort((a, b) => a.order - b.order);
      
      let totalDistance = 0;
      const longDistanceSegments: Array<{ from: string; to: string; distance: number }> = [];
      
      for (let i = 0; i < dayNodes.length - 1; i++) {
        const currentNode = dayNodes[i];
        const nextNode = dayNodes[i + 1];
        const distance = currentNode.distanceToNext;
        
        if (distance) {
          totalDistance += distance;
          
          const isFromHotel = currentNode.timeSlot === 'hotel' || currentNode.timeSlot === 'breakfast';
          const isToHotel = nextNode?.timeSlot === 'hotel';
          const isDeparture = nextNode?.timeSlot === 'departure';
          
          const maxAllowed = isFromHotel ? DISTANCE_LIMITS.fromHotelMax :
            (isToHotel || isDeparture) ? DISTANCE_LIMITS.toHotelMax : DISTANCE_LIMITS.betweenNodesMax;
          
          // 只有真正超过硬限制才报 issue，20km 以内的不管
          if (distance > maxAllowed) {
            longDistanceSegments.push({ from: currentNode.name, to: nextNode?.name || '未知', distance });
            issues.push(`第${day}天：从"${currentNode.name}"到"${nextNode?.name}"距离${distance.toFixed(1)}km（限制${maxAllowed}km）`);
          }
        }
      }
      
      // 检查一天的总移动距离是否过长
      if (totalDistance > DISTANCE_LIMITS.dailyTotalMax) {
        issues.push(`第${day}天：总移动距离${totalDistance.toFixed(1)}km超过${DISTANCE_LIMITS.dailyTotalMax}km`);
      }
      
      // 记录有问题的天
      if (longDistanceSegments.length > 0 || totalDistance > DISTANCE_LIMITS.dailyTotalMax) {
        problematicDays.push({ dayIndex: day, totalDistance, longDistanceSegments });
      }
    }
    
    return {
      valid: issues.length === 0,
      issues,
      problematicDays,
    };
  }

  /**
   * 修复距离问题 - 检查每一天的节点距离，使用 LLM 智能选择替代
   * 核心思路：
   * 1. 遍历每一天的每个节点，检查与前一个节点的距离
   * 2. 对于距离过远的节点，搜索附近候选 POI，让 LLM 选择最合适的替代
   * 3. 确保同一天的节点在地理上连贯
   */
  private async fixDistanceIssues(
    nodes: TravelNode[],
    destination: string,
    totalDays: number
  ): Promise<TravelNode[]> {
    console.log(`Checking and fixing distance issues for all ${totalDays} days...`);
    
    // 1. 找到酒店位置作为基准点
    const hotelNode = nodes.find(n => 
      n.type === 'hotel' || 
      n.timeSlot === 'hotel' ||
      n.name.includes('酒店') ||
      n.name.includes('入住')
    );
    
    if (!hotelNode?.location) {
      console.warn('No hotel location found, cannot fix distances');
      return nodes;
    }
    
    const hotelLocation = hotelNode.location;
    console.log(`Using hotel "${hotelNode.name}" at ${hotelLocation} as center point`);
    
    // 2. 收集所有需要替换的节点
    const nodesToReplace: Array<{
      node: TravelNode;
      nodeIndex: number;
      prevLocation: string;
      prevNodeName: string;
      dayIndex: number;
      distanceFromPrev: number;
    }> = [];
    
    // 按天分组
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }
    
    // 距离阈值（软约束，优先保证规划质量）
    const MAX_DISTANCE_BETWEEN_NODES = 20; // km
    
    // 3. 检查每一天的每个节点
    for (let dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
      const dayNodes = nodesByDay.get(dayIndex);
      if (!dayNodes) continue;
      
      console.log(`\n=== Checking Day ${dayIndex} (${dayNodes.length} nodes) ===`);
      
      dayNodes.sort((a, b) => a.order - b.order);
      
      for (let i = 0; i < dayNodes.length; i++) {
        const currentNode = dayNodes[i];
        
        // 跳过固定节点
        if (['arrival', 'hotel', 'departure'].includes(currentNode.timeSlot || '')) continue;
        if (currentNode.type === 'transport') continue;
        if (!currentNode.location) continue;
        
        // 找前一个有位置的节点
        let prevLocation = hotelLocation;
        let prevNodeName = hotelNode.name;
        for (let j = i - 1; j >= 0; j--) {
          if (dayNodes[j].location) {
            prevLocation = dayNodes[j].location!;
            prevNodeName = dayNodes[j].name;
            break;
          }
        }
        
        const distanceFromPrev = amapClient.calculateDistance(prevLocation, currentNode.location);
        
        if (distanceFromPrev > MAX_DISTANCE_BETWEEN_NODES) {
          const nodeIndex = nodes.findIndex(n => n.id === currentNode.id);
          nodesToReplace.push({
            node: currentNode,
            nodeIndex,
            prevLocation,
            prevNodeName,
            dayIndex,
            distanceFromPrev,
          });
          console.log(`Node "${currentNode.name}" is ${distanceFromPrev.toFixed(1)}km from "${prevNodeName}" - needs replacement`);
        }
      }
    }
    
    if (nodesToReplace.length === 0) {
      console.log('No nodes need replacement after analysis');
      return nodes;
    }
    
    console.log(`Found ${nodesToReplace.length} nodes that need replacement`);
    
    // 4. 为每个需要替换的节点，搜索候选 POI 并让 LLM 选择
    for (const { node, nodeIndex, prevLocation, prevNodeName, dayIndex, distanceFromPrev } of nodesToReplace) {
      if (nodeIndex < 0) continue;
      
      // 搜索附近的候选 POI
      const candidates = await this.searchNearbyCandidates(node, prevLocation, destination, nodes);
      
      if (candidates.length === 0) {
        console.log(`No candidates found for "${node.name}", skipping`);
        continue;
      }
      
      // 获取当天的其他节点信息，用于上下文
      const dayNodes = nodesByDay.get(dayIndex) || [];
      const dayContext = dayNodes
        .filter(n => n.id !== node.id)
        .map(n => `${n.timeSlot}: ${n.name}`)
        .join(', ');
      
      // 让 LLM 从候选中选择
      const selectedPOI = await this.selectReplacementWithLLM(
        node,
        candidates,
        prevNodeName,
        dayContext,
        destination
      );
      
      if (selectedPOI) {
        console.log(`LLM selected "${selectedPOI.name}" to replace "${node.name}"`);
        
        const oldName = nodes[nodeIndex].name;
        nodes[nodeIndex].name = selectedPOI.name;
        nodes[nodeIndex].address = selectedPOI.address || nodes[nodeIndex].address;
        nodes[nodeIndex].location = selectedPOI.location;
        nodes[nodeIndex].distanceToNext = undefined;
        // 同步更新 activity 字段，保持标题和内容一致
        if (nodes[nodeIndex].activity) {
          nodes[nodeIndex].activity = nodes[nodeIndex].activity.replace(oldName, selectedPOI.name);
        }
        
        // 更新描述
        let newDesc = '';
        if (selectedPOI.rating) newDesc += `评分${selectedPOI.rating}`;
        if (selectedPOI.cost) newDesc += `${newDesc ? '，' : ''}人均¥${selectedPOI.cost}`;
        if (newDesc) nodes[nodeIndex].description = newDesc;
      }
      
      // 添加延迟，避免高德 API 限流（免费版 QPS 限制约 3次/秒）
      await this.delay(800);
    }
    
    return nodes;
  }
  
  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 搜索附近的候选 POI（使用周边搜索，带重试机制）
   */
  private async searchNearbyCandidates(
    originalNode: TravelNode,
    nearLocation: string,
    destination: string,
    existingNodes: TravelNode[]
  ): Promise<Array<AmapPOI & { distanceFromTarget: number }>> {
    const maxRetries = 3;
    const SEARCH_RADIUS = 15000; // 15km 半径，扩大搜索范围
    
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // 如果是重试，先等待更长时间
        if (retry > 0) {
          const waitTime = 2000 * retry; // 2秒、4秒递增
          console.log(`Retry ${retry}/${maxRetries} for "${originalNode.name}", waiting ${waitTime}ms...`);
          await this.delay(waitTime);
        }
        
        // 根据节点类型和时段确定搜索关键词
        let searchKeyword = '';
        let searchTypes = '';
        
        if (originalNode.type === 'restaurant') {
          searchTypes = '050000'; // 餐饮服务
          if (originalNode.timeSlot === 'breakfast') {
            searchKeyword = '早餐 早茶 茶楼 点心';
          } else if (originalNode.timeSlot === 'lunch' || originalNode.timeSlot === 'dinner') {
            searchKeyword = '餐厅 中餐 粤菜 特色菜';
          } else {
            searchKeyword = '餐厅 美食';
          }
        } else if (originalNode.type === 'attraction') {
          searchTypes = '110000|140000'; // 风景名胜 + 科教文化
          if (originalNode.timeSlot === 'evening') {
            searchKeyword = '夜景 步行街 广场 夜市';
          } else {
            searchKeyword = '景点 公园 博物馆 古迹 广场';
          }
        }
        
        // 使用周边搜索（基于坐标），而不是城市范围搜索
        const pois = await amapClient.searchAround(nearLocation, SEARCH_RADIUS, {
          keywords: searchKeyword,
          types: searchTypes,
          pageSize: 30,
          sortRule: 'distance', // 按距离排序
        });
        
        if (pois.length === 0) {
          console.log(`No POIs found around ${nearLocation} for "${originalNode.name}"`);
          return [];
        }
        
        // 筛选候选
        const candidates: Array<AmapPOI & { distanceFromTarget: number }> = [];
        
        for (const poi of pois) {
          if (!poi.location) continue;
          
          const distance = amapClient.calculateDistance(nearLocation, poi.location);
          
          // 筛选条件：不是泛指名称、不在现有行程中
          if (!isGenericName(poi.name, originalNode.type) && 
              !existingNodes.some(n => n.name === poi.name)) {
            candidates.push({ ...poi, distanceFromTarget: distance });
          }
        }
        
        // 取前 5 个作为候选（已经按距离排序）
        console.log(`Found ${candidates.length} candidates for "${originalNode.name}"`);
        return candidates.slice(0, 5);
      } catch (error: any) {
        // 检查是否是限流错误
        const isRateLimited = error?.message?.includes('EXCEEDED_THE_LIMIT') || 
                             error?.info?.includes('EXCEEDED_THE_LIMIT');
        
        if (isRateLimited && retry < maxRetries - 1) {
          console.warn(`Rate limited when searching for "${originalNode.name}", will retry...`);
          continue;
        }
        
        console.error(`Failed to search candidates for ${originalNode.name}:`, error);
        return [];
      }
    }
    
    return [];
  }
  
  /**
   * 让 LLM 从候选 POI 中选择最合适的替代
   */
  private async selectReplacementWithLLM(
    originalNode: TravelNode,
    candidates: Array<AmapPOI & { distanceFromTarget: number }>,
    prevNodeName: string,
    dayContext: string,
    destination: string
  ): Promise<AmapPOI | null> {
    if (candidates.length === 0) return null;
    
    // 如果只有一个候选，直接返回
    if (candidates.length === 1) {
      return candidates[0];
    }
    
    // 构建候选列表描述
    const candidatesList = candidates.map((c, i) => {
      let desc = `${i + 1}. ${c.name}`;
      desc += ` | 距离${c.distanceFromTarget.toFixed(1)}km`;
      desc += ` | 地址: ${c.address || '未知'}`;
      if (c.rating) desc += ` | 评分${c.rating}`;
      if (c.cost) desc += ` | 人均¥${c.cost}`;
      if (c.type) desc += ` | 类型: ${c.type}`;
      return desc;
    }).join('\n');
    
    const nodeTypeDesc = originalNode.type === 'restaurant' ? '餐厅' : 
                         originalNode.type === 'attraction' ? '景点' : '地点';
    const timeSlotDesc = {
      'breakfast': '早餐',
      'lunch': '午餐',
      'dinner': '晚餐',
      'morning': '上午游玩',
      'afternoon': '下午游玩',
      'evening': '晚上活动',
    }[originalNode.timeSlot || ''] || originalNode.timeSlot;
    
    const prompt = `你需要为${destination}的旅行行程选择一个替代${nodeTypeDesc}。

原计划：${timeSlotDesc}去"${originalNode.name}"
问题：该地点距离上一站"${prevNodeName}"太远，需要替换为附近的地点

当天其他安排：${dayContext || '暂无'}

以下是距离"${prevNodeName}"较近的${nodeTypeDesc}候选（已按距离排序）：
${candidatesList}

请从以上候选中选择最合适的一个，考虑因素：
1. 距离越近越好（减少交通时间）
2. 与${timeSlotDesc}的场景匹配（如早餐选早茶/点心店，晚上选有夜景的地方）
3. 评分和口碑
4. 与当天其他安排的搭配

只返回你选择的序号（1-${candidates.length}），不要其他内容。`;

    try {
      const response = await deepseekClient.chat([
        { role: 'system', content: '你是一个旅行规划助手，帮助选择最合适的替代地点。只返回数字序号。' },
        { role: 'user', content: prompt }
      ]);
      
      // 解析返回的序号
      const match = response.match(/\d+/);
      if (match) {
        const index = parseInt(match[0], 10) - 1;
        if (index >= 0 && index < candidates.length) {
          return candidates[index];
        }
      }
      
      // 如果解析失败，返回距离最近的
      console.warn('Failed to parse LLM selection, using nearest candidate');
      return candidates[0];
    } catch (error) {
      console.error('LLM selection failed:', error);
      return candidates[0];
    }
  }

  /**
   * 修复最后一天的行程问题
   */
  private async fixLastDayNodes(
    nodes: GeneratedNode[],
    destination: string,
    departureTime: string,
    totalDays: number
  ): Promise<GeneratedNode[]> {
    const maxDay = Math.max(...nodes.map(n => n.dayIndex));
    const lastDayNodes = nodes.filter(n => n.dayIndex === maxDay);
    const otherNodes = nodes.filter(n => n.dayIndex !== maxDay);
    
    const departureHour = parseInt(departureTime.split(':')[0], 10);
    
    const prompt = `你需要修复一个旅行行程的最后一天安排。

目的地：${destination}
最后一天是第${totalDays}天
用户离开时间：${departureTime}

当前最后一天的错误安排：
${JSON.stringify(lastDayNodes, null, 2)}

问题：最后一天的安排没有正确考虑离开时间（${departureTime}），可能安排了离开时间之后的活动，或者安排了回酒店。

请重新生成最后一天的行程，要求：
1. 最后一个节点必须是返程（timeSlot: departure），时间设为 ${departureTime}
2. 不要安排回酒店（timeSlot: hotel）
3. 所有活动必须在 ${departureTime} 之前完成
4. ${departureHour <= 12 ? '由于离开时间较早，只安排早餐和简单活动' : departureHour <= 15 ? '可以安排早餐、上午景点和午餐' : '可以安排较完整的白天行程，但不要安排晚餐和晚上活动'}
5. 保持节点格式与原来一致，dayIndex 设为 ${maxDay}

只返回最后一天的节点JSON数组，不要其他内容。`;

    try {
      const fixedLastDayNodes = await deepseekClient.chatWithJson<GeneratedNode[]>([
        { role: 'system', content: '你是一个旅行规划修复助手，负责修正行程中的时间安排问题。只返回JSON数组。' },
        { role: 'user', content: prompt }
      ]);
      
      console.log('Fixed last day nodes:', fixedLastDayNodes.length);
      
      // 验证 AI 返回的结果是否合理
      if (fixedLastDayNodes.length <= 1) {
        console.warn('AI returned too few nodes for last day, using fallback');
        throw new Error('AI returned insufficient nodes');
      }
      
      // 确保有返程节点
      const hasDeparture = fixedLastDayNodes.some(n => n.timeSlot === 'departure');
      if (!hasDeparture) {
        fixedLastDayNodes.push({
          name: `前往机场/火车站返程`,
          type: 'transport',
          address: '',
          description: '结束愉快的旅程，返回家乡',
          activity: `返程：前往机场/火车站`,
          timeSlot: 'departure',
          estimatedDuration: 60,
          scheduledTime: departureTime,
          dayIndex: maxDay,
          order: fixedLastDayNodes.length + 1,
        });
      }
      
      return [...otherNodes, ...fixedLastDayNodes];
    } catch (error) {
      console.error('Failed to fix last day nodes:', error);
      // 如果修复失败，手动修正：移除最后一天离开时间之后的节点，并确保有返程节点
      const fixedNodes = lastDayNodes.filter(n => {
        // 保留返程节点
        if (n.timeSlot === 'departure') return true;
        // 移除回酒店节点（最后一天不需要）
        if (n.timeSlot === 'hotel') return false;
        // 如果没有时间，保留
        if (!n.scheduledTime) return true;
        const hour = parseInt(n.scheduledTime.split(':')[0], 10);
        // 保留离开时间之前的节点
        return hour < departureHour;
      });
      
      // 确保有返程节点
      const hasDeparture = fixedNodes.some(n => n.timeSlot === 'departure');
      if (!hasDeparture) {
        fixedNodes.push({
          name: `前往机场/火车站返程`,
          type: 'transport',
          address: '',
          description: '结束愉快的旅程，返回家乡',
          activity: `返程：前往机场/火车站`,
          timeSlot: 'departure',
          estimatedDuration: 60,
          scheduledTime: departureTime,
          dayIndex: maxDay,
          order: fixedNodes.length + 1,
        });
      }
      
      // 如果过滤后只剩返程节点，说明原始数据有问题，需要重新生成最后一天
      // 这种情况下，让 validateDailyFramework 和 fixMissingSlots 来处理
      if (fixedNodes.length <= 1) {
        console.warn('Last day has no valid nodes after filtering, will rely on fixMissingSlots');
      }
      
      return [...otherNodes, ...fixedNodes];
    }
  }

  /**
   * 修复泛指名称的节点
   */
  private async fixGenericNameNodes(
    nodes: GeneratedNode[],
    destination: string
  ): Promise<GeneratedNode[]> {
    // 找出所有泛指名称的节点
    const genericNodes = nodes.filter(n => 
      n.type !== 'transport' && isGenericName(n.name, n.type)
    );
    
    if (genericNodes.length === 0) return nodes;
    
    console.log(`Found ${genericNodes.length} nodes with generic names, attempting to fix...`);
    
    const prompt = `你需要修复旅行行程中一些使用泛指名称的节点。

目的地：${destination}

以下节点使用了泛指名称，需要替换为具体的、真实存在的店名/景点名：

${genericNodes.map((n, i) => `${i + 1}. 第${n.dayIndex}天 ${n.scheduledTime} - "${n.name}" (${n.type === 'restaurant' ? '餐厅' : n.type === 'hotel' ? '酒店' : '景点'})
   活动：${n.activity || '无'}
   描述：${n.description || '无'}`).join('\n')}

【极其重要】什么是泛指名称（必须避免）：
❌ "西樵山农家菜馆" - 这是泛指，因为"农家菜馆"是品类名，前面只有地名
❌ "景区附近餐厅" - 这是泛指
❌ "当地特色餐馆" - 这是泛指
❌ "XX路美食街" - 这是泛指

【正确的具体店名示例】：
✅ "海底捞火锅(佛山店)" - 有品牌名"海底捞"
✅ "陶陶居(祖庙店)" - 有品牌名"陶陶居"
✅ "点都德(岭南天地店)" - 有品牌名"点都德"
✅ "阿强酸菜鱼" - 有店主名"阿强"
✅ "肥婆牛杂" - 有特色名"肥婆"

请为每个节点提供一个具体的、真实存在的替代名称。要求：
1. 必须是${destination}真实存在的、有具体品牌/店名的店铺
2. 不能只是"地名+品类"的组合（如"西樵山农家菜馆"）
3. 必须有明确的品牌名、店主名或特色名
4. 符合原节点的类型和用途

返回JSON数组，每个元素包含：
- index: 原节点在列表中的序号（从1开始）
- newName: 新的具体名称（必须包含品牌名）
- newAddress: 新地址

只返回JSON数组，不要其他内容。`;

    try {
      interface FixResult {
        index: number;
        newName: string;
        newAddress?: string;
      }
      
      const fixes = await deepseekClient.chatWithJson<FixResult[]>([
        { role: 'system', content: `你是一个旅行规划助手，负责将泛指的地点名称替换为具体的真实地点。
【重要】你必须返回真实存在的、有品牌名的店铺，不能返回"地名+品类"的组合。
例如：不能返回"西樵山农家菜馆"，应该返回"松记农家菜"或"阿婆私房菜"这样有具体店名的。
只返回JSON数组。` },
        { role: 'user', content: prompt }
      ]);
      
      // 应用修复，并验证新名称是否仍然是泛指
      const genericNodeIndices = nodes.map((n, i) => 
        n.type !== 'transport' && isGenericName(n.name, n.type) ? i : -1
      ).filter(i => i >= 0);
      
      let unfixedCount = 0;
      fixes.forEach(fix => {
        const nodeIndex = genericNodeIndices[fix.index - 1];
        if (nodeIndex !== undefined && nodeIndex >= 0 && nodes[nodeIndex]) {
          const newName = fix.newName;
          const nodeType = nodes[nodeIndex].type;
          
          // 验证新名称是否仍然是泛指
          if (isGenericName(newName, nodeType)) {
            console.warn(`Fix rejected: "${newName}" is still a generic name for "${nodes[nodeIndex].name}"`);
            unfixedCount++;
            return; // 跳过这个修复
          }
          
          console.log(`Fixing node "${nodes[nodeIndex].name}" -> "${newName}"`);
          const oldName = nodes[nodeIndex].name;
          nodes[nodeIndex].name = newName;
          // 同步更新 activity 字段，保持标题和内容一致
          if (nodes[nodeIndex].activity) {
            nodes[nodeIndex].activity = nodes[nodeIndex].activity.replace(oldName, newName);
          }
          if (fix.newAddress) {
            nodes[nodeIndex].address = fix.newAddress;
          }
        }
      });
      
      // 如果还有未修复的泛指名称，尝试使用高德 API 搜索真实店铺
      if (unfixedCount > 0) {
        console.warn(`${unfixedCount} generic names could not be fixed by AI - trying Amap API`);
        const stillGenericNodes = nodes.filter(n => 
          n.type !== 'transport' && isGenericName(n.name, n.type)
        );
        
        for (const node of stillGenericNodes) {
          const nodeIndex = nodes.indexOf(node);
          if (nodeIndex === -1) continue;
          
          try {
            // 根据节点类型搜索真实店铺
            let searchKeyword = '';
            if (node.type === 'restaurant') {
              // 从描述或活动中提取关键词
              const desc = node.description || node.activity || '';
              if (desc.includes('农家') || node.name.includes('农家')) {
                searchKeyword = '农家菜';
              } else if (desc.includes('海鲜') || node.name.includes('海鲜')) {
                searchKeyword = '海鲜';
              } else {
                searchKeyword = '餐厅';
              }
            } else if (node.type === 'hotel') {
              searchKeyword = '酒店';
            }
            
            if (searchKeyword) {
              // 延迟避免 QPS 超限
              await this.delay(400);
              
              const pois = await amapClient.searchPOI({
                keywords: searchKeyword,
                city: destination,
                pageSize: 5,
              });
              
              // 找一个不是泛指的真实店铺
              const realPOI = pois.find(p => !isGenericName(p.name, node.type));
              if (realPOI) {
                console.log(`Amap fix: "${node.name}" -> "${realPOI.name}"`);
                const oldName = nodes[nodeIndex].name;
                nodes[nodeIndex].name = realPOI.name;
                // 同步更新 activity 字段，保持标题和内容一致
                if (nodes[nodeIndex].activity) {
                  nodes[nodeIndex].activity = nodes[nodeIndex].activity.replace(oldName, realPOI.name);
                }
                nodes[nodeIndex].address = realPOI.address || nodes[nodeIndex].address;
              } else {
                console.warn(`Amap could not find non-generic replacement for "${node.name}"`);
              }
            }
          } catch (amapError) {
            console.warn(`Amap search failed for "${node.name}":`, amapError);
          }
        }
      }
      
      return nodes;
    } catch (error) {
      console.error('Failed to fix generic name nodes:', error);
      return nodes;
    }
  }

  /**
   * 为节点计算到下一个节点的距离
   * @param nodes 节点数组
   * @param poiMap POI名称到详情的映射（包含location信息）
   * @param city 城市名称，用于高德搜索
   */
  private async calculateDistances(
    nodes: TravelNode[],
    poiMap: Map<string, EnrichedPOI>,
    city?: string
  ): Promise<TravelNode[]> {
    // 按天分组
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }

    // 找到酒店节点的位置（用于早餐、回酒店、入住等节点）
    let hotelLocation: string | undefined;
    // 查找酒店节点：type 为 hotel，或者名称包含"酒店"/"入住"
    const hotelNode = nodes.find(n => 
      n.type === 'hotel' || 
      n.timeSlot === 'hotel' ||
      n.name.includes('酒店') ||
      n.name.includes('入住')
    );
    
    if (hotelNode) {
      console.log(`Found hotel node: "${hotelNode.name}" (type: ${hotelNode.type}, timeSlot: ${hotelNode.timeSlot})`);
      
      // 优先从 poiMap 获取
      const hotelPOI = poiMap.get(hotelNode.name);
      if (hotelPOI?.location) {
        hotelLocation = hotelPOI.location;
        hotelNode.location = hotelLocation;
        console.log(`Hotel location from poiMap: ${hotelLocation}`);
      } else if (city) {
        // 通过高德搜索酒店位置
        try {
          // 如果节点名称是"入住酒店"这种泛指，搜索城市的酒店
          const searchKeyword = hotelNode.name.includes('入住') && !hotelNode.name.match(/[\u4e00-\u9fa5]{2,}酒店/)
            ? `${city}酒店`
            : hotelNode.name;
          
          const pois = await amapClient.searchPOI({
            keywords: searchKeyword,
            city,
            pageSize: 1,
            types: '100000', // 住宿服务
          });
          if (pois.length > 0 && pois[0].location) {
            hotelLocation = pois[0].location;
            hotelNode.location = hotelLocation;
            console.log(`Found hotel location for "${hotelNode.name}" via search "${searchKeyword}": ${hotelLocation}`);
          } else {
            console.warn(`No hotel location found for "${hotelNode.name}"`);
          }
        } catch (error) {
          console.warn(`Failed to get hotel location:`, error);
        }
      }
    } else {
      console.log('No hotel node found in itinerary');
    }

    // 辅助函数：获取节点位置
    const getNodeLocation = async (node: TravelNode): Promise<string | undefined> => {
      // 1. 优先使用节点自带的位置
      if (node.location) return node.location;
      
      // 2. 从 poiMap 查找
      const poi = poiMap.get(node.name);
      if (poi?.location) {
        node.location = poi.location;
        return poi.location;
      }
      
      // 3. 对于酒店相关节点（早餐、回酒店、入住等），使用酒店位置
      const hotelRelatedPatterns = ['早餐', '回酒店', '入住', '酒店'];
      const isHotelRelated = hotelRelatedPatterns.some(p => 
        node.name.includes(p) || node.activity?.includes(p)
      ) || node.timeSlot === 'breakfast' || node.timeSlot === 'hotel' || node.type === 'hotel';
      
      if (isHotelRelated && hotelLocation) {
        node.location = hotelLocation;
        console.log(`Using hotel location for "${node.name}": ${hotelLocation}`);
        return hotelLocation;
      }
      
      // 4. 跳过泛指名称的搜索（如"返程"、"抵达"等）
      const skipPatterns = ['返程', '抵达', '机场', '火车站'];
      if (skipPatterns.some(p => node.name.includes(p)) || node.type === 'transport') {
        return undefined;
      }
      
      // 5. 通过高德搜索获取位置
      if (city) {
        try {
          // 尝试精确搜索
          let pois = await amapClient.searchPOI({
            keywords: node.name,
            city,
            pageSize: 1,
          });
          
          // 如果没找到，尝试用地址搜索
          if (pois.length === 0 && node.address) {
            pois = await amapClient.searchPOI({
              keywords: node.address,
              city,
              pageSize: 1,
            });
          }
          
          if (pois.length > 0 && pois[0].location) {
            // 验证搜索结果是否在目标城市
            const resultCity = pois[0].city || '';
            if (city && !resultCity.includes(city.replace('市', '')) && !city.includes(resultCity.replace('市', ''))) {
              console.warn(`POI "${pois[0].name}" is in ${resultCity}, not in ${city}, skipping`);
              return undefined;
            }
            node.location = pois[0].location;
            console.log(`Found location for "${node.name}" via search: ${pois[0].location} (${pois[0].city})`);
            return pois[0].location;
          } else {
            console.warn(`No location found for "${node.name}" in ${city}`);
          }
        } catch (error) {
          console.warn(`Failed to search location for ${node.name}:`, error);
        }
      }
      
      return undefined;
    };

    // 为每天的节点计算距离
    for (const [day, dayNodes] of nodesByDay) {
      // 按 order 排序
      dayNodes.sort((a, b) => a.order - b.order);

      // 串行获取所有节点的位置（避免并发过高触发高德 API 限流）
      for (const node of dayNodes) {
        await getNodeLocation(node);
        // 每次搜索后延迟，避免 QPS 超限
        await this.delay(400);
      }
      
      // 记录哪些节点缺少位置
      const nodesWithoutLocation = dayNodes.filter(n => !n.location);
      if (nodesWithoutLocation.length > 0) {
        console.warn(`Day ${day}: ${nodesWithoutLocation.length} nodes without location:`, 
          nodesWithoutLocation.map(n => n.name).join(', '));
      }

      // 计算相邻节点之间的距离
      for (let i = 0; i < dayNodes.length - 1; i++) {
        const currentNode = dayNodes[i];
        const nextNode = dayNodes[i + 1];

        if (currentNode.location && nextNode.location) {
          const distance = amapClient.calculateDistance(currentNode.location, nextNode.location);
          currentNode.distanceToNext = distance;
          console.log(`Distance from "${currentNode.name}" to "${nextNode.name}": ${distance}km`);
        } else {
          console.warn(`Cannot calculate distance: "${currentNode.name}" (loc: ${currentNode.location ? 'yes' : 'NO'}) -> "${nextNode.name}" (loc: ${nextNode.location ? 'yes' : 'NO'})`);
        }
      }
    }

    return nodes;
  }

  /**
   * 为节点计算到下一个节点的距离（通过高德 API 搜索获取位置）
   * 用于 updateWithPreference 等没有 POI 映射的场景
   * @param nodes 节点数组
   * @param city 城市名称
   */
  private async calculateDistancesWithSearch(
    nodes: TravelNode[],
    city: string
  ): Promise<TravelNode[]> {
    // 直接调用 calculateDistances，传入空的 poiMap 和城市名
    return this.calculateDistances(nodes, new Map(), city);
  }

  /**
   * Generates an itinerary for a destination based on search conditions
   * Uses Amap API for real POI data
   * Requirements: 3.2, 3.6
   */
  async generateItinerary(
    tripId: string,
    destination: string,
    conditions: SearchConditions,
    days: number,
    usePipeline: boolean = true  // 使用新的管道架构
  ): Promise<Itinerary> {
    try {
      // 检查是否已存在行程
      const existingItinerary = await storageService.getItinerary(tripId);
      const itineraryId = existingItinerary?.id || uuidv4();

      // 获取开始日期
      const startDate = conditions.startDate;
      console.log('generateItinerary - startDate from conditions:', startDate);

      // 1. 从高德获取真实 POI 数据
      console.log(`Fetching POIs for ${destination}...`);
      
      const [hotels, restaurants, attractions] = await Promise.all([
        poiService.searchHotelsByPreference(destination, {
          budgetLevel: conditions.budgetLevel,
          style: conditions.travelStyle,
        }),
        poiService.searchRestaurantsByPreference(destination, {
          foodPreferences: conditions.foodPreferences,
          budgetLevel: conditions.budgetLevel,
        }, days),
        poiService.searchAttractionsByPreference(destination, {
          activityTypes: conditions.activityTypes,
        }, days),
      ]);

      console.log(`Found: ${hotels.length} hotels, ${restaurants.length} restaurants, ${attractions.length} attractions`);

      // 创建 POI 名称到详情的映射（用于距离计算）
      const poiMap = new Map<string, EnrichedPOI>();
      [...hotels, ...restaurants, ...attractions].forEach(poi => {
        poiMap.set(poi.name, poi);
      });

      let nodes: TravelNode[];

      // 使用新的管道架构
      if (usePipeline && attractions.length >= 3) {
        console.log('Using new pipeline architecture...');
        const { itineraryPipeline } = await import('./itineraryPipeline');
        nodes = await itineraryPipeline.generateOptimizedItinerary(
          destination,
          conditions,
          days,
          { hotels, restaurants, attractions }
        );
      } else {
        // 回退到原有方式
        console.log('Using legacy AI organization...');
        
        // 对 POI 进行空间聚类
        const clusterResult = clusterService.clusterPOIs(
          attractions, restaurants, hotels, days, 8
        );

        nodes = await this.organizeItineraryWithAI(
          destination,
          conditions,
          days,
          { hotels, restaurants, attractions }
        );

        // 计算距离
        nodes = await this.calculateDistances(nodes, poiMap, destination);

        // 路径优化
        const hotelNode = nodes.find(n => n.type === 'hotel');
        const hotelLocation = hotelNode?.location || poiMap.get(hotelNode?.name || '')?.location;
        const { routeOptimizer } = await import('./routeOptimizer');
        nodes = routeOptimizer.optimizeFullItinerary(nodes, hotelLocation);
        nodes = await this.calculateDistances(nodes, poiMap, destination);
      }

      // [暂时禁用] 验证路线合理性并修复（最多尝试5次）
      // TODO: 距离检查暂时隐藏，等酒店优化稳定后再启用
      // console.log('Validating route reasonability...');
      // let routeValidation = this.validateRouteReasonability(nodes);
      // let fixAttempts = 0;
      // const maxFixAttempts = 5;
      // 
      // while (!routeValidation.valid && fixAttempts < maxFixAttempts) {
      //   fixAttempts++;
      //   console.warn(`Route has issues (attempt ${fixAttempts}/${maxFixAttempts}):`, routeValidation.issues);
      //   routeValidation.issues.forEach(issue => console.warn(`  - ${issue}`));
      //   
      //   console.log(`Attempting to fix distance issues (attempt ${fixAttempts})...`);
      //   nodes = await this.fixDistanceIssues(nodes, destination, days);
      //   nodes = await this.calculateDistances(nodes, poiMap, destination);
      //   routeValidation = this.validateRouteReasonability(nodes);
      // }
      // 
      // if (!routeValidation.valid) {
      //   console.warn('Route still has issues after all fix attempts:', routeValidation.issues);
      // } else {
      //   console.log('Route validation passed!');
      // }

      // 注意：酒店优化已移至 itineraryPipeline.planHotelStrategy 中
      // 不再在这里进行二次优化，因为会破坏多酒店策略
      // console.log('Optimizing hotel selection based on attraction locations...');
      // const { itineraryPipeline } = await import('./itineraryPipeline');
      // nodes = await itineraryPipeline.optimizeHotelSelection(nodes, destination, hotels);

      const itinerary: Itinerary = {
        id: itineraryId,
        tripId,
        destination,
        totalDays: days,
        startDate,
        nodes,
        userPreferences: existingItinerary?.userPreferences || [],
        lastUpdated: new Date(),
      };

      // Save to database
      await storageService.saveItinerary(itinerary);

      return itinerary;
    } catch (error: any) {
      // 可重试的错误（如酒店找不到）：重试一次，不直接 fallback
      const isRetryable = error?.message?.startsWith('HOTEL_NOT_FOUND') || 
        error?.message?.includes('Cannot read properties of undefined');
      
      if (isRetryable && !this._isRetrying) {
        console.warn(`Retryable error, attempting once more:`, error?.message);
        this._isRetrying = true;
        try {
          const result = await this.generateItinerary(tripId, destination, conditions, days, usePipeline);
          this._isRetrying = false;
          return result;
        } catch (retryError) {
          this._isRetrying = false;
          console.error('Retry also failed:', retryError);
        }
      }
      
      console.error('Failed to generate itinerary:', error);
      // 重试也失败了，才回退到纯 AI 生成
      return this.generateItineraryWithAIOnly(tripId, destination, conditions, days);
    }
  }

  /**
   * 使用 AI 组织从高德获取的 POI 数据
   * 核心改进：基于区域聚类规划，确保每天的行程在同一区域内，避免长距离移动
   */
  private async organizeItineraryWithAI(
    destination: string,
    conditions: SearchConditions,
    days: number,
    pois: {
      hotels: EnrichedPOI[];
      restaurants: EnrichedPOI[];
      attractions: EnrichedPOI[];
    }
  ): Promise<TravelNode[]> {
    const { hotels, restaurants, attractions } = pois;

    // 如果 POI 数据不足，回退到纯 AI 生成
    if (attractions.length < 2) {
      console.log('Insufficient POI data (attractions < 2), falling back to AI-only generation');
      throw new Error('POI data insufficient');
    }

    // 解析抵达时间
    const arrivalTime = conditions.arrivalTime || '10:00';
    const arrivalHour = parseInt(arrivalTime.split(':')[0], 10);
    
    // 解析离开时间
    const departureTime = conditions.departureTime || '17:00';
    const departureHour = parseInt(departureTime.split(':')[0], 10);
    
    console.log('organizeItineraryWithAI - arrivalTime:', arrivalTime, 'arrivalHour:', arrivalHour);
    console.log('organizeItineraryWithAI - departureTime:', departureTime, 'departureHour:', departureHour);
    
    // ========== 核心改进：基于区域聚类规划 ==========
    // 1. 对 POI 进行空间聚类（包括酒店）
    console.log('Clustering POIs by geographic location...');
    const clusterResult = clusterService.clusterPOIs(
      attractions,
      restaurants,
      hotels, // 酒店也参与聚类
      days,
      8 // 最大聚类半径 8km
    );
    
    console.log(`Created ${clusterResult.clusters.length} clusters:`);
    clusterResult.clusters.forEach((cluster, i) => {
      console.log(`  Cluster ${i + 1} "${cluster.name}": ${cluster.attractions.length} attractions, ${cluster.restaurants.length} restaurants, ${cluster.hotels.length} hotels, radius ${cluster.radius}km`);
    });
    console.log(`Daily cluster assignment: ${clusterResult.dailyClusterAssignment.join(' -> ')}`);
    
    // 2. 为第一天选择区域内的酒店
    const firstDayClusterId = clusterResult.dailyClusterAssignment[0];
    const firstDayCluster = clusterResult.clusters.find(c => c.id === firstDayClusterId);
    
    // 优先从第一天区域内选择酒店，如果没有则从所有酒店中选择距离该区域最近的
    let selectedHotel: EnrichedPOI | null = null;
    
    if (firstDayCluster && firstDayCluster.hotels.length > 0) {
      // 从区域内的酒店中选择评分最高的
      selectedHotel = firstDayCluster.hotels.reduce((best, h) => 
        (h.rating || 0) > (best.rating || 0) ? h : best, firstDayCluster.hotels[0]);
      console.log(`Selected hotel "${selectedHotel.name}" from first day cluster "${firstDayCluster.name}"`);
    } else {
      // 区域内没有酒店，从所有酒店中选择距离第一天区域中心最近的
      if (firstDayCluster) {
        const clusterCenter = `${firstDayCluster.centroid.lng},${firstDayCluster.centroid.lat}`;
        const hotelsWithDistance = hotels
          .filter(h => h.location)
          .map(h => ({
            hotel: h,
            distance: amapClient.calculateDistance(h.location!, clusterCenter)
          }))
          .sort((a, b) => a.distance - b.distance);
        
        if (hotelsWithDistance.length > 0) {
          selectedHotel = hotelsWithDistance[0].hotel;
          console.log(`No hotel in first day cluster, selected nearest hotel "${selectedHotel.name}" (${hotelsWithDistance[0].distance.toFixed(1)}km from cluster center)`);
        }
      }
      
      // 最后回退
      if (!selectedHotel) {
        selectedHotel = this.selectOptimalHotel(hotels, clusterResult.clusters);
      }
    }
    
    if (!selectedHotel) {
      console.log('No suitable hotel found, falling back to AI-only generation');
      throw new Error('No hotel available');
    }
    
    // 3. 计算酒店到各聚类的距离（用于日志和参考）
    const hotelLocation = selectedHotel.location!;
    const clusterDistancesFromHotel = clusterResult.clusters.map(cluster => {
      const clusterCenter = `${cluster.centroid.lng},${cluster.centroid.lat}`;
      return {
        cluster,
        distance: amapClient.calculateDistance(hotelLocation, clusterCenter)
      };
    }).sort((a, b) => a.distance - b.distance);
    
    console.log('Cluster distances from selected hotel:');
    clusterDistancesFromHotel.forEach(({ cluster, distance }) => {
      console.log(`  ${cluster.name}: ${distance.toFixed(1)}km`);
    });
    
    // 4. 根据抵达/离开时间生成行程指导
    let firstDayGuidance = '';
    if (arrivalHour >= 21) {
      firstDayGuidance = `用户抵达时间较晚（${arrivalTime}），第一天只安排：抵达机场/火车站 → 入住酒店。不要安排其他活动。`;
    } else if (arrivalHour >= 18) {
      firstDayGuidance = `用户傍晚抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 晚餐 → 晚上活动（如夜景、夜市）→ 回酒店休息。`;
    } else if (arrivalHour >= 14) {
      firstDayGuidance = `用户下午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    } else if (arrivalHour >= 12) {
      firstDayGuidance = `用户中午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 午餐 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    } else {
      firstDayGuidance = `用户上午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 上午景点 → 午餐 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    }

    let lastDayGuidance = '';
    if (departureHour <= 9) {
      lastDayGuidance = `用户离开时间很早（${departureTime}），最后一天只安排：早餐（可选）→ ${departureTime}前往机场/火车站返程。不要安排其他活动。`;
    } else if (departureHour <= 12) {
      lastDayGuidance = `用户上午离开（${departureTime}），最后一天安排：早餐 → 可选的短暂活动 → ${departureTime}前往机场/火车站返程。`;
    } else if (departureHour <= 15) {
      lastDayGuidance = `用户下午早些离开（${departureTime}），最后一天安排：早餐 → 上午景点 → 午餐 → ${departureTime}前往机场/火车站返程。`;
    } else if (departureHour <= 18) {
      lastDayGuidance = `用户下午离开（${departureTime}），最后一天安排：早餐 → 上午景点 → 午餐 → 下午短暂活动 → ${departureTime}前往机场/火车站返程。`;
    } else {
      lastDayGuidance = `用户傍晚/晚上离开（${departureTime}），最后一天可安排较完整行程：早餐 → 上午景点 → 午餐 → 下午景点 → ${departureTime}前往机场/火车站返程。`;
    }

    // 5. 构建基于聚类的 POI 列表（每天只展示该天对应区域的 POI）
    const clusterInfo = clusterService.formatClustersForLLM(clusterResult, days);
    
    // 构建每天的候选 POI 列表
    const dailyPOILists: string[] = [];
    for (let day = 1; day <= days; day++) {
      const { attractions: dayAttractions, restaurants: dayRestaurants, hotels: dayHotels } = 
        clusterService.getClusterPOIsForDay(clusterResult, day);
      
      const clusterId = clusterResult.dailyClusterAssignment[day - 1];
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      const clusterName = cluster?.name || `区域${day}`;
      const distanceFromHotel = clusterDistancesFromHotel.find(d => d.cluster.id === clusterId)?.distance || 0;
      
      // 显示区域内的酒店（如果有的话）
      const hotelInfo = dayHotels.length > 0 
        ? `\n区域内酒店（${dayHotels.length}个）：\n${dayHotels.map((h, i) => `  ${i + 1}. ${h.name} | ${h.address} | ${h.description}`).join('\n')}`
        : '';
      
      dailyPOILists.push(`
【第${day}天 - ${clusterName}】（距酒店约${distanceFromHotel.toFixed(1)}km）
可选景点（${dayAttractions.length}个）：
${dayAttractions.map((a, i) => `  ${i + 1}. ${a.name} | ${a.address} | ${a.description}`).join('\n')}

可选餐厅（${dayRestaurants.length}个）：
${dayRestaurants.map((r, i) => `  ${i + 1}. ${r.name} | ${r.address} | ${r.description}`).join('\n')}${hotelInfo}
`);
    }

    const prompt = `请为${destination}规划一个${days}天的详细行程。

用户偏好：
- 美食偏好：${conditions.foodPreferences?.join('、') || '无特定要求'}
- 活动类型：${conditions.activityTypes?.join('、') || '观光'}
- 预算级别：${conditions.budgetLevel || '中等'}
- 旅行风格：${conditions.travelStyle || '休闲'}
- 抵达时间：${arrivalTime}
- 离开时间：${departureTime}

【已选定酒店】
${selectedHotel.name} | 地址: ${selectedHotel.address} | ${selectedHotel.description}

${clusterInfo}

${dailyPOILists.join('\n')}

**【最重要的规则 - 基于区域聚类规划】**

1. **必须使用已选定的酒店**：${selectedHotel.name}

2. **每天只能从该天对应区域的候选 POI 中选择**：
   - 上面已经按区域划分好了每天的候选景点和餐厅
   - 第1天只能从"第1天"区域的候选列表中选择
   - 第2天只能从"第2天"区域的候选列表中选择
   - 以此类推...
   - 这样可以确保同一天的行程在地理上集中，避免长距离移动

3. **区域内的地点已经很近**：
   - 每个区域内的景点和餐厅距离都在 8km 以内
   - 同一天内的移动距离会很短
   - 只有早上从酒店出发和晚上回酒店时可能距离较远

4. **第一天行程安排**：
   ${firstDayGuidance}
   - 第一天的第一个节点必须是抵达（timeSlot: arrival），时间设为 ${arrivalTime}

5. **最后一天行程安排**：
   ${lastDayGuidance}
   - 最后一天的最后一个节点必须是返程（timeSlot: departure），时间设为 ${departureTime}

6. **每天行程结构**（按时间顺序，除最后一天外每天必须以回酒店结束）:
   - 第一天开头：抵达（如"抵达${destination}机场/火车站"）→ 入住酒店
   - 早餐（07:30-08:30）：去哪里吃什么
   - 上午（09:00-11:30）：游玩什么景点
   - 午餐（12:00-13:00）：去哪里吃什么【必须是正餐餐厅】
   - 下午（14:00-17:00）：游玩景点（可安排1-2个景点，或1景点+1小吃/甜品店）
   - 晚餐（18:00-19:00）：去哪里吃什么【必须是正餐餐厅】
   - 晚上（19:30-21:00）：【必须安排】夜间活动（如夜景、夜市、小吃街、酒吧街等）
   - 回酒店（21:30-22:00）：除最后一天外，每天最后必须安排回酒店休息（timeSlot: hotel）
   - 最后一天结尾：返程（如"前往机场/火车站返程"），最后一天不需要回酒店

7. **餐饮安排规则**（非常重要）：
   - 【所有餐厅不得重复】：整个行程中每家餐厅只能出现一次，不同天、不同餐次必须安排不同的餐厅
   - 【早餐必须是早餐类店铺】：早餐应安排粥店、包子铺、面馆、肠粉店、早茶茶楼、豆浆店等早餐类店铺，不能安排饭店、酒楼、酒家、川菜馆、海鲜店等正餐餐厅
   - 【午餐和晚餐必须是正餐】：必须安排正式的餐厅（如中餐厅、火锅店、特色菜馆等），不能是小吃、糖水、甜品
   - 【小吃的正确安排位置】：
     * 下午时段：可以在下午景点之间穿插一个小吃/甜品/糖水店
     * 晚上时段：晚餐后的夜间活动可以安排逛夜市、小吃街
   - 错误示例：午餐安排"某某糖水铺"、晚餐安排"某某小吃店"、早餐安排"某某酒楼"
   - 正确示例：午餐安排"外婆家(西湖店)"、下午茶安排"某某糖水铺"、早餐安排"某某粥铺"、晚上安排"逛河坊街小吃"

8. **晚上活动必须安排**（非常重要）：
   - 每天晚餐后必须安排晚上活动，不能直接回酒店
   - 晚上活动可以是：夜景观赏、夜市/小吃街、酒吧街、江边/湖边散步、夜游景点等
   - 只有当天行程特别疲惫或目的地确实没有夜间活动时才可省略

9. **节点描述格式**：
   - activity字段：先说要干什么（如"上午：游览西湖景区"、"午餐：品尝杭帮菜"、"抵达：办理入住"）
   - name字段：具体地点名称（如"西湖风景区"、"楼外楼"）
   - description字段：具体推荐内容（如"推荐游览断桥、白堤、苏堤"、"推荐西湖醋鱼、龙井虾仁"）

10. **美食聚集区详细推荐**（非常重要）：
   - 当推荐的是美食街/小吃街/美食聚集区（如永兴坊、回民街、夜市、美食城等）而非具体店铺时
   - description字段必须详细列举该区域的特色小吃和推荐店铺
   - 例如：name="永兴坊", description="推荐：子长煎饼（老王家）、biangbiang面（老碗面馆）、肉夹馍（樊记）、凉皮（魏家凉皮）、羊肉泡馍、甑糕、酸梅汤"
   - 要具体到小吃名称，最好能推荐具体店铺，让用户有明确的选择目标
   - 避免空泛的描述如"品尝各种小吃"、"体验当地美食"

11. **大型景区起点标注**（非常重要）：
   - 当规划的是大型景区/景点（如鼓浪屿、故宫、西湖景区、九寨沟等），由于景区范围大无法用单一地标表示
   - 此时name字段填写的是景区内的一个具体起点位置（如码头、入口、游客中心）
   - 必须设置 isStartingPoint: true，并在 scenicAreaName 字段填写景区名称
   - 例如：游览鼓浪屿时，name="三丘田码头", isStartingPoint=true, scenicAreaName="鼓浪屿"
   - 这样用户就知道这是游览鼓浪屿的起点，而不是只去这个码头

12. **timeSlot时段标识**（必填）：
   - arrival: 抵达
   - breakfast: 早餐
   - morning: 上午游玩
   - lunch: 午餐
   - afternoon: 下午游玩
   - dinner: 晚餐
   - evening: 晚上活动
   - hotel: 入住酒店
   - departure: 返程

13. **价格和实用信息**（必填）：
   - priceInfo：价格信息
     * 餐厅：人均消费，如"人均50元"、"人均80-120元"
     * 酒店：房价范围，如"约400元/晚"、"300-500元/晚"
     * 景点：门票价格，如"门票80元"、"免费"
   - ticketInfo：门票/预约信息（仅景点需要）
     * 如"需提前1天预约"、"现场购票"、"免费免预约"、"需提前在官网预约"
   - tips：实用小贴士（可选）
     * 如"建议早上9点前到避开人流"、"周一闭馆"、"推荐点招牌菜"

14. **交通信息**（除第一个节点外必填）：
   - transportMode：交通方式，必须是以下之一：walk（步行）、bus（公交）、subway（地铁）、taxi（打车）、drive（自驾）
   - transportDuration：预计交通时长（分钟）
   - transportNote：简短的交通说明，如"步行约10分钟，沿湖边走"、"地铁2号线3站到西湖站"、"打车约15分钟，建议早高峰避开"

返回JSON数组格式：
[
  {
    "name": "地点名称（必须与列表中完全一致，或合理的交通节点）",
    "type": "attraction/restaurant/hotel/transport",
    "address": "地址",
    "description": "具体推荐内容或说明",
    "activity": "时段+活动描述，如'上午：游览西湖景区'、'午餐：品尝杭帮菜'",
    "timeSlot": "arrival/breakfast/morning/lunch/afternoon/dinner/evening/hotel/departure",
    "estimatedDuration": 推荐游玩/用餐时长（分钟）,
    "scheduledTime": "HH:MM",
    "dayIndex": 第几天,
    "order": 当天顺序（从1开始）,
    "isStartingPoint": false,
    "scenicAreaName": null,
    "priceInfo": "价格信息（餐厅人均/酒店房价/景点门票）",
    "ticketInfo": "门票或预约信息（景点必填）",
    "tips": "实用小贴士（可选）",
    "transportMode": "walk/bus/subway/taxi/drive（从上一地点到此地点的交通方式）",
    "transportDuration": 交通时长分钟数,
    "transportNote": "简短交通说明，如'步行10分钟'、'地铁2号线3站'"
  }
]

注意：
- 对于大型景区，isStartingPoint设为true，scenicAreaName填写景区名称
- priceInfo对于餐厅、酒店、景点都必填
- ticketInfo对于景点必填，说明是否需要预约或购票
- 除了每天第一个节点，其他节点都必须填写交通信息（transportMode、transportDuration、transportNote）

只返回JSON数组，不要其他内容。`;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个专业的旅行规划师。请严格使用提供的POI列表中的地点来组织行程。

【最重要 - 禁止泛指名称】
❌ 绝对禁止的名称格式（会被系统拒绝）：
- "XX景区附近农家菜" / "景区附近餐厅" / "附近农家乐"
- "西樵山农家菜" / "XX山农家菜馆" / "景区农家饭"
- "当地特色餐厅" / "本地餐馆" / "周边饭店"
- "某某酒店" / "附近宾馆" / "景区民宿"

✅ 正确的名称格式（必须有具体品牌/店名）：
- "松记农家菜" / "阿婆私房菜" / "老王农家院"
- "海底捞火锅(佛山店)" / "陶陶居(祖庙店)"
- "佛山希尔顿酒店" / "如家快捷酒店(祖庙店)"

关键要求：
1. 必须确保每天的行程在地理上顺路，根据坐标合理安排顺序
2. 每个节点必须包含activity字段描述要做什么
3. 每个节点必须包含timeSlot字段标识时段
4. 餐厅推荐要说明推荐菜品，并提供人均消费(priceInfo)
5. 景点要说明推荐游览内容，并提供门票价格(priceInfo)和预约信息(ticketInfo)
6. 酒店要提供房价范围(priceInfo)
7. 对于大型景区（如鼓浪屿、故宫、西湖等），必须设置isStartingPoint=true和scenicAreaName字段
8. 对于美食街/小吃街（如永兴坊、回民街等），description必须详细列举推荐的小吃名称和店铺
9. 除每天第一个节点外，其他节点必须包含交通信息（transportMode、transportDuration、transportNote）
10. 【重要】餐厅名称必须是真实存在的具体店名，必须包含品牌名或店主名，不能是"地名+品类"的组合`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    let generatedNodes = await deepseekClient.chatWithJson<GeneratedNode[]>(messages);

    // 验证生成的节点
    console.log('Validating generated nodes...');
    const validation = this.validateGeneratedNodes(generatedNodes, departureTime);
    if (!validation.valid) {
      console.warn('Generated nodes have issues:', validation.issues);
      validation.issues.forEach(issue => console.warn(`  - ${issue}`));
      
      // 检查是否有最后一天相关的问题，如果有则尝试修复
      const hasLastDayIssue = validation.issues.some(issue => 
        issue.includes('最后一天') || issue.includes('返程') || issue.includes('departure')
      );
      
      if (hasLastDayIssue) {
        console.log('Attempting to fix last day issues...');
        generatedNodes = await this.fixLastDayNodes(generatedNodes, destination, departureTime, days);
      }
      
      // 检查是否有泛指名称的问题，如果有则尝试修复
      const hasGenericNameIssue = validation.issues.some(issue => 
        issue.includes('泛指名称')
      );
      
      if (hasGenericNameIssue) {
        console.log('Attempting to fix generic name issues...');
        generatedNodes = await this.fixGenericNameNodes(generatedNodes, destination);
        
        // 再次检查是否还有泛指名称
        const remainingGeneric = generatedNodes.filter(n => 
          n.type !== 'transport' && isGenericName(n.name, n.type)
        );
        if (remainingGeneric.length > 0) {
          console.warn(`Still have ${remainingGeneric.length} generic names after fix:`);
          remainingGeneric.forEach(n => console.warn(`  - "${n.name}" (${n.type})`));
        }
      }
    }

    // 验证每日框架完整性
    console.log('Validating daily framework completeness...');
    const frameworkValidation = this.validateDailyFramework(
      generatedNodes,
      days,
      arrivalTime,
      departureTime
    );
    
    if (!frameworkValidation.valid) {
      console.warn('Daily framework has missing slots:', frameworkValidation.issues);
      frameworkValidation.issues.forEach(issue => console.warn(`  - ${issue}`));
      
      // 尝试修复缺失的环节
      if (frameworkValidation.missingSlots.length > 0) {
        console.log('Attempting to fix missing slots...');
        generatedNodes = await this.fixMissingSlots(
          generatedNodes,
          frameworkValidation.missingSlots,
          destination
        );
      }
    }

    // 创建 POI 名称到详情的映射
    const poiMap = new Map<string, EnrichedPOI>();
    [...hotels, ...restaurants, ...attractions].forEach(poi => {
      poiMap.set(poi.name, poi);
    });

    // 去重餐厅名称
    this.deduplicateGeneratedRestaurants(generatedNodes, restaurants);
    // 转换为 TravelNode，尽量使用真实 POI 数据
    return generatedNodes.map((node) => {
      const realPOI = poiMap.get(node.name);
      
      return {
        id: uuidv4(),
        itineraryId: '',
        name: node.name,
        type: normalizeNodeType(node.type),
        address: realPOI?.address || node.address || '',
        description: node.description || realPOI?.description || '',
        activity: node.activity || '',
        timeSlot: node.timeSlot || '',
        estimatedDuration: node.estimatedDuration || 60,
        scheduledTime: node.scheduledTime || '09:00',
        dayIndex: node.dayIndex || 1,
        order: node.order || 1,
        verified: !!realPOI, // 如果是真实 POI，标记为已验证
        isLit: false,
        isStartingPoint: node.isStartingPoint || false,
        scenicAreaName: node.scenicAreaName || undefined,
        priceInfo: node.priceInfo || undefined,
        ticketInfo: node.ticketInfo || undefined,
        tips: node.tips || undefined,
        transportMode: node.transportMode || undefined,
        transportDuration: node.transportDuration || undefined,
        transportNote: node.transportNote || undefined,
      };
    });
  }

  /**
   * 纯 AI 生成行程（回退方案）
   */
  private async generateItineraryWithAIOnly(
    tripId: string,
    destination: string,
    conditions: SearchConditions,
    days: number
  ): Promise<Itinerary> {
    console.log('Using AI-only generation as fallback');
    
    const prompt = this.buildItineraryGenerationPrompt(destination, conditions, days);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `你是一个专业的旅行规划师，擅长为用户制定详细、实用的旅行行程。

【最重要 - 禁止泛指名称】
❌ 绝对禁止的名称格式（会被系统拒绝）：
- "XX景区附近农家菜" / "景区附近餐厅" / "附近农家乐"
- "西樵山农家菜" / "XX山农家菜馆" / "景区农家饭"
- "当地特色餐厅" / "本地餐馆" / "周边饭店"
- "某某酒店" / "附近宾馆" / "景区民宿"

✅ 正确的名称格式（必须有具体品牌/店名）：
- "松记农家菜" / "阿婆私房菜" / "老王农家院"
- "海底捞火锅(佛山店)" / "陶陶居(祖庙店)"
- "佛山希尔顿酒店" / "如家快捷酒店(祖庙店)"

请根据用户的需求生成结构化的行程安排，确保：
1. 每天的行程必须按地理位置顺路安排，不能上午去城市东边下午又去西边
2. 包含早中晚餐的餐厅推荐，并说明推荐菜品和人均消费(priceInfo)
3. 考虑用户的偏好（如美食、气候、活动类型等）
4. 每个节点都有具体的地址和预计停留时间
5. 按天分组，每天的节点按时间顺序排列
6. 每个节点必须包含activity字段（描述要做什么）和timeSlot字段（时段标识）
7. 对于大型景区（如鼓浪屿、故宫、西湖等），必须设置isStartingPoint=true和scenicAreaName字段
8. 对于美食街/小吃街（如永兴坊、回民街等），description必须详细列举推荐的小吃名称和店铺
9. 景点必须提供门票价格(priceInfo)和预约信息(ticketInfo)
10. 酒店必须提供房价范围(priceInfo)
11. 【重要】餐厅名称必须是真实存在的具体店名，必须包含品牌名或店主名，不能是"地名+品类"的组合`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    let generatedNodes = await deepseekClient.chatWithJson<GeneratedNode[]>(messages);

    // 验证生成的节点
    console.log('Validating generated nodes (AI-only)...');
    const validation = this.validateGeneratedNodes(generatedNodes, conditions.departureTime);
    if (!validation.valid) {
      console.warn('Generated nodes have issues:', validation.issues);
      validation.issues.forEach(issue => console.warn(`  - ${issue}`));
      
      // 检查是否有最后一天相关的问题
      const hasLastDayIssue = validation.issues.some(issue => 
        issue.includes('最后一天') || issue.includes('返程') || issue.includes('departure')
      );
      
      if (hasLastDayIssue && conditions.departureTime) {
        console.log('Attempting to fix last day issues (AI-only)...');
        generatedNodes = await this.fixLastDayNodes(generatedNodes, destination, conditions.departureTime, days);
      }
      
      // 检查是否有泛指名称的问题
      const hasGenericNameIssue = validation.issues.some(issue => 
        issue.includes('泛指名称')
      );
      
      if (hasGenericNameIssue) {
        console.log('Attempting to fix generic name issues (AI-only)...');
        generatedNodes = await this.fixGenericNameNodes(generatedNodes, destination);
      }
    }

    // 验证每日框架完整性
    console.log('Validating daily framework completeness (AI-only)...');
    const frameworkValidation = this.validateDailyFramework(
      generatedNodes,
      days,
      conditions.arrivalTime,
      conditions.departureTime
    );
    
    if (!frameworkValidation.valid) {
      console.warn('Daily framework has missing slots:', frameworkValidation.issues);
      frameworkValidation.issues.forEach(issue => console.warn(`  - ${issue}`));
      
      // 尝试修复缺失的环节
      if (frameworkValidation.missingSlots.length > 0) {
        console.log('Attempting to fix missing slots (AI-only)...');
        generatedNodes = await this.fixMissingSlots(
          generatedNodes,
          frameworkValidation.missingSlots,
          destination
        );
      }
    }

    const existingItinerary = await storageService.getItinerary(tripId);
    const itineraryId = existingItinerary?.id || uuidv4();

    // 去重餐厅名称（AI-only 路径没有 POI 列表，传空数组）
    this.deduplicateGeneratedRestaurants(generatedNodes, []);

    // 获取开始日期
    const startDate = conditions.startDate;

    const nodes: TravelNode[] = generatedNodes.map((node) => ({
      id: uuidv4(),
      itineraryId: itineraryId,
      name: node.name,
      type: normalizeNodeType(node.type),
      address: node.address || '',
      description: node.description || '',
      activity: node.activity || '',
      timeSlot: node.timeSlot || '',
      estimatedDuration: node.estimatedDuration || 60,
      scheduledTime: node.scheduledTime || '09:00',
      dayIndex: node.dayIndex || 1,
      order: node.order || 1,
      verified: false,
      isLit: false,
      isStartingPoint: node.isStartingPoint || false,
      scenicAreaName: node.scenicAreaName || undefined,
      priceInfo: node.priceInfo || undefined,
      ticketInfo: node.ticketInfo || undefined,
      tips: node.tips || undefined,
      transportMode: node.transportMode || undefined,
      transportDuration: node.transportDuration || undefined,
      transportNote: node.transportNote || undefined,
    }));

    const itinerary: Itinerary = {
      id: itineraryId,
      tripId,
      destination,
      totalDays: days,
      startDate,
      nodes,
      userPreferences: existingItinerary?.userPreferences || [],
      lastUpdated: new Date(),
    };

    // 计算节点间距离和交通信息（AI-only 路径也需要）
    try {
      console.log('Calculating distances for AI-only generated nodes...');
      const updatedNodes = await this.calculateDistancesWithSearch(nodes, destination);
      itinerary.nodes = updatedNodes;
    } catch (distError) {
      console.warn('Failed to calculate distances for AI-only nodes:', distError);
    }

    await storageService.saveItinerary(itinerary);

    return itinerary;
  }


  /**
   * Updates itinerary based on user's natural language preference
   * Requirements: 3.2, 3.3
   * 
   * 使用 pipeline 的统一算法逻辑：
   * - LLM 只负责：解析用户意图、生成回复文案
   * - 算法负责：POI 搜索、路径优化、距离计算
   */
  async updateWithPreference(
    itinerary: Itinerary,
    userMessage: string,
    chatHistory: ChatHistoryMessage[]
  ): Promise<ItineraryUpdateResult> {
    try {
      console.log('Using itineraryPipeline.updateItineraryWithChat for chat modification...');
      
      const result = await itineraryPipeline.updateItineraryWithChat(
        itinerary.nodes || [],
        itinerary.destination,
        userMessage,
        chatHistory.map(h => ({ role: h.role, content: h.content }))
      );
      
      if (result.nodes !== itinerary.nodes) {
        // 更新节点 ID 和 itineraryId
        const updatedNodes = result.nodes.map(node => ({
          ...node,
          id: node.id || uuidv4(),
          itineraryId: itinerary.id,
        }));
        
        itinerary.nodes = updatedNodes;
        itinerary.lastUpdated = new Date();
        
        await storageService.saveItinerary(itinerary);
        console.log('Itinerary saved with', itinerary.nodes.length, 'nodes (via pipeline)');
      }
      
      return {
        itinerary: {
          ...itinerary,
          nodes: itinerary.nodes || [],
        },
        response: result.response,
      };
    } catch (error) {
      console.error('Failed to update itinerary with preference:', error);
      
      let errorMessage = '抱歉，我暂时无法处理您的请求。';
      if (error instanceof Error) {
        if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
          errorMessage = '请求超时，请稍后再试。';
        } else if (error.message.includes('JSON')) {
          errorMessage = 'AI 返回格式有误，请尝试用更简单的方式描述您的需求。';
        } else if (error.message.includes('429')) {
          errorMessage = '请求过于频繁，请稍后再试。';
        }
      }
      
      return {
        itinerary: {
          ...itinerary,
          nodes: itinerary.nodes || [],
        },
        response: errorMessage,
      };
    }
  }

  /**
   * Verifies a travel node using Tavily search
   * Requirements: 3.3
   */
  async verifyNode(node: TravelNode, city: string): Promise<TravelNode> {
    try {
      const verification = await tavilyClient.verifyPlace(node.name, city);

      const updatedNode: TravelNode = {
        ...node,
        verified: verification.exists,
        verificationInfo: verification.exists
          ? `地址: ${verification.address || '未知'}, 营业时间: ${verification.openingHours || '未知'}, 评分: ${verification.rating || '未知'}`
          : '无法验证该地点的真实性，请自行确认',
      };

      return updatedNode;
    } catch (error) {
      console.error('Failed to verify node:', error);
      return {
        ...node,
        verified: false,
        verificationInfo: '验证服务暂时不可用，请自行确认',
      };
    }
  }

  /**
   * Manually updates a specific node in the itinerary
   * Requirements: 3.5
   */
  async manualUpdateNode(
    tripId: string,
    nodeId: string,
    updates: Partial<TravelNode>
  ): Promise<TravelNode | null> {
    const itinerary = await storageService.getItinerary(tripId);
    if (!itinerary) {
      return null;
    }

    const nodeIndex = itinerary.nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex === -1) {
      return null;
    }

    // Update the node with provided changes
    const oldNode = itinerary.nodes[nodeIndex];
    const updatedNode: TravelNode = {
      ...oldNode,
      ...updates,
      id: nodeId, // Ensure ID is not changed
      itineraryId: itinerary.id, // Ensure itinerary ID is not changed
    };
    
    // 如果更新了 name 但没有更新 activity，同步更新 activity 以保持一致
    if (updates.name && !updates.activity && oldNode.activity) {
      updatedNode.activity = oldNode.activity.replace(oldNode.name, updates.name);
    }

    itinerary.nodes[nodeIndex] = updatedNode;
    itinerary.lastUpdated = new Date();

    await storageService.saveItinerary(itinerary);

    return updatedNode;
  }


  /**
   * Gets an itinerary by trip ID
   */
  async getItinerary(tripId: string): Promise<Itinerary | null> {
    return storageService.getItinerary(tripId);
  }

  /**
   * Builds the prompt for itinerary generation
   */
  private buildItineraryGenerationPrompt(
    destination: string,
    conditions: SearchConditions,
    days: number
  ): string {
    const features = conditions.geographicFeatures?.join('、') || '无特定要求';
    const climate = conditions.climatePreference || '无特定要求';
    const food = conditions.foodPreferences?.join('、') || '无特定要求';
    const activities = conditions.activityTypes?.join('、') || '观光、美食';
    const budget = conditions.budgetLevel || '中等';
    const style = conditions.travelStyle || '休闲';
    const arrivalTime = conditions.arrivalTime || '10:00';
    const arrivalHour = parseInt(arrivalTime.split(':')[0], 10);
    
    // 解析离开时间
    const departureTime = conditions.departureTime || '17:00';
    const departureHour = parseInt(departureTime.split(':')[0], 10);
    
    console.log('buildItineraryGenerationPrompt - arrivalTime:', arrivalTime, 'arrivalHour:', arrivalHour);
    console.log('buildItineraryGenerationPrompt - departureTime:', departureTime, 'departureHour:', departureHour);
    
    // 根据抵达时间生成第一天行程规划指导（抵达后必须先入住酒店）
    let firstDayGuidance = '';
    if (arrivalHour >= 21) {
      firstDayGuidance = `用户抵达时间较晚（${arrivalTime}），第一天只安排：抵达机场/火车站 → 入住酒店。不要安排其他活动。`;
    } else if (arrivalHour >= 18) {
      firstDayGuidance = `用户傍晚抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 晚餐 → 晚上活动（如夜景、夜市）→ 回酒店休息。`;
    } else if (arrivalHour >= 14) {
      firstDayGuidance = `用户下午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    } else if (arrivalHour >= 12) {
      firstDayGuidance = `用户中午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 午餐 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    } else {
      firstDayGuidance = `用户上午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 上午景点 → 午餐 → 下午景点 → 晚餐 → 晚上活动 → 回酒店休息。`;
    }

    // 根据离开时间生成最后一天行程规划指导
    let lastDayGuidance = '';
    if (departureHour <= 9) {
      lastDayGuidance = `用户离开时间很早（${departureTime}），最后一天只安排：早餐（可选）→ ${departureTime}前往机场/火车站返程。不要安排其他活动。`;
    } else if (departureHour <= 12) {
      lastDayGuidance = `用户上午离开（${departureTime}），最后一天安排：早餐 → 可选的短暂活动 → ${departureTime}前往机场/火车站返程。`;
    } else if (departureHour <= 15) {
      lastDayGuidance = `用户下午早些离开（${departureTime}），最后一天安排：早餐 → 上午景点 → 午餐 → ${departureTime}前往机场/火车站返程。`;
    } else if (departureHour <= 18) {
      lastDayGuidance = `用户下午离开（${departureTime}），最后一天安排：早餐 → 上午景点 → 午餐 → 下午短暂活动 → ${departureTime}前往机场/火车站返程。`;
    } else {
      lastDayGuidance = `用户傍晚/晚上离开（${departureTime}），最后一天可安排较完整行程：早餐 → 上午景点 → 午餐 → 下午景点 → ${departureTime}前往机场/火车站返程。`;
    }

    return `请为我规划一个${days}天的${destination}旅行行程。

用户偏好：
- 地理特征偏好：${features}
- 气候偏好：${climate}
- 美食偏好：${food}
- 活动类型：${activities}
- 预算级别：${budget}
- 旅行风格：${style}
- 抵达时间：${arrivalTime}
- 离开时间：${departureTime}

**【核心原则 - 必须遵守】**
所有餐厅、酒店、景点的name字段必须是真实存在的具体名称，绝对不允许使用泛指或品类名称！

❌ 错误示例：
- "佛山农家乐"（这是品类，不是具体店名）
- "当地特色餐厅"（泛指）
- "市中心酒店"（泛指）
- "某某区美食"（泛指）
- "川菜馆"（品类）

✅ 正确示例：
- "陈麻婆豆腐(总店)"（具体店名）
- "海底捞火锅(春熙路店)"（具体店名+分店）
- "成都香格里拉大酒店"（具体酒店名）
- "全季酒店(宽窄巷子店)"（具体酒店+分店）

**极其重要的规划要求：**

0. **第一天行程安排**（根据抵达时间）：
   ${firstDayGuidance}
   - 第一天的第一个节点必须是抵达（timeSlot: arrival），时间设为 ${arrivalTime}
   - 根据抵达时间合理安排第一天剩余时间的活动，不要浪费时间也不要安排过满

0.5 **最后一天行程安排**（根据离开时间）：
   ${lastDayGuidance}
   - 最后一天的最后一个节点必须是返程（timeSlot: departure），时间设为 ${departureTime}
   - 根据离开时间合理安排最后一天的活动，确保有足够时间前往机场/火车站

1. **路线顺路原则**：每天的行程必须按地理位置顺路安排！
   - 确保同一天内的景点在地理上相近或沿途顺路
   - 不能上午去城市东边，下午又跑到城市西边
   - 优先安排同一区域的景点在同一天游览

2. **每天行程结构**（按时间顺序，除最后一天外每天必须以回酒店结束）：
   - 第一天开头：抵达（如"抵达${destination}机场/火车站"）→ 入住酒店
   - 早餐（07:30-08:30）：去哪里吃什么
   - 上午（09:00-11:30）：游玩什么景点
   - 午餐（12:00-13:00）：去哪里吃什么【必须是正餐餐厅】
   - 下午（14:00-17:00）：游玩景点（可安排1-2个景点，或1景点+1小吃/甜品店）
   - 晚餐（18:00-19:00）：去哪里吃什么【必须是正餐餐厅】
   - 晚上（19:30-21:00）：【必须安排】夜间活动（如夜景、夜市、小吃街、酒吧街等）
   - 回酒店（21:30-22:00）：除最后一天外，每天最后必须安排回酒店休息（timeSlot: hotel）
   - 最后一天结尾：返程（如"前往机场/火车站返程"），最后一天不需要回酒店

3. **餐饮安排规则**（非常重要）：
   - 【所有餐厅不得重复】：整个行程中每家餐厅只能出现一次，不同天、不同餐次必须安排不同的餐厅
   - 【早餐必须是早餐类店铺】：早餐应安排粥店、包子铺、面馆、肠粉店、早茶茶楼、豆浆店等早餐类店铺，不能安排饭店、酒楼、酒家、川菜馆、海鲜店等正餐餐厅
   - 【午餐和晚餐必须是正餐】：必须安排正式的餐厅（如中餐厅、火锅店、特色菜馆等），不能是小吃、糖水、甜品
   - 【小吃的正确安排位置】：
     * 下午时段：可以在下午景点之间穿插一个小吃/甜品/糖水店
     * 晚上时段：晚餐后的夜间活动可以安排逛夜市、小吃街
   - 错误示例：午餐安排"某某糖水铺"、晚餐安排"某某小吃店"、早餐安排"某某酒楼"
   - 正确示例：午餐安排"外婆家(西湖店)"、下午茶安排"某某糖水铺"、早餐安排"某某粥铺"、晚上安排"逛河坊街小吃"

4. **晚上活动必须安排**（非常重要）：
   - 每天晚餐后必须安排晚上活动，不能直接回酒店
   - 晚上活动可以是：夜景观赏、夜市/小吃街、酒吧街、江边/湖边散步、夜游景点等
   - 只有当天行程特别疲惫或目的地确实没有夜间活动时才可省略

5. **节点描述格式**：
   - activity字段：先说要干什么（如"上午：游览西湖景区"、"午餐：品尝杭帮菜"、"抵达：办理入住"）
   - name字段：具体地点名称（如"西湖风景区"、"楼外楼"）
   - description字段：具体推荐内容（如"推荐游览断桥、白堤、苏堤"、"推荐西湖醋鱼、龙井虾仁"）

6. **美食聚集区详细推荐**（非常重要）：
   - 当推荐的是美食街/小吃街/美食聚集区（如永兴坊、回民街、夜市、美食城等）而非具体店铺时
   - description字段必须详细列举该区域的特色小吃和推荐店铺
   - 例如：name="永兴坊", description="推荐：子长煎饼（老王家）、biangbiang面（老碗面馆）、肉夹馍（樊记）、凉皮（魏家凉皮）、羊肉泡馍、甑糕、酸梅汤"
   - 要具体到小吃名称，最好能推荐具体店铺，让用户有明确的选择目标
   - 避免空泛的描述如"品尝各种小吃"、"体验当地美食"

7. **大型景区起点标注**（非常重要）：
   - 当规划的是大型景区/景点（如鼓浪屿、故宫、西湖景区、九寨沟等），由于景区范围大无法用单一地标表示
   - 此时name字段填写的是景区内的一个具体起点位置（如码头、入口、游客中心）
   - 必须设置 isStartingPoint: true，并在 scenicAreaName 字段填写景区名称
   - 例如：游览鼓浪屿时，name="三丘田码头", isStartingPoint=true, scenicAreaName="鼓浪屿"
   - 这样用户就知道这是游览鼓浪屿的起点，而不是只去这个码头

8. **timeSlot时段标识**（必填）：
   - arrival: 抵达
   - breakfast: 早餐
   - morning: 上午游玩
   - lunch: 午餐
   - afternoon: 下午游玩
   - dinner: 晚餐
   - evening: 晚上活动
   - hotel: 入住酒店
   - departure: 返程

9. **价格和实用信息**（必填）：
   - priceInfo：价格信息
     * 餐厅：人均消费，如"人均50元"、"人均80-120元"
     * 酒店：房价范围，如"约400元/晚"、"300-500元/晚"
     * 景点：门票价格，如"门票80元"、"免费"
   - ticketInfo：门票/预约信息（仅景点需要）
     * 如"需提前1天预约"、"现场购票"、"免费免预约"、"需提前在官网预约"
   - tips：实用小贴士（可选）
     * 如"建议早上9点前到避开人流"、"周一闭馆"、"推荐点招牌菜"

10. **交通信息**（除每天第一个节点外必填）：
   - transportMode：交通方式，必须是以下之一：walk（步行）、bus（公交）、subway（地铁）、taxi（打车）、drive（自驾）
   - transportDuration：预计交通时长（分钟）
   - transportNote：简短的交通说明，如"步行约10分钟，沿湖边走"、"地铁2号线3站到西湖站"、"打车约15分钟"

11. **【重要】距离限制 - 必须严格遵守**：
   - 从酒店/早餐出发到第一个景点：最远 15km
   - 中间节点之间（景点→餐厅→景点）：最远 8km，尽量控制在 5km 以内
   - 最后返回酒店或返程：最远 15km
   - 一天总移动距离：控制在 30km 以内，绝对不超过 40km
   
   【禁止的情况】
   ❌ 上午景点 → 午餐距离超过 8km
   ❌ 午餐 → 下午景点距离超过 8km
   ❌ 下午景点 → 晚餐距离超过 8km
   ❌ 一天内出现多次超过 5km 的移动
   ❌ 一天总移动距离超过 40km
   
   【正确做法】
   ✅ 先确定酒店位置，选在景点集中区域
   ✅ 每天的景点都安排在酒店周边 10km 范围内
   ✅ 同一天的景点和餐厅在同一区域（3-5km 范围内）
   ✅ 午餐选择上午景点步行可达的餐厅（1-2km）
   ✅ 晚餐选择下午景点附近的餐厅（1-2km）
   ✅ 优先选择步行可达的相邻景点

请生成一个详细的行程安排，以JSON数组格式返回，每个节点包含：
- name: 具体名称（必须是真实存在的具体店名/景点名，不要用泛指）
- type: 类型，只能是以下四种之一：attraction、restaurant、hotel、transport
- address: 具体详细地址（包含街道门牌号）
- description: 具体推荐内容或说明（美食聚集区要详细列举推荐小吃和店铺）
- activity: 时段+活动描述，如"上午：游览西湖景区"、"午餐：品尝杭帮菜"
- timeSlot: 时段标识（arrival/breakfast/morning/lunch/afternoon/dinner/evening/hotel/departure）
- estimatedDuration: 推荐停留时间（分钟）
- scheduledTime: 计划时间（如"09:00"）
- dayIndex: 第几天（从1开始）
- order: 当天顺序（从1开始）
- isStartingPoint: 是否是大型景区的起点（true/false，默认false）
- scenicAreaName: 如果是起点，填写景区名称（如"鼓浪屿"、"故宫"）
- priceInfo: 价格信息（餐厅人均/酒店房价/景点门票，必填）
- ticketInfo: 门票或预约信息（景点必填）
- tips: 实用小贴士（可选）
- transportMode: 交通方式（walk/bus/subway/taxi/drive，除每天第一个节点外必填）
- transportDuration: 交通时长分钟数（除每天第一个节点外必填）
- transportNote: 简短交通说明（除每天第一个节点外必填）

**【最终检查清单 - 生成前必须自查】**
在返回JSON之前，请逐一检查每个节点：

✓ 餐厅name是否是具体店名？（不是"农家乐"、"川菜馆"、"当地餐厅"等泛指）
✓ 酒店name是否是具体酒店名？（不是"市中心酒店"、"经济型酒店"等泛指）
✓ 景点name是否是真实存在的具体名称？
✓ 地址是否包含区、街道、门牌号？
✓ type字段是否使用英文值（attraction/restaurant/hotel/transport）？
✓ activity和timeSlot字段是否都已填写？
✓ 大型景区是否设置了isStartingPoint=true和scenicAreaName？
✓ 美食街/小吃街的description是否详细列举了推荐小吃和店铺？
✓ priceInfo是否已填写（餐厅人均/酒店房价/景点门票）？
✓ 景点的ticketInfo是否已填写？
✓ 除每天第一个节点外，是否填写了交通信息（transportMode、transportDuration、transportNote）？

如果有任何一项不符合要求，请修正后再返回。

只返回JSON数组，不要其他内容。`;
  }

  /**
   * Formats itinerary for prompt context
   */
  private formatItineraryForPrompt(itinerary: Itinerary): string {
    const nodesByDay = new Map<number, TravelNode[]>();

    for (const node of itinerary.nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }

    let result = `目的地：${itinerary.destination}\n总天数：${itinerary.totalDays}天\n`;
    
    // 添加开始日期
    if (itinerary.startDate) {
      result += `开始日期：${itinerary.startDate}\n`;
    }
    
    // 从第一天的抵达节点获取抵达时间
    const day1Nodes = nodesByDay.get(1) || [];
    const arrivalNode = day1Nodes.find(n => n.timeSlot === 'arrival');
    if (arrivalNode?.scheduledTime) {
      result += `抵达时间：${arrivalNode.scheduledTime}\n`;
    }
    
    // 从最后一天的返程节点获取离开时间
    const lastDayNodes = nodesByDay.get(itinerary.totalDays) || [];
    const departureNode = lastDayNodes.find(n => n.timeSlot === 'departure');
    if (departureNode?.scheduledTime) {
      result += `离开时间：${departureNode.scheduledTime}\n`;
    }
    
    result += '\n';

    for (let day = 1; day <= itinerary.totalDays; day++) {
      const dayNodes = nodesByDay.get(day) || [];
      dayNodes.sort((a, b) => a.order - b.order);

      result += `第${day}天：\n`;
      for (let i = 0; i < dayNodes.length; i++) {
        const node = dayNodes[i];
        result += `  [${node.order}] ${node.scheduledTime} - ${node.name}\n`;
        result += `      活动: ${node.activity || '未指定'}\n`;
        result += `      时段: ${node.timeSlot || '未指定'}\n`;
        result += `      类型: ${node.type}\n`;
        result += `      地址: ${node.address}\n`;
        result += `      描述: ${node.description}\n`;
        result += `      时长: ${node.estimatedDuration}分钟\n`;
        
        // 添加额外字段信息
        if (node.priceInfo) {
          result += `      价格: ${node.priceInfo}\n`;
        }
        if (node.ticketInfo) {
          result += `      门票: ${node.ticketInfo}\n`;
        }
        if (node.tips) {
          result += `      提示: ${node.tips}\n`;
        }
        if (node.transportMode) {
          result += `      交通: ${node.transportMode}，约${node.transportDuration}分钟，${node.transportNote}\n`;
        }
        if (node.isStartingPoint && node.scenicAreaName) {
          result += `      景区起点: ${node.scenicAreaName}\n`;
        }
        // 添加到下一节点的距离
        if (node.distanceToNext && i < dayNodes.length - 1) {
          result += `      → 到下一地点距离: ${node.distanceToNext}公里\n`;
        }
      }
      result += '\n';
    }

    if (itinerary.userPreferences.length > 0) {
      result += `用户已表达的偏好：${itinerary.userPreferences.join('、')}\n`;
    }

    return result;
  }
}

// Export singleton instance
export const itineraryService = new ItineraryService();
