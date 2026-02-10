import { v4 as uuidv4 } from 'uuid';
import { deepseekClient, ChatMessage } from '../clients/deepseekClient';
import { tavilyClient } from '../clients/tavilyClient';
import { storageService, Itinerary, TravelNode, SearchConditions } from './storageService';
import { poiService, EnrichedPOI } from './poiService';

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

export class ItineraryService {
  /**
   * Generates an itinerary for a destination based on search conditions
   * Uses Amap API for real POI data
   * Requirements: 3.2, 3.6
   */
  async generateItinerary(
    tripId: string,
    destination: string,
    conditions: SearchConditions,
    days: number
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
        }),
        poiService.searchAttractionsByPreference(destination, {
          activityTypes: conditions.activityTypes,
        }),
      ]);

      console.log(`Found: ${hotels.length} hotels, ${restaurants.length} restaurants, ${attractions.length} attractions`);

      // 2. 使用 AI 组织行程
      const nodes = await this.organizeItineraryWithAI(
        destination,
        conditions,
        days,
        { hotels, restaurants, attractions }
      );

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
    } catch (error) {
      console.error('Failed to generate itinerary:', error);
      // 如果高德 API 失败，回退到纯 AI 生成
      return this.generateItineraryWithAIOnly(tripId, destination, conditions, days);
    }
  }

  /**
   * 使用 AI 组织从高德获取的 POI 数据
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
    // 放宽条件：只要有一些景点数据就可以继续，餐厅可以由 AI 补充
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
    
    // 根据抵达时间生成第一天行程规划指导
    let firstDayGuidance = '';
    if (arrivalHour >= 21) {
      firstDayGuidance = `用户抵达时间较晚（${arrivalTime}），第一天只安排：抵达机场/火车站 → 入住酒店。不要安排其他活动。`;
    } else if (arrivalHour >= 18) {
      firstDayGuidance = `用户傍晚抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 晚餐 → 可选的夜间活动（如夜景、夜市）。`;
    } else if (arrivalHour >= 14) {
      firstDayGuidance = `用户下午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 下午景点 → 晚餐 → 可选夜间活动。`;
    } else if (arrivalHour >= 12) {
      firstDayGuidance = `用户中午抵达（${arrivalTime}），第一天安排：抵达 → 午餐 → 入住酒店 → 下午景点 → 晚餐 → 可选夜间活动。`;
    } else {
      firstDayGuidance = `用户上午抵达（${arrivalTime}），第一天安排完整行程：抵达 → 上午景点 → 午餐 → 下午景点 → 晚餐 → 入住酒店。`;
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

    // 构建带坐标的POI列表，用于路线优化
    const poiListText = `
可用酒店（请从中选择，注意坐标用于路线规划）：
${hotels.slice(0, 5).map((h, i) => `${i + 1}. ${h.name} | 地址: ${h.address} | 坐标: ${h.location || '未知'} | ${h.description}`).join('\n')}

可用餐厅（请从中选择，注意坐标用于路线规划）：
${restaurants.slice(0, 15).map((r, i) => `${i + 1}. ${r.name} | 地址: ${r.address} | 坐标: ${r.location || '未知'} | ${r.description}`).join('\n')}

可用景点（请从中选择，注意坐标用于路线规划）：
${attractions.slice(0, 15).map((a, i) => `${i + 1}. ${a.name} | 地址: ${a.address} | 坐标: ${a.location || '未知'} | ${a.description}`).join('\n')}
`;

    const prompt = `请为${destination}规划一个${days}天的详细行程。

用户偏好：
- 美食偏好：${conditions.foodPreferences?.join('、') || '无特定要求'}
- 活动类型：${conditions.activityTypes?.join('、') || '观光'}
- 预算级别：${conditions.budgetLevel || '中等'}
- 旅行风格：${conditions.travelStyle || '休闲'}
- 抵达时间：${arrivalTime}
- 离开时间：${departureTime}

${poiListText}

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
   - 根据POI的坐标，确保同一天内的景点在地理上相近或沿途顺路
   - 不能上午去城市东边，下午又跑到城市西边
   - 优先安排同一区域的景点在同一天游览

2. **每天行程结构**（按时间顺序，除最后一天外每天必须以回酒店结束）：
   - 第一天开头：抵达（如"抵达${destination}机场/火车站"，前往酒店办理入住）
   - 早餐（07:30-08:30）：去哪里吃什么
   - 上午（09:00-11:30）：游玩什么景点
   - 午餐（12:00-13:00）：去哪里吃什么
   - 下午（14:00-17:00）：游玩什么景点
   - 晚餐（18:00-19:00）：去哪里吃什么
   - 晚上（19:30-21:00）：夜间活动（如夜景、夜市、酒吧街等，根据目的地特色安排）
   - 回酒店（21:30-22:00）：除最后一天外，每天最后必须安排回酒店休息（timeSlot: hotel）
   - 最后一天结尾：返程（如"前往机场/火车站返程"），最后一天不需要回酒店

3. **节点描述格式**：
   - activity字段：先说要干什么（如"上午：游览西湖景区"、"午餐：品尝杭帮菜"、"抵达：办理入住"）
   - name字段：具体地点名称（如"西湖风景区"、"楼外楼"）
   - description字段：具体推荐内容（如"推荐游览断桥、白堤、苏堤"、"推荐西湖醋鱼、龙井虾仁"）

4. **美食聚集区详细推荐**（非常重要）：
   - 当推荐的是美食街/小吃街/美食聚集区（如永兴坊、回民街、夜市、美食城等）而非具体店铺时
   - description字段必须详细列举该区域的特色小吃和推荐店铺
   - 例如：name="永兴坊", description="推荐：子长煎饼（老王家）、biangbiang面（老碗面馆）、肉夹馍（樊记）、凉皮（魏家凉皮）、羊肉泡馍、甑糕、酸梅汤"
   - 要具体到小吃名称，最好能推荐具体店铺，让用户有明确的选择目标
   - 避免空泛的描述如"品尝各种小吃"、"体验当地美食"

5. **大型景区起点标注**（非常重要）：
   - 当规划的是大型景区/景点（如鼓浪屿、故宫、西湖景区、九寨沟等），由于景区范围大无法用单一地标表示
   - 此时name字段填写的是景区内的一个具体起点位置（如码头、入口、游客中心）
   - 必须设置 isStartingPoint: true，并在 scenicAreaName 字段填写景区名称
   - 例如：游览鼓浪屿时，name="三丘田码头", isStartingPoint=true, scenicAreaName="鼓浪屿"
   - 这样用户就知道这是游览鼓浪屿的起点，而不是只去这个码头

6. **timeSlot时段标识**（必填）：
   - arrival: 抵达
   - breakfast: 早餐
   - morning: 上午游玩
   - lunch: 午餐
   - afternoon: 下午游玩
   - dinner: 晚餐
   - evening: 晚上活动
   - hotel: 入住酒店
   - departure: 返程

7. **价格和实用信息**（必填）：
   - priceInfo：价格信息
     * 餐厅：人均消费，如"人均50元"、"人均80-120元"
     * 酒店：房价范围，如"约400元/晚"、"300-500元/晚"
     * 景点：门票价格，如"门票80元"、"免费"
   - ticketInfo：门票/预约信息（仅景点需要）
     * 如"需提前1天预约"、"现场购票"、"免费免预约"、"需提前在官网预约"
   - tips：实用小贴士（可选）
     * 如"建议早上9点前到避开人流"、"周一闭馆"、"推荐点招牌菜"

8. **交通信息**（除第一个节点外必填）：
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
10. 【重要】所有酒店和餐馆必须使用具体确定的名称，禁止使用"某酒店"、"附近餐馆"、"从可用列表选择"等模糊表述。唯一例外：早餐可以使用"酒店早餐"或"附近小吃"`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const generatedNodes = await deepseekClient.chatWithJson<GeneratedNode[]>(messages);

    // 创建 POI 名称到详情的映射
    const poiMap = new Map<string, EnrichedPOI>();
    [...hotels, ...restaurants, ...attractions].forEach(poi => {
      poiMap.set(poi.name, poi);
    });

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
11. 【重要】所有酒店和餐馆必须使用具体确定的名称，禁止使用"某酒店"、"附近餐馆"、"从可用列表选择"等模糊表述。唯一例外：早餐可以使用"酒店早餐"或"附近小吃"`,
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const generatedNodes = await deepseekClient.chatWithJson<GeneratedNode[]>(messages);

    const existingItinerary = await storageService.getItinerary(tripId);
    const itineraryId = existingItinerary?.id || uuidv4();

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

    await storageService.saveItinerary(itinerary);

    return itinerary;
  }


  /**
   * Updates itinerary based on user's natural language preference
   * Requirements: 3.2, 3.3
   */
  async updateWithPreference(
    itinerary: Itinerary,
    userMessage: string,
    chatHistory: ChatHistoryMessage[]
  ): Promise<ItineraryUpdateResult> {
    const systemPrompt = `你是一个专业的旅行规划师，正在帮助用户优化他们的${itinerary.destination}旅行行程。

【最重要】你必须且只能返回 JSON 格式的响应，不要返回任何其他格式的文本！

当前行程信息：
${this.formatItineraryForPrompt(itinerary)}

用户可能会提出各种修改需求，如：
- 调整餐厅选择（如"我不吃辣"、"想吃海鲜"、"想吃火锅"）
- 增加或删除景点（如"多安排自然风景"、"想去博物馆"）
- 调整时间安排
- 更换住宿

**输出格式要求（必须严格遵守）：**
你的回复必须是一个有效的 JSON 对象，格式如下：
{
  "response": "给用户的回复文本",
  "updatedNodes": [...] 或 null,
  "newPreference": "用户偏好" 或 null
}

**规则：**
1. 用户表达任何偏好或修改意愿时，必须返回 updatedNodes 数组（包含所有节点）
2. 只修改用户要求的部分，其他节点原样保留
3. type 字段只能是：attraction、restaurant、hotel、transport
4. timeSlot 字段只能是：arrival、breakfast、morning、lunch、afternoon、dinner、evening、hotel、departure
5. 所有酒店和餐馆必须使用具体名称

updatedNodes 数组中每个节点的格式：
{
  "name": "地点名称",
  "type": "attraction/restaurant/hotel/transport",
  "address": "地址",
  "description": "描述",
  "activity": "活动描述",
  "timeSlot": "时段",
  "estimatedDuration": 分钟数,
  "scheduledTime": "HH:MM",
  "dayIndex": 天数,
  "order": 顺序
}

记住：只返回 JSON，不要有任何解释性文字！`;

    // Build chat history for context
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add recent chat history (last 10 messages)
    const recentHistory = chatHistory.slice(-10);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Add current user message with JSON reminder
    messages.push({ 
      role: 'user', 
      content: `${userMessage}\n\n【请直接返回 JSON 格式响应，不要有任何其他文字】` 
    });

    try {
      interface UpdateResponse {
        response: string;
        updatedNodes: GeneratedNode[] | null;
        newPreference?: string;
      }

      const result = await deepseekClient.chatWithJson<UpdateResponse>(messages);

      console.log('AI response - has updatedNodes:', !!result.updatedNodes);
      console.log('AI response - updatedNodes count:', result.updatedNodes?.length);
      console.log('AI response - response text:', result.response?.substring(0, 100));
      if (result.updatedNodes && result.updatedNodes.length > 0) {
        console.log('AI response - first raw node:', JSON.stringify(result.updatedNodes[0]));
      }

      // Update itinerary if nodes were modified
      if (result.updatedNodes && result.updatedNodes.length > 0) {
        const updatedNodes: TravelNode[] = result.updatedNodes.map((node, index) => ({
          id: uuidv4(),
          itineraryId: itinerary.id,
          name: node.name || `地点${index + 1}`,
          type: normalizeNodeType(node.type),
          address: node.address || '',
          description: node.description || '',
          activity: node.activity || '',
          timeSlot: node.timeSlot || '',
          estimatedDuration: node.estimatedDuration || 60,
          scheduledTime: node.scheduledTime || '09:00',
          dayIndex: node.dayIndex || 1,
          order: node.order || (index + 1),
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

        itinerary.nodes = updatedNodes;
        itinerary.lastUpdated = new Date();

        // Add new preference if extracted
        if (result.newPreference) {
          itinerary.userPreferences.push(result.newPreference);
        }

        await storageService.saveItinerary(itinerary);
        console.log('Itinerary saved with', itinerary.nodes.length, 'nodes');
        console.log('First saved node:', JSON.stringify(itinerary.nodes[0]));
      } else {
        // 即使没有修改，也确保 itinerary 有完整的 nodes
        console.log('No updates, keeping original itinerary with', itinerary.nodes?.length, 'nodes');
      }

      // 确保返回的 itinerary 始终有 nodes 数组
      return {
        itinerary: {
          ...itinerary,
          nodes: itinerary.nodes || [],
        },
        response: result.response || '已收到您的反馈，行程保持不变。',
      };
    } catch (error) {
      console.error('Failed to update itinerary with preference:', error);
      
      // 根据错误类型提供更具体的提示
      let errorMessage = '抱歉，我暂时无法处理您的请求。';
      
      if (error instanceof Error) {
        if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
          errorMessage = '请求超时，AI 正在思考中，请稍后再试。';
        } else if (error.message.includes('JSON')) {
          errorMessage = 'AI 返回的内容格式有误，请尝试用更简单的方式描述您的需求。';
        } else if (error.message.includes('401') || error.message.includes('403')) {
          errorMessage = 'API 认证失败，请检查配置。';
        } else if (error.message.includes('429')) {
          errorMessage = '请求过于频繁，请稍后再试。';
        } else if (error.message.includes('500') || error.message.includes('502') || error.message.includes('503')) {
          errorMessage = 'AI 服务暂时不可用，请稍后再试。';
        }
      }
      
      // 返回原始行程和错误提示，而不是抛出异常
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
    const updatedNode: TravelNode = {
      ...itinerary.nodes[nodeIndex],
      ...updates,
      id: nodeId, // Ensure ID is not changed
      itineraryId: itinerary.id, // Ensure itinerary ID is not changed
    };

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
    
    // 根据抵达时间生成第一天行程规划指导
    let firstDayGuidance = '';
    if (arrivalHour >= 21) {
      firstDayGuidance = `用户抵达时间较晚（${arrivalTime}），第一天只安排：抵达机场/火车站 → 入住酒店。不要安排其他活动。`;
    } else if (arrivalHour >= 18) {
      firstDayGuidance = `用户傍晚抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 晚餐 → 可选的夜间活动（如夜景、夜市）。`;
    } else if (arrivalHour >= 14) {
      firstDayGuidance = `用户下午抵达（${arrivalTime}），第一天安排：抵达 → 入住酒店 → 下午景点 → 晚餐 → 可选夜间活动。`;
    } else if (arrivalHour >= 12) {
      firstDayGuidance = `用户中午抵达（${arrivalTime}），第一天安排：抵达 → 午餐 → 入住酒店 → 下午景点 → 晚餐 → 可选夜间活动。`;
    } else {
      firstDayGuidance = `用户上午抵达（${arrivalTime}），第一天安排完整行程：抵达 → 上午景点 → 午餐 → 下午景点 → 晚餐 → 入住酒店。`;
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
   - 第一天开头：抵达（如"抵达${destination}机场/火车站"，前往酒店办理入住）
   - 早餐（07:30-08:30）：去哪里吃什么
   - 上午（09:00-11:30）：游玩什么景点
   - 午餐（12:00-13:00）：去哪里吃什么
   - 下午（14:00-17:00）：游玩什么景点
   - 晚餐（18:00-19:00）：去哪里吃什么
   - 晚上（19:30-21:00）：夜间活动（如夜景、夜市、酒吧街等，根据目的地特色安排）
   - 回酒店（21:30-22:00）：除最后一天外，每天最后必须安排回酒店休息（timeSlot: hotel）
   - 最后一天结尾：返程（如"前往机场/火车站返程"），最后一天不需要回酒店

3. **节点描述格式**：
   - activity字段：先说要干什么（如"上午：游览西湖景区"、"午餐：品尝杭帮菜"、"抵达：办理入住"）
   - name字段：具体地点名称（如"西湖风景区"、"楼外楼"）
   - description字段：具体推荐内容（如"推荐游览断桥、白堤、苏堤"、"推荐西湖醋鱼、龙井虾仁"）

4. **美食聚集区详细推荐**（非常重要）：
   - 当推荐的是美食街/小吃街/美食聚集区（如永兴坊、回民街、夜市、美食城等）而非具体店铺时
   - description字段必须详细列举该区域的特色小吃和推荐店铺
   - 例如：name="永兴坊", description="推荐：子长煎饼（老王家）、biangbiang面（老碗面馆）、肉夹馍（樊记）、凉皮（魏家凉皮）、羊肉泡馍、甑糕、酸梅汤"
   - 要具体到小吃名称，最好能推荐具体店铺，让用户有明确的选择目标
   - 避免空泛的描述如"品尝各种小吃"、"体验当地美食"

5. **大型景区起点标注**（非常重要）：
   - 当规划的是大型景区/景点（如鼓浪屿、故宫、西湖景区、九寨沟等），由于景区范围大无法用单一地标表示
   - 此时name字段填写的是景区内的一个具体起点位置（如码头、入口、游客中心）
   - 必须设置 isStartingPoint: true，并在 scenicAreaName 字段填写景区名称
   - 例如：游览鼓浪屿时，name="三丘田码头", isStartingPoint=true, scenicAreaName="鼓浪屿"
   - 这样用户就知道这是游览鼓浪屿的起点，而不是只去这个码头

6. **timeSlot时段标识**（必填）：
   - arrival: 抵达
   - breakfast: 早餐
   - morning: 上午游玩
   - lunch: 午餐
   - afternoon: 下午游玩
   - dinner: 晚餐
   - evening: 晚上活动
   - hotel: 入住酒店
   - departure: 返程

7. **价格和实用信息**（必填）：
   - priceInfo：价格信息
     * 餐厅：人均消费，如"人均50元"、"人均80-120元"
     * 酒店：房价范围，如"约400元/晚"、"300-500元/晚"
     * 景点：门票价格，如"门票80元"、"免费"
   - ticketInfo：门票/预约信息（仅景点需要）
     * 如"需提前1天预约"、"现场购票"、"免费免预约"、"需提前在官网预约"
   - tips：实用小贴士（可选）
     * 如"建议早上9点前到避开人流"、"周一闭馆"、"推荐点招牌菜"

8. **交通信息**（除每天第一个节点外必填）：
   - transportMode：交通方式，必须是以下之一：walk（步行）、bus（公交）、subway（地铁）、taxi（打车）、drive（自驾）
   - transportDuration：预计交通时长（分钟）
   - transportNote：简短的交通说明，如"步行约10分钟，沿湖边走"、"地铁2号线3站到西湖站"、"打车约15分钟"

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

重要要求：
1. type字段必须严格使用英文值：attraction、restaurant、hotel、transport
2. 餐厅必须是具体的店名（如"海底捞火锅(春熙路店)"、"陈麻婆豆腐(总店)"），不要写"当地餐厅"或"某某区美食"
3. 酒店必须是具体的酒店名称（如"成都香格里拉大酒店"、"全季酒店(宽窄巷子店)"），不要写"市中心酒店"
4. 景点必须是真实存在的具体景点名称
5. 地址要尽量详细，包含区、街道、门牌号
6. activity和timeSlot字段必填！
7. 对于大型景区，必须设置isStartingPoint=true和scenicAreaName！
8. 对于美食街/小吃街，description必须详细列举推荐的小吃和店铺！
9. priceInfo对于餐厅、酒店、景点都必填！ticketInfo对于景点必填！
10. 除每天第一个节点外，必须填写交通信息（transportMode、transportDuration、transportNote）！

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

    let result = `目的地：${itinerary.destination}\n总天数：${itinerary.totalDays}天\n\n`;

    for (let day = 1; day <= itinerary.totalDays; day++) {
      const dayNodes = nodesByDay.get(day) || [];
      dayNodes.sort((a, b) => a.order - b.order);

      result += `第${day}天：\n`;
      for (const node of dayNodes) {
        result += `  [${node.order}] ${node.scheduledTime} - ${node.name}\n`;
        result += `      活动: ${node.activity || '未指定'}\n`;
        result += `      时段: ${node.timeSlot || '未指定'}\n`;
        result += `      类型: ${node.type}\n`;
        result += `      地址: ${node.address}\n`;
        result += `      描述: ${node.description}\n`;
        result += `      时长: ${node.estimatedDuration}分钟\n`;
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
