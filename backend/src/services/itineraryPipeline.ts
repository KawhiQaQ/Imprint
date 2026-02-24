/**
 * 行程生成管道 - 职责分离架构
 * 
 * LLM 只负责：喜好、风格、解释
 * 算法负责：顺序、距离、时间可行性
 */

import { v4 as uuidv4 } from 'uuid';
import { deepseekClient, ChatMessage } from '../clients/deepseekClient';
import { amapClient } from '../clients/amapClient';
import { TravelNode, SearchConditions } from './storageService';
import { poiService, EnrichedPOI, TourismRole, ExperienceDomain, CityProfile, AnchorPOI } from './poiService';
import { clusterService, POICluster, ClusterResult } from './clusterService';

interface ScoredPOI {
  poi: EnrichedPOI;
  score: number;
}

interface TimeSlot {
  type: string;
  startTime: string;
  duration: number;
  poiType: 'restaurant' | 'attraction';
  /** 该时段偏好的旅行角色（按优先级排序），仅景点时段有效 */
  preferredRoles?: TourismRole[];
  /** 角色权重：该时段在一天体验曲线中的重要性 */
  roleWeight?: number;
}

interface ScheduledSlot {
  slot: TimeSlot;
  poi: EnrichedPOI | null;
  scheduledTime: string;
  travelTimeFromPrev: number;
  distanceFromPrev: number;
}

interface DaySchedule {
  dayIndex: number;
  slots: ScheduledSlot[];
  totalDistance: number;
}

interface UserIntent {
  hasModification: boolean;
  response: string;
  hotelChange?: { newHotelName: string; originalHotelName?: string; address?: string; priceInfo?: string } | null;
  replacements?: Array<{ dayIndex: number; timeSlot: string; originalName: string; newName: string; priceInfo?: string; searchKeywords?: string[] }>;
  swaps?: Array<{ dayIndexA: number; timeSlotA: string; nameA: string; dayIndexB: number; timeSlotB: string; nameB: string }>;
}

interface AttractionCenter {
  lng: number;
  lat: number;
  avgDistance: number; // 景点到中心的平均距离
}

/**
 * 每日酒店分配信息
 */
interface DailyHotelAssignment {
  dayIndex: number;
  clusterId: string;
  hotel: EnrichedPOI;
  isNewHotel: boolean;
}

/**
 * 每日主题 —— 决定当天行程的整体风格
 */
interface DayTheme {
  dayIndex: number;
  theme: string;           // 主题名称，如 "岭南文化日"
  description: string;     // 主题描述
  /** 该主题偏好的角色（按优先级），用于过滤/加权 POI */
  preferredRoles: TourismRole[];
  /** 该主题偏好的 category 关键词 */
  preferredCategories: string[];
}

/**
 * 体验域配额 —— 硬约束，不是加权
 * 每个 must_have 体验域在行程中至少占多少天
 * 不满足 = 行程不合法，必须修复
 */
interface DomainQuota {
  domain: ExperienceDomain;
  minDays: number;  // 至少占多少天（0.5 = 至少 1 个景点出现）
}

/**
 * 锚点验证结果 —— 锚点未覆盖 = 行程不合法
 * 不是扣分，是失败。
 */
interface AnchorValidation {
  valid: boolean;
  missingAnchors: AnchorPOI[];
  coveredDomains: ExperienceDomain[];
  missingDomains: ExperienceDomain[];
}

/**
 * 体验区域 —— 一个可以步行游览的连片区域
 * 由地理上相近的 POI 聚合而成
 */
interface ExperienceArea {
  id: string;
  name: string;
  centroid: { lng: number; lat: number };
  radius: number;          // 区域半径 km
  attractions: ScoredPOI[];
  restaurants: ScoredPOI[];
  /** 区域的主导角色 */
  dominantRole: TourismRole;
  /** 区域的主导类别 */
  dominantCategory: string;
  /** 区域质量分（基于内部 POI 的平均分和角色分布） */
  qualityScore: number;
}


export class ItineraryPipeline {
  /**
   * 生成优化后的行程
   * 
   * 策略：
   * 1. 短行程（≤3天）：尽量安排在一个区域，最后一天可以跨区
   * 2. 长行程（≥4天）：可以跨区，跨区时换酒店
   */
  async generateOptimizedItinerary(
    destination: string,
    conditions: SearchConditions,
    days: number,
    pois: { hotels: EnrichedPOI[]; restaurants: EnrichedPOI[]; attractions: EnrichedPOI[] }
  ): Promise<TravelNode[]> {
    const { hotels, restaurants, attractions } = pois;

    // 评分（增强版：考虑评分、类型质量）
    const scored = {
      hotels: hotels.map(h => ({ poi: h, score: this.calculatePOIScore(h, 'hotel') })),
      restaurants: restaurants.map(r => ({ poi: r, score: this.calculatePOIScore(r, 'restaurant') })),
      attractions: attractions.map(a => ({ poi: a, score: this.calculatePOIScore(a, 'attraction') }))
    };
    
    // 过滤低质量景点（评分低于 0.3 的不要）
    scored.attractions = scored.attractions.filter(a => a.score >= 0.3);
    
    // 按评分排序，优先使用高评分的 POI
    scored.hotels.sort((a, b) => b.score - a.score);
    scored.restaurants.sort((a, b) => b.score - a.score);
    scored.attractions.sort((a, b) => b.score - a.score);
    
    console.log(`[Pipeline] Scored POIs: ${scored.attractions.length} attractions, ${scored.restaurants.length} restaurants, ${scored.hotels.length} hotels`);
    
    // 输出景点类别分布，方便调试
    const categoryDist: Record<string, number> = {};
    for (const a of scored.attractions) {
      const cat = a.poi.category || 'other';
      categoryDist[cat] = (categoryDist[cat] || 0) + 1;
    }
    console.log(`[Pipeline] Attraction category distribution:`, categoryDist);

    // 聚类
    const clusterResult = clusterService.clusterPOIs(attractions, restaurants, hotels, days, 8);
    
    console.log(`[Pipeline] Trip duration: ${days} days, clusters: ${clusterResult.clusters.length}`);
    console.log(`[Pipeline] Daily cluster assignment: ${clusterResult.dailyClusterAssignment.join(' -> ')}`);

    // Step 1 & 3: 城市体验覆盖模型（硬约束）
    // 先定义"必须被覆盖的体验类型" → 选锚点 → 分配到天
    // 锚点是固定节点，不是候选。缺失 = 行程不合法。
    console.log('[Pipeline] === City Experience Coverage Model ===');
    console.log('[Pipeline] Step 1: Generating city profile (constraint definition)...');
    const cityProfile = await poiService.generateCityProfile(destination);
    console.log(`[Pipeline] Must-have domains: ${cityProfile.mustHave.join(', ')}`);
    console.log(`[Pipeline] Optional domains: ${cityProfile.optional.join(', ')}`);
    
    console.log('[Pipeline] Step 2: Selecting anchors (hard constraints)...');
    const anchors = this.selectAnchors(cityProfile, scored.attractions, days);
    
    console.log('[Pipeline] Step 3: Assigning anchors to days...');
    this.assignAnchorsToDay(anchors, clusterResult, clusterResult.dailyClusterAssignment, days);

    // Step 4: 体验域配额（硬约束 —— 不是加权，是约束）
    // 5天行程 example: 自然景观 >= 1天, 文化 >= 1天, 城市生活 >= 1天
    const domainQuotas = this.generateDomainQuotas(cityProfile, days);
    console.log('[Pipeline] Domain quotas (HARD):', domainQuotas.map(q => `${q.domain}>=${q.minDays}d`).join(', '));

    // 根据行程长度决定酒店策略
    const hotelAssignments = await this.planHotelStrategy(days, clusterResult, hotels, scored.hotels);
    
    console.log('[Pipeline] Hotel assignments:');
    hotelAssignments.forEach(a => {
      console.log(`  Day ${a.dayIndex}: ${a.hotel.name} (cluster: ${a.clusterId}, new: ${a.isNewHotel})`);
    });

    // 第四步：让 LLM 决定每天的主题（在选 POI 之前）
    console.log('[Pipeline] Planning day themes...');
    const dayThemes = await this.planDayThemes(
      destination, days, clusterResult, 
      clusterResult.dailyClusterAssignment, scored.attractions
    );

    // 第五步：为每个聚类识别体验区域
    console.log('[Pipeline] Identifying experience areas...');
    const clusterExperienceAreas = new Map<string, ExperienceArea[]>();
    for (const cluster of clusterResult.clusters) {
      const clusterAttractions = scored.attractions.filter(s => 
        cluster.attractions.some(a => a.name === s.poi.name)
      );
      const clusterRestaurants = scored.restaurants.filter(s => 
        cluster.restaurants.some(r => r.name === s.poi.name)
      );
      const areas = this.identifyExperienceAreas(clusterAttractions, clusterRestaurants);
      clusterExperienceAreas.set(cluster.id, areas);
    }

    const arrivalTime = conditions.arrivalTime || '10:00';
    const departureTime = conditions.departureTime || '18:00';
    const usedPOIs = new Set<string>();
    const allNodes: TravelNode[] = [];
    const globalCategoryCounts: Record<string, number> = {};

    for (let day = 1; day <= days; day++) {
      const hotelAssignment = hotelAssignments.find(a => a.dayIndex === day)!;
      const hotel = hotelAssignment.hotel;
      const clusterId = hotelAssignment.clusterId;
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      const theme = dayThemes.find(t => t.dayIndex === day);
      
      console.log(`[Pipeline] Day ${day}: theme="${theme?.theme || 'none'}", cluster="${clusterId}"`);
      
      // 获取当天区域的体验区域
      const dayAreas = clusterExperienceAreas.get(clusterId) || [];
      
      // === Step 4 核心改造：锚点是固定节点，不是候选 ===
      const dayAnchors = anchors.filter(a => a.assignedDay === day);
      const hasFullDayAnchor = dayAnchors.some(a => (a.timeWeight || 0.5) >= 1.0);
      
      // 大景点独占一天：候选池只从锚点附近扩展
      let dayAttractions: ScoredPOI[] = [];
      
      if (hasFullDayAnchor) {
        // 大景点日：只从锚点附近 10km 内扩展
        const fullDayAnchor = dayAnchors.find(a => (a.timeWeight || 0.5) >= 1.0)!;
        const anchorLocation = fullDayAnchor.poi.location;
        
        if (anchorLocation) {
          dayAttractions = scored.attractions.filter(s => {
            if (!s.poi.location) return false;
            const dist = amapClient.calculateDistance(anchorLocation, s.poi.location);
            return dist <= 10; // 只允许 10km 内的景点
          });
        }
        
        console.log(`[Pipeline] Day ${day}: FULL-DAY anchor "${fullDayAnchor.poi.name}", ${dayAttractions.length} nearby candidates`);
      } else if (dayAreas.length > 0 && theme) {
        // 非大景点日：体验区域优先 —— 先选区域，再从区域内选 POI
        // 区域排名：主题匹配度 + 区域质量 + 角色分布
        const rankedAreas = dayAreas
          .map(area => {
            let themeBonus = 0;
            // 区域主导角色匹配主题（强约束）
            if (theme.preferredRoles.includes(area.dominantRole)) {
              themeBonus += 0.4;
            }
            // 区域主导类别匹配主题
            if (theme.preferredCategories.includes(area.dominantCategory)) {
              themeBonus += 0.25;
            }
            // 区域内有 CORE_ATTRACTION 或 MAJOR_AREA 的额外加分
            const hasCoreOrMajor = area.attractions.some(a => 
              a.poi.tourismRole === 'CORE_ATTRACTION' || a.poi.tourismRole === 'MAJOR_AREA'
            );
            if (hasCoreOrMajor) themeBonus += 0.2;
            
            // 区域内 FILLER 占比过高则降分
            const fillerCount = area.attractions.filter(a => a.poi.tourismRole === 'FILLER').length;
            const fillerRatio = area.attractions.length > 0 ? fillerCount / area.attractions.length : 0;
            if (fillerRatio > 0.5) themeBonus -= 0.3;
            
            return { area, themeScore: area.qualityScore + themeBonus };
          })
          .sort((a, b) => b.themeScore - a.themeScore);
        
        // 从排名靠前的区域中收集 POI，区域质量分作为加权
        for (const { area, themeScore } of rankedAreas) {
          for (const attr of area.attractions) {
            if (!dayAttractions.find(d => d.poi.name === attr.poi.name)) {
              dayAttractions.push({
                poi: attr.poi,
                score: attr.score * (1 + themeScore * 0.15),
              });
            }
          }
        }
        
        console.log(`[Pipeline] Day ${day}: ${rankedAreas.length} experience areas, top="${rankedAreas[0]?.area.name}" (score=${rankedAreas[0]?.themeScore.toFixed(2)})`);
      }
      
      // 如果体验区域没有足够的 POI，回退到原来的 cluster 逻辑
      const countAvailable = (candidates: ScoredPOI[]) => 
        candidates.filter(c => !usedPOIs.has(c.poi.name)).length;
      
      const MIN_ATTRACTIONS = 4;
      const MIN_RESTAURANTS = 3;
      
      if (countAvailable(dayAttractions) < MIN_ATTRACTIONS) {
        // 回退：使用 cluster 内所有景点
        const clusterAttractions = cluster 
          ? scored.attractions.filter(s => cluster.attractions.some(a => a.name === s.poi.name))
          : scored.attractions;
        
        // 合并，避免重复
        for (const attr of clusterAttractions) {
          if (!dayAttractions.find(d => d.poi.name === attr.poi.name)) {
            dayAttractions.push(attr);
          }
        }
      }
      
      const dayCenter = cluster 
        ? `${cluster.centroid.lng},${cluster.centroid.lat}`
        : hotel.location!;
      
      // === 修复 4：计算邻接 cluster（centroid < 18km），fallback 不跨全城 ===
      const ADJACENT_CLUSTER_DIST = 18;
      const adjacentClusterIds = new Set<string>();
      if (cluster) {
        adjacentClusterIds.add(cluster.id);
        for (const other of clusterResult.clusters) {
          if (other.id === cluster.id) continue;
          const interDist = amapClient.calculateDistance(
            `${cluster.centroid.lng},${cluster.centroid.lat}`,
            `${other.centroid.lng},${other.centroid.lat}`
          );
          if (interDist <= ADJACENT_CLUSTER_DIST) {
            adjacentClusterIds.add(other.id);
          }
        }
      }
      // 邻接 cluster 内的景点和餐厅
      const adjacentAttractions = adjacentClusterIds.size > 0
        ? scored.attractions.filter(s => {
            for (const cid of adjacentClusterIds) {
              const c = clusterResult.clusters.find(cl => cl.id === cid);
              if (c && c.attractions.some(a => a.name === s.poi.name)) return true;
            }
            return false;
          })
        : scored.attractions;
      const adjacentRestaurants = adjacentClusterIds.size > 0
        ? scored.restaurants.filter(s => {
            for (const cid of adjacentClusterIds) {
              const c = clusterResult.clusters.find(cl => cl.id === cid);
              if (c && c.restaurants.some(r => r.name === s.poi.name)) return true;
            }
            return false;
          })
        : scored.restaurants;

      // 如果还不够，按距离扩大范围（限邻接 cluster）
      if (countAvailable(dayAttractions) < MIN_ATTRACTIONS) {
        const nearby = adjacentAttractions.filter(s => {
          if (!s.poi.location) return false;
          return amapClient.calculateDistance(dayCenter, s.poi.location) <= 15;
        });
        for (const attr of nearby) {
          if (!dayAttractions.find(d => d.poi.name === attr.poi.name)) {
            dayAttractions.push(attr);
          }
        }
      }
      if (countAvailable(dayAttractions) < MIN_ATTRACTIONS) {
        const wider = adjacentAttractions.filter(s => {
          if (!s.poi.location) return false;
          return amapClient.calculateDistance(dayCenter, s.poi.location) <= 25;
        });
        for (const attr of wider) {
          if (!dayAttractions.find(d => d.poi.name === attr.poi.name)) {
            dayAttractions.push(attr);
          }
        }
      }
      // 最终兜底：邻接 cluster 全部景点（不再扩到全城）
      if (countAvailable(dayAttractions) < MIN_ATTRACTIONS) {
        for (const attr of adjacentAttractions) {
          if (!dayAttractions.find(d => d.poi.name === attr.poi.name)) {
            dayAttractions.push(attr);
          }
        }
      }
      
      // 餐厅候选（优先体验区域内的，再扩大）
      let dayRestaurants: ScoredPOI[] = [];
      if (dayAreas.length > 0) {
        for (const area of dayAreas) {
          for (const r of area.restaurants) {
            if (!dayRestaurants.find(d => d.poi.name === r.poi.name)) {
              dayRestaurants.push(r);
            }
          }
        }
      }
      if (countAvailable(dayRestaurants) < MIN_RESTAURANTS) {
        const clusterRestaurants = cluster
          ? scored.restaurants.filter(s => cluster.restaurants.some(r => r.name === s.poi.name))
          : scored.restaurants;
        for (const r of clusterRestaurants) {
          if (!dayRestaurants.find(d => d.poi.name === r.poi.name)) {
            dayRestaurants.push(r);
          }
        }
      }
      // 距离梯度扩大（限邻接 cluster）
      for (const maxDist of [10, 15, 20]) {
        if (countAvailable(dayRestaurants) >= MIN_RESTAURANTS) break;
        const nearby = adjacentRestaurants.filter(s => {
          if (!s.poi.location) return false;
          return amapClient.calculateDistance(dayCenter, s.poi.location) <= maxDist;
        });
        for (const r of nearby) {
          if (!dayRestaurants.find(d => d.poi.name === r.poi.name)) {
            dayRestaurants.push(r);
          }
        }
      }
      // 最终兜底：邻接 cluster 全部餐厅（不再扩到全城）
      if (countAvailable(dayRestaurants) < MIN_RESTAURANTS) {
        for (const r of adjacentRestaurants) {
          if (!dayRestaurants.find(d => d.poi.name === r.poi.name)) {
            dayRestaurants.push(r);
          }
        }
      }

      // === 锚点注入：锚点是固定节点，分数设为极高确保不被替换 ===
      for (const anchor of dayAnchors) {
        if (usedPOIs.has(anchor.poi.name)) continue;
        const existing = dayAttractions.find(d => d.poi.name === anchor.poi.name);
        if (existing) {
          // 已在候选列表中，设为极高分（固定节点）
          existing.score = 10.0; // 远高于任何正常分数
        } else {
          // 不在候选列表中，强制加入
          dayAttractions.unshift({ poi: anchor.poi, score: 10.0 });
        }
        console.log(`[Pipeline] Day ${day}: Anchor "${anchor.poi.name}" [${anchor.domain}] FIXED (weight=${anchor.timeWeight})`);
      }

      const slots = this.generateDayFramework(day, days, arrivalTime, departureTime);
      const schedule = await this.optimizeRoute(slots, dayAttractions, dayRestaurants, hotel.location!, usedPOIs, hotel.location!, globalCategoryCounts, theme, dayCenter);
      schedule.dayIndex = day;

      let order = 1;
      const dayNodes: TravelNode[] = [];

      // 第一天：抵达 + 入住
      if (day === 1) {
        dayNodes.push(this.createNode(day, order++, 'arrival', arrivalTime, `抵达${destination}`, 'transport', '', `抵达：到达${destination}`, hotel.location));
        dayNodes.push(this.createNode(day, order++, 'checkin', this.addMinutes(arrivalTime, 30), hotel.name, 'hotel', hotel.address, '入住：办理入住手续', hotel.location));
      }
      
      // 换酒店：退房 + 入住新酒店（只有真正换酒店时才添加）
      if (day > 1 && hotelAssignment.isNewHotel) {
        const prevHotel = hotelAssignments.find(a => a.dayIndex === day - 1)!.hotel;
        // 早上退房 - 使用 07:30 确保在早餐之前
        dayNodes.push(this.createNode(day, order++, 'checkout', '07:30', prevHotel.name, 'hotel', prevHotel.address, '退房：办理退房手续', prevHotel.location));
        // 前往新酒店入住（寄存行李）- 使用 07:45 确保在早餐之前
        dayNodes.push(this.createNode(day, order++, 'checkin', '07:45', hotel.name, 'hotel', hotel.address, '入住：办理入住/寄存行李', hotel.location));
      }

      // 添加当天的活动节点
      for (const s of schedule.slots) {
        if (!s.poi) continue;
        dayNodes.push({
          id: uuidv4(), itineraryId: '', name: s.poi.name,
          type: s.slot.poiType === 'restaurant' ? 'restaurant' : 'attraction',
          address: s.poi.address, 
          description: this.generateNaturalDescription(s.poi, s.slot.poiType),
          activity: `${this.getSlotLabel(s.slot.type)}：${s.poi.name}`,
          timeSlot: s.slot.type, estimatedDuration: s.slot.duration,
          scheduledTime: s.scheduledTime, dayIndex: day, order: order++,
          verified: true, isLit: false, location: s.poi.location,
          transportDuration: s.travelTimeFromPrev,
          transportMode: this.inferTransportMode(s.distanceFromPrev),
        });
      }

      // 最后一天：返程
      if (day === days) {
        dayNodes.push(this.createNode(day, order++, 'departure', departureTime, `离开${destination}`, 'transport', '', '返程：前往机场/火车站'));
      }
      
      // 按时间排序当天节点（不含回酒店，回酒店最后单独加）
      dayNodes.sort((a, b) => (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));
      
      // 非最后一天：回酒店放在绝对最后，时间设为最后一个活动结束之后
      if (day < days) {
        const lastActivity = dayNodes[dayNodes.length - 1];
        const lastTime = lastActivity?.scheduledTime || '21:00';
        const lastDuration = lastActivity?.estimatedDuration || 60;
        const hotelReturnTime = this.addMinutes(lastTime, lastDuration);
        dayNodes.push(this.createNode(day, order++, 'hotel', hotelReturnTime, hotel.name, 'hotel', hotel.address, '回酒店：休息', hotel.location));
      }
      
      // 重新分配 order
      dayNodes.forEach((node, idx) => { node.order = idx + 1; });
      
      allNodes.push(...dayNodes);
    }

    // === Step 5: 锚点覆盖验证（硬约束 —— 缺失 = 行程不合法） ===
    console.log('[Pipeline] Validating anchor coverage...');
    const anchorValidation = this.validateAnchorCoverage(anchors, allNodes);
    if (!anchorValidation.valid) {
      console.error('[Pipeline] ANCHOR COVERAGE FAILED! Missing anchors:', 
        anchorValidation.missingAnchors.map(a => `${a.poi.name}[${a.domain}]`).join(', '));
      
      // 硬约束修复：缺失的锚点必须出现在行程中
      for (const missing of anchorValidation.missingAnchors) {
        const targetDay = missing.assignedDay || 1;
        const isFullDay = (missing.timeWeight || 0.5) >= 1.0;
        console.log(`[Pipeline] Force-inserting anchor "${missing.poi.name}" into Day ${targetDay} (fullDay=${isFullDay})`);
        
        // 确定锚点应该占据的时段：大景点占 morning，中景点也优先 morning
        const preferredSlot = isFullDay ? 'morning' : 'morning';
        const preferredTime = '09:30';
        
        // 找到该天的景点节点，按替换优先级排序
        const dayAttractionNodes = allNodes
          .filter(n => n.dayIndex === targetDay && n.type === 'attraction')
          .map(n => {
            const matched = scored.attractions.find(s => s.poi.name === n.name);
            const role = matched?.poi.tourismRole || 'FILLER';
            const isAnchor = anchors.some(a => a.poi.name === n.name && a !== missing);
            // 替换优先级：FILLER > 低分非锚点 > 其他
            // 锚点不可替换
            const replacePriority = isAnchor ? 999 : (role === 'FILLER' ? 0 : (matched?.score || 0.5));
            return { node: n, replacePriority, slot: n.timeSlot };
          })
          .sort((a, b) => a.replacePriority - b.replacePriority);
        
        // 优先替换 morning 时段的 FILLER，其次替换任意 FILLER，最后替换最低分
        const morningFiller = dayAttractionNodes.find(n => n.slot === 'morning' && n.replacePriority < 1);
        const anyFiller = dayAttractionNodes.find(n => n.replacePriority < 1);
        const lowestScore = dayAttractionNodes.find(n => n.replacePriority < 999);
        
        const replaceTarget = morningFiller || anyFiller || lowestScore;
        
        if (replaceTarget) {
          console.log(`[Pipeline] Replacing "${replaceTarget.node.name}" [${replaceTarget.slot}] with anchor "${missing.poi.name}"`);
          const idx = allNodes.indexOf(replaceTarget.node);
          if (idx >= 0) {
            // 释放被替换的 POI
            usedPOIs.delete(allNodes[idx].name);
            usedPOIs.add(missing.poi.name);
            
            allNodes[idx].name = missing.poi.name;
            allNodes[idx].address = missing.poi.address;
            allNodes[idx].location = missing.poi.location;
            allNodes[idx].description = this.generateNaturalDescription(missing.poi, 'attraction');
            allNodes[idx].activity = `${this.getSlotLabel(allNodes[idx].timeSlot || 'morning')}：${missing.poi.name}`;
            allNodes[idx].estimatedDuration = isFullDay ? 240 : 120;
          }
        } else {
          // 没有可替换的节点，直接插入到 morning 时段
          console.log(`[Pipeline] No replaceable node, inserting anchor "${missing.poi.name}" directly`);
          usedPOIs.add(missing.poi.name);
          const newNode = this.createNode(
            targetDay, 999, preferredSlot, preferredTime, missing.poi.name,
            'attraction', missing.poi.address, `上午：${missing.poi.name}`, missing.poi.location
          );
          newNode.estimatedDuration = isFullDay ? 240 : 120;
          allNodes.push(newNode);
        }
      }
      
      // 重新排序
      this.reorderNodes(allNodes);
      
      // 二次验证：锚点必须全部覆盖
      const revalidation = this.validateAnchorCoverage(anchors, allNodes);
      if (!revalidation.valid) {
        console.error('[Pipeline] CRITICAL: Anchor coverage still failed after repair!',
          revalidation.missingAnchors.map(a => a.poi.name));
      } else {
        console.log('[Pipeline] Anchor coverage PASSED after repair');
      }
    } else {
      console.log('[Pipeline] Anchor coverage validation PASSED:', 
        anchorValidation.coveredDomains.join(', '));
    }

    // === Step 6: Domain Quota 验证（硬约束 + 自动修复） ===
    console.log('[Pipeline] Validating domain quotas...');
    const quotaValidation = this.validateDomainQuotas(domainQuotas, anchors, allNodes, scored.attractions);
    if (!quotaValidation.valid) {
      console.error('[Pipeline] DOMAIN QUOTA FAILED:', quotaValidation.issues);
      
      // 硬约束修复：为缺失的体验域强制注入景点
      for (const issue of quotaValidation.missingDomainDetails) {
        const { domain, deficit } = issue;
        console.log(`[Pipeline] Fixing domain "${domain}": need ${deficit} more day(s) of coverage`);
        
        // 找到该域最佳的未使用景点
        const domainCandidates = scored.attractions
          .filter(a => a.poi.experienceDomain === domain && !usedPOIs.has(a.poi.name) && a.score >= 0.3)
          .sort((a, b) => b.score - a.score);
        
        if (domainCandidates.length === 0) {
          console.warn(`[Pipeline] No candidates for domain "${domain}", skipping`);
          continue;
        }
        
        // 找到缺少该域覆盖的天（优先选 FILLER 最多的天）
        const nodesByDay = new Map<number, TravelNode[]>();
        for (const n of allNodes) {
          if (!nodesByDay.has(n.dayIndex)) nodesByDay.set(n.dayIndex, []);
          nodesByDay.get(n.dayIndex)!.push(n);
        }
        
        // 统计每天已有的域覆盖
        const dayDomainCoverage = new Map<number, Set<ExperienceDomain>>();
        for (const n of allNodes) {
          if (n.type !== 'attraction') continue;
          const matched = scored.attractions.find(s => s.poi.name === n.name);
          if (matched?.poi.experienceDomain) {
            if (!dayDomainCoverage.has(n.dayIndex)) dayDomainCoverage.set(n.dayIndex, new Set());
            dayDomainCoverage.get(n.dayIndex)!.add(matched.poi.experienceDomain);
          }
        }
        
        // 找没有该域覆盖的天，按 FILLER 数量降序（优先替换 FILLER 多的天）
        const uncoveredDays = Array.from(nodesByDay.keys())
          .filter(d => !dayDomainCoverage.get(d)?.has(domain))
          .map(d => {
            const dayNodes = nodesByDay.get(d) || [];
            const fillerCount = dayNodes.filter(n => {
              if (n.type !== 'attraction') return false;
              const m = scored.attractions.find(s => s.poi.name === n.name);
              return m?.poi.tourismRole === 'FILLER';
            }).length;
            return { day: d, fillerCount };
          })
          .sort((a, b) => b.fillerCount - a.fillerCount);
        
        let injected = 0;
        for (const { day } of uncoveredDays) {
          if (injected >= Math.ceil(deficit)) break;
          if (domainCandidates.length === 0) break;
          
          const candidate = domainCandidates.shift()!;
          const dayNodes = nodesByDay.get(day) || [];
          
          // 找该天的 FILLER 景点替换，没有则替换最低分景点
          const attractionNodes = dayNodes.filter(n => n.type === 'attraction');
          let replaceTarget: TravelNode | null = null;
          let replaceScore = Infinity;
          
          for (const n of attractionNodes) {
            // 不替换锚点
            if (anchors.some(a => a.poi.name === n.name)) continue;
            const m = scored.attractions.find(s => s.poi.name === n.name);
            const role = m?.poi.tourismRole || 'FILLER';
            // FILLER 优先替换（给极低分），否则按实际分数
            const effectiveScore = role === 'FILLER' ? -1 : (m?.score || 0);
            if (effectiveScore < replaceScore) {
              replaceScore = effectiveScore;
              replaceTarget = n;
            }
          }
          
          if (replaceTarget) {
            console.log(`[Pipeline] Domain fix: Day ${day}, replacing "${replaceTarget.name}" with "${candidate.poi.name}" [${domain}]`);
            usedPOIs.delete(replaceTarget.name);
            usedPOIs.add(candidate.poi.name);
            
            const idx = allNodes.indexOf(replaceTarget);
            if (idx >= 0) {
              allNodes[idx].name = candidate.poi.name;
              allNodes[idx].address = candidate.poi.address;
              allNodes[idx].location = candidate.poi.location;
              allNodes[idx].description = this.generateNaturalDescription(candidate.poi, 'attraction');
              allNodes[idx].activity = `${this.getSlotLabel(allNodes[idx].timeSlot || 'morning')}：${candidate.poi.name}`;
            }
            injected++;
          }
        }
        
        if (injected > 0) {
          console.log(`[Pipeline] Domain "${domain}": injected ${injected} POI(s)`);
        }
      }
      
      this.reorderNodes(allNodes);
      
      // 再次验证
      const reQuotaValidation = this.validateDomainQuotas(domainQuotas, anchors, allNodes, scored.attractions);
      if (!reQuotaValidation.valid) {
        console.warn('[Pipeline] Domain quota still has issues after fix:', reQuotaValidation.issues);
      } else {
        console.log('[Pipeline] Domain quota validation PASSED after fix');
      }
    } else {
      console.log('[Pipeline] Domain quota validation PASSED');
    }

    this.calculateDistanceToNext(allNodes);

    // === 长途旅行换酒店后处理（≥5天才触发） ===
    if (days >= 5) {
      console.log('[Pipeline] Post-processing: Long trip hotel change...');
      await this.injectHotelChanges(allNodes, days, scored.attractions, hotelAssignments, destination);
      // 换酒店后重新计算距离
      this.calculateDistanceToNext(allNodes);
    }
    
    // 使用 LLM 生成自然的描述和推荐理由
    console.log('[Pipeline] Generating descriptions with LLM...');
    await this.enrichDescriptionsWithLLM(allNodes, destination);

    // 最终去重：如果仍有重复餐厅名，替换为候选池中未使用的餐厅
    this.deduplicateRestaurants(allNodes, scored.restaurants, usedPOIs);

    // 最终去重：如果有同名/相似名称的景点（如"广州塔"和"广州塔E区"），替换重复的
    await this.deduplicateAttractions(allNodes, scored.attractions, usedPOIs);

    // 餐厅合理性审查：LLM 一次性审查所有餐厅安排，替换不合理的
    console.log('[Pipeline] Reviewing restaurant reasonability with LLM...');
    await this.reviewAndFixRestaurants(allNodes, destination, usedPOIs);

    // 景点合理性审查（两轮）：
    // 第一轮：LLM 识别明显不合理的景点（公司、学校、社区等），最多替换3处
    console.log('[Pipeline] Reviewing invalid attractions with LLM...');
    await this.reviewAndFixInvalidAttractions(allNodes, destination, usedPOIs);

    // 第二轮：LLM 审查景点安排多样性（宗祠过多、同质化等），最多替换5处
    console.log('[Pipeline] Reviewing attraction arrangement with LLM...');
    await this.reviewAndFixAttractions(allNodes, destination, usedPOIs);

    // === 最终框架完整性检查（兜底）===
    // 前面的 injectHotelChanges、enrichDescriptions、reviewAndFix 等步骤
    // 都可能间接导致时段缺失，这里做最后一次检查确保每天的框架完整
    console.log('[Pipeline] Final framework validation...');
    const finalValidation = this.validateDailyFramework(allNodes, days, arrivalTime, departureTime);
    if (!finalValidation.valid) {
      console.warn('[Pipeline] Final validation found issues:', finalValidation.issues);
      if (finalValidation.missingSlots.length > 0) {
        console.log(`[Pipeline] Final fix: ${finalValidation.missingSlots.length} missing slots`);
        await this.fixMissingSlots(
          allNodes,
          finalValidation.missingSlots,
          destination,
          hotelAssignments,
          clusterResult,
          scored.attractions,
          scored.restaurants,
          usedPOIs
        );
        this.reorderNodes(allNodes);
        this.calculateDistanceToNext(allNodes);
      }
    } else {
      console.log('[Pipeline] Final framework validation PASSED');
    }
    
    return allNodes;
  }

  /**
   * 使用 LLM 为节点生成自然的描述和推荐理由
   */
  private async enrichDescriptionsWithLLM(nodes: TravelNode[], destination: string): Promise<void> {
    // 筛选需要生成描述的节点（景点和餐厅）
    const nodesToEnrich = nodes.filter(n => 
      (n.type === 'attraction' || n.type === 'restaurant') &&
      n.timeSlot !== 'arrival' && n.timeSlot !== 'departure'
    );
    
    if (nodesToEnrich.length === 0) return;
    
    const nodeList = nodesToEnrich.map((n, i) => 
      `${i + 1}. ${n.name} (${n.type === 'restaurant' ? '餐厅' : '景点'}, ${n.timeSlot})`
    ).join('\n');
    
    const prompt = `请为${destination}的以下地点生成简短的推荐描述（每个20-40字）：

${nodeList}

要求：
1. 景点：描述特色亮点、推荐游玩内容，如"岭南园林精品，推荐游览十二石斋、群星草堂"
2. 餐厅：描述特色菜品、推荐点什么，如"正宗粤菜老字号，推荐白切鸡、烧鹅、艇仔粥"
3. 早餐店：推荐当地特色早点，如"老字号茶楼，推荐虾饺、肠粉、叉烧包"
4. 语言自然生动，像本地人推荐一样
5. 不要写"值得一游"、"不容错过"这类空泛的话

返回JSON数组，格式：[{"index": 1, "description": "描述内容"}, ...]
只返回JSON，不要其他内容。`;

    try {
      const result = await deepseekClient.chatWithJson<Array<{ index: number; description: string }>>([
        { role: 'system', content: '你是一个熟悉当地的旅行达人，擅长用生动的语言推荐景点和美食。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);
      
      // 更新节点描述
      for (const item of result) {
        const nodeIndex = item.index - 1;
        if (nodeIndex >= 0 && nodeIndex < nodesToEnrich.length && item.description) {
          nodesToEnrich[nodeIndex].description = item.description;
        }
      }
      
      console.log(`[Pipeline] Generated descriptions for ${result.length} nodes`);
    } catch (error) {
      console.warn('[Pipeline] Failed to generate descriptions with LLM:', error);
      // 失败时使用简单描述作为回退
      for (const node of nodesToEnrich) {
        if (!node.description || node.description.length < 5) {
          node.description = node.type === 'restaurant' 
            ? '当地人气餐厅，口碑不错' 
            : '当地特色景点，推荐游览';
        }
      }
    }
  }

  /**
   * 名称归一化：去掉常见子区域后缀，用于检测同一景点的不同入口/分区
   */
  private normalizeAttractionName(name: string): string {
    return name.replace(/[\(（].*[\)）]|[A-Za-z]区$|[东南西北]区$|[东南西北]门$|分[馆店]$|[一二三四五六七八九十\d]+号?[门口入]$/g, '').trim();
  }

  /**
   * 检查两个景点名称是否指向同一个地方（互相包含 或 归一化后相同 或 距离极近）
   */
  private isSameAttraction(nameA: string, nameB: string, locationA?: string, locationB?: string): boolean {
    if (nameA === nameB) return true;
    if (nameA.includes(nameB) || nameB.includes(nameA)) return true;
    if (this.normalizeAttractionName(nameA) === this.normalizeAttractionName(nameB)) return true;
    if (locationA && locationB) {
      const dist = amapClient.calculateDistance(locationA, locationB);
      if (dist < 0.5) return true; // 500米内视为同一景点
    }
    return false;
  }

  /**
   * 最终去重：检查所有景点节点，如果有同名/相似名称的景点，用候选池中未使用的景点替换
   * 
   * 场景：高德搜索返回"广州塔"和"广州塔E区"作为不同POI，但实际是同一个地方
   */
  private async deduplicateAttractions(nodes: TravelNode[], scoredAttractions?: ScoredPOI[], usedPOIs?: Set<string>): Promise<void> {
    const sorted = [...nodes]
      .filter(n => n.type === 'attraction')
      .sort((a, b) => a.dayIndex !== b.dayIndex 
        ? a.dayIndex - b.dayIndex 
        : (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));

    // seen 存储已出现的景点（名称 + 位置），用于相似性检测
    const seenAttractions: Array<{ name: string; location?: string }> = [];
    const _usedPOIs = usedPOIs || new Set<string>();

    for (const node of sorted) {
      const isDuplicate = seenAttractions.some(s => this.isSameAttraction(node.name, s.name, node.location, s.location));
      if (!isDuplicate) {
        seenAttractions.push({ name: node.name, location: node.location });
        continue;
      }

      // 重复了，记录被替换节点的位置，用于距离排斥
      const duplicateLocation = node.location;

      // 先从候选池找替代
      const replacement = scoredAttractions?.find(r => {
        if (!r.poi.location) return false;
        if (_usedPOIs.has(r.poi.name)) return false;
        if (!seenAttractions.every(s => !this.isSameAttraction(r.poi.name, s.name, r.poi.location, s.location))) return false;
        // 距离排斥：距被替换节点 1.5km 内的候选跳过（大概率是同一景区的子设施）
        if (duplicateLocation && amapClient.calculateDistance(duplicateLocation, r.poi.location) < 1.5) return false;
        return true;
      });

      if (replacement) {
        console.log(`[Pipeline] Attraction dedup: replacing "${node.name}" (Day ${node.dayIndex}) with "${replacement.poi.name}"`);
        _usedPOIs.delete(node.name);
        node.name = replacement.poi.name;
        node.address = replacement.poi.address;
        node.location = replacement.poi.location;
        node.description = replacement.poi.description || node.description;
        node.activity = node.activity?.replace(/：.*/, `：${replacement.poi.name}`) || node.activity;
        seenAttractions.push({ name: replacement.poi.name, location: replacement.poi.location });
        _usedPOIs.add(replacement.poi.name);
      } else if (node.location) {
        // 候选池耗尽，用高德实时搜索附近景点替换
        console.log(`[Pipeline] Attraction dedup: pool exhausted for duplicate "${node.name}" (Day ${node.dayIndex}), searching nearby...`);
        try {
          const pois = await amapClient.searchAround(node.location, 10000, {
            types: '110000|140000',
            pageSize: 20,
            sortRule: 'distance',
          });
          const nearby = pois.find(p => {
            if (!p.location || _usedPOIs.has(p.name)) return false;
            if (!this.isValidAttractionName(p.name)) return false;
            if (!seenAttractions.every(s => !this.isSameAttraction(p.name, s.name, p.location, s.location))) return false;
            // 距离排斥：距被替换节点 1.5km 内跳过
            if (amapClient.calculateDistance(node.location!, p.location) < 1.5) return false;
            return true;
          });
          if (nearby) {
            console.log(`[Pipeline] Attraction dedup: found nearby "${nearby.name}" for duplicate "${node.name}"`);
            _usedPOIs.delete(node.name);
            node.name = nearby.name;
            node.address = [nearby.city, nearby.district, nearby.address].filter(Boolean).join('') || '';
            node.location = nearby.location;
            node.description = nearby.rating ? `评分${nearby.rating}` : '';
            node.activity = node.activity?.replace(/：.*/, `：${nearby.name}`) || node.activity;
            seenAttractions.push({ name: nearby.name, location: nearby.location });
            _usedPOIs.add(nearby.name);
          } else {
            console.warn(`[Pipeline] Attraction dedup: no nearby replacement found for duplicate "${node.name}" (Day ${node.dayIndex})`);
            seenAttractions.push({ name: node.name, location: node.location });
          }
        } catch (e) {
          console.warn(`[Pipeline] Attraction dedup: search failed for "${node.name}":`, e);
          seenAttractions.push({ name: node.name, location: node.location });
        }
      } else {
        console.warn(`[Pipeline] Attraction dedup: no location for duplicate "${node.name}" (Day ${node.dayIndex}), skipping`);
        seenAttractions.push({ name: node.name, location: node.location });
      }
    }
  }

  /**
   * 最终去重：检查所有餐厅节点，如果有重复名称，用候选池中未使用的餐厅替换
   */
  private deduplicateRestaurants(nodes: TravelNode[], scoredRestaurants?: ScoredPOI[], usedPOIs?: Set<string>): void {
    // 先按天+时间排序，确保遍历顺序正确（保留第一次出现的，替换后续重复的）
    const sorted = [...nodes]
      .filter(n => n.type === 'restaurant')
      .sort((a, b) => a.dayIndex !== b.dayIndex 
        ? a.dayIndex - b.dayIndex 
        : (a.scheduledTime || '').localeCompare(b.scheduledTime || ''));

    const seen = new Set<string>();
    const _usedPOIs = usedPOIs || new Set<string>();

    for (const node of sorted) {
      if (!seen.has(node.name)) {
        seen.add(node.name);
        continue;
      }
      // 重复了，找一个未使用的替代
      const replacement = scoredRestaurants?.find(r => 
        !seen.has(r.poi.name) && !_usedPOIs.has(r.poi.name) && r.poi.location
      );
      if (replacement) {
        console.log(`[Pipeline] Dedup: replacing duplicate "${node.name}" with "${replacement.poi.name}"`);
        node.name = replacement.poi.name;
        node.address = replacement.poi.address;
        node.location = replacement.poi.location;
        node.description = replacement.poi.description || node.description;
        node.activity = node.activity?.replace(/：.*/, `：${replacement.poi.name}`) || node.activity;
        seen.add(replacement.poi.name);
        _usedPOIs.add(replacement.poi.name);
      } else {
        // 无候选池或候选耗尽，给名称加天数标记避免前端显示完全一样
        const suffix = `(Day${node.dayIndex})`;
        console.warn(`[Pipeline] Dedup: no replacement for duplicate "${node.name}", appending "${suffix}"`);
        node.name = node.name + suffix;
        seen.add(node.name);
      }
    }
  }

  /**
   * LLM 审查餐厅合理性并替换不合理的餐厅
   * 
   * 流程：
   * 1. 把所有餐厅节点按天整理发给 LLM
   * 2. LLM 一次性返回所有不合理的餐厅及建议替换的类型
   * 3. 逐个用高德搜索建议类型的附近餐厅进行替换
   */
  private async reviewAndFixRestaurants(
    nodes: TravelNode[], destination: string, usedPOIs: Set<string>
  ): Promise<void> {
    const restaurantNodes = nodes.filter(n => n.type === 'restaurant');
    if (restaurantNodes.length === 0) return;

    // 整理餐厅列表
    const restaurantList = restaurantNodes.map((n, i) => 
      `${i + 1}. 第${n.dayIndex}天${n.timeSlot === 'breakfast' ? '早餐' : n.timeSlot === 'lunch' ? '午餐' : '晚餐'}：${n.name}`
    ).join('\n');

    const prompt = `以下是${destination}旅行行程中的所有餐厅安排，请审查是否合理：

${restaurantList}

请检查以下问题：
1. 同类型餐厅过多（如连续多天都是包子/粥/面馆/同一菜系）
2. 早餐安排了正餐类餐厅（如酒楼、火锅、海鲜等）
3. 午餐/晚餐安排了早餐类店铺（如包子铺、豆浆店）
4. 午餐/晚餐安排了非正餐类店铺（如甜品店、奶茶店、饮品店、咖啡店、冰淇淋店、蛋糕店等），正餐应该是能吃饱的餐厅
5. 整体缺乏多样性（应该有不同菜系、不同风格的餐厅）

对于有问题的餐厅，请给出应该替换成什么类型。
注意：suggestedKeywords 必须是简短的、可直接用于地图搜索的关键词数组，每个关键词2-4个字。
返回JSON数组，只包含需要替换的项，格式：
[{"index": 序号, "reason": "问题原因", "suggestedKeywords": ["粤菜", "粤菜馆"]}]

suggestedKeywords 示例（必须简短具体）：
- 想换粤菜：["粤菜", "粤菜馆", "广府菜"]
- 想换湘菜：["湘菜", "湘菜馆"]
- 想换日料：["日料", "日本料理", "寿司"]
- 想换茶餐厅：["茶餐厅", "港式"]
- 想换火锅：["火锅", "火锅店"]

如果所有餐厅都合理，返回空数组 []。只返回JSON，不要其他内容。`;

    try {
      const issues = await deepseekClient.chatWithJson<Array<{
        index: number; reason: string; suggestedKeywords?: string[]; suggestedType?: string;
      }>>([
        { role: 'system', content: '你是一个美食顾问，擅长审查旅行行程中的餐饮安排是否合理多样。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);

      if (!issues || issues.length === 0) {
        console.log('[Pipeline] Restaurant review: all OK');
        return;
      }

      console.log(`[Pipeline] Restaurant review: ${issues.length} issues found`);

      for (const issue of issues) {
        const nodeIndex = issue.index - 1;
        if (nodeIndex < 0 || nodeIndex >= restaurantNodes.length) continue;

        const node = restaurantNodes[nodeIndex];
        if (!node.location) continue;

        // 兼容旧格式
        const keywords: string[] = issue.suggestedKeywords
          || (issue.suggestedType ? issue.suggestedType.split(/[或、,，]/).map(s => s.trim()).filter(Boolean) : []);
        
        if (keywords.length === 0) continue;

        console.log(`[Pipeline] Fixing: "${node.name}" (${issue.reason}) -> keywords: [${keywords.join(', ')}]`);

        // 根据时段过滤候选：早餐不要正餐馆，午餐/晚餐不要早餐店
        const isBreakfastSlot = node.timeSlot === 'breakfast';
        const breakfastExcludePattern = /火锅|烧烤|海鲜|酒楼|川菜|湘菜|东北菜|烤肉|烤鱼|铁板|干锅|串串|麻辣|卤鹅|烧腊|烧鸭|烧鹅|牛排|西餐/;
        const dinnerExcludePattern = /包子|豆浆|油条|煎饼|早点|早餐/;

        let replaced = false;
        for (const kw of keywords) {
          if (replaced) break;
          try {
            const pois = await amapClient.searchAround(node.location, 5000, {
              keywords: kw,
              types: '050000',
              pageSize: 10,
              sortRule: 'distance',
            });

            const replacement = pois.find(p => {
              if (!p.location || usedPOIs.has(p.name) || p.name === node.name) return false;
              // 时段适配过滤
              if (isBreakfastSlot && breakfastExcludePattern.test(p.name)) return false;
              if (!isBreakfastSlot && dinnerExcludePattern.test(p.name)) return false;
              return true;
            });
            if (replacement) {
              console.log(`[Pipeline] Replaced "${node.name}" with "${replacement.name}" (keyword: "${kw}")`);
              usedPOIs.delete(node.name);
              node.name = replacement.name;
              node.address = [replacement.city, replacement.district, replacement.address].filter(Boolean).join('') || '';
              node.location = replacement.location;
              node.description = replacement.rating ? `评分${replacement.rating}` : kw;
              node.activity = node.activity?.replace(/：.*/, `：${replacement.name}`) || node.activity;
              usedPOIs.add(replacement.name);
              replaced = true;
            }
          } catch (e) {
            console.warn(`[Pipeline] Search failed for keyword "${kw}":`, e);
          }
        }

        // 所有关键词都没搜到，用通用关键词兜底
        if (!replaced) {
          try {
            const fallbackKw = isBreakfastSlot ? '早餐' : '餐厅';
            const pois = await amapClient.searchAround(node.location, 8000, {
              keywords: fallbackKw,
              types: '050000',
              pageSize: 20,
              sortRule: 'distance',
            });
            const replacement = pois.find(p => {
              if (!p.location || usedPOIs.has(p.name) || p.name === node.name) return false;
              if (isBreakfastSlot && breakfastExcludePattern.test(p.name)) return false;
              if (!isBreakfastSlot && dinnerExcludePattern.test(p.name)) return false;
              return true;
            });
            if (replacement) {
              console.log(`[Pipeline] Fallback replaced "${node.name}" with "${replacement.name}"`);
              usedPOIs.delete(node.name);
              node.name = replacement.name;
              node.address = [replacement.city, replacement.district, replacement.address].filter(Boolean).join('') || '';
              node.location = replacement.location;
              node.description = replacement.rating ? `评分${replacement.rating}` : '';
              node.activity = node.activity?.replace(/：.*/, `：${replacement.name}`) || node.activity;
              usedPOIs.add(replacement.name);
            }
          } catch (e) {
            console.warn(`[Pipeline] Fallback search also failed for "${node.name}":`, e);
          }
        }
      }

      // 替换后再做一次去重
      this.deduplicateRestaurants(nodes);
    } catch (e) {
      console.warn('[Pipeline] Restaurant review failed, skipping:', e);
    }
  }

  /**
   * LLM 审查明显不合理的景点（公司、学校、社区、政府机构等非旅游场所）
   * 最多替换3处
   */
  private async reviewAndFixInvalidAttractions(
    nodes: TravelNode[], destination: string, usedPOIs: Set<string>
  ): Promise<void> {
    const attractionNodes = nodes.filter(n => n.type === 'attraction');
    if (attractionNodes.length === 0) return;

    const attractionList = attractionNodes.map((n, i) =>
      `${i + 1}. 第${n.dayIndex}天${n.timeSlot}：${n.name}`
    ).join('\n');

    const prompt = `以下是${destination}旅行行程中的所有景点，请检查是否有明显不适合作为旅游景点的地方：

${attractionList}

请识别以下类型的不合理景点：
- 公司/企业（如"XX有限公司"、"XX科技公司"、"XX集团"）
- 学校/教育机构（如"XX职业技术学院"、"XX实训中心"、"XX培训学校"、"XX学院"）
- 社区/居民区（如"XX社区"、"XX小区"、"XX居委会"）
- 政府/行政机构（如"XX派出所"、"XX管理处"、"XX服务中心"）
- 生活服务场所（如"XX维修店"、"XX美容院"、"XX洗车场"）
- 垃圾处理/环卫设施（如"XX垃圾分类体验馆"、"XX环卫站"）
- 名称过于模糊泛化、无法定位的地方（如"文化长廊"、"中心小镇"、"休闲广场"等缺乏具体名称的泛指）
- 其他明显不适合游客游览的场所

注意：宗祠、庙宇、祠堂等虽然可能不够有趣，但它们是合法的旅游景点，不算不合理，不要标记。
只标记那些明显不是旅游景点的地方。最多标记3个最不合理的。如果没有不合理的景点，返回空数组。

返回JSON数组，格式：
[{"index": 序号, "reason": "不合理原因", "suggestedKeywords": ["博物馆", "公园"]}]

suggestedKeywords 是替换建议关键词，要求：
- 必须简短（2-4个字），可直接用于高德地图搜索
- 必须是具体的旅游景点类型，如"博物馆"、"公园"、"古镇"、"商业街"、"纪念馆"等
- 不要用模糊词如"冰雪乐园"、"室内滑雪"、"文化街区"、"艺术园区"等不常见类型
只返回JSON，不要其他内容。`;

    try {
      const issues = await deepseekClient.chatWithJson<Array<{
        index: number; reason: string; suggestedKeywords: string[];
      }>>([
        { role: 'system', content: '你是旅游景点质量审核专家，擅长识别不适合旅游的场所。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);

      if (!issues || issues.length === 0) {
        console.log('[Pipeline] Invalid attraction review: all OK');
        return;
      }

      const limitedIssues = issues.slice(0, 3);
      console.log(`[Pipeline] Invalid attraction review: ${issues.length} issues found, processing ${limitedIssues.length} (max 3)`);

      for (const issue of limitedIssues) {
        const nodeIndex = issue.index - 1;
        if (nodeIndex < 0 || nodeIndex >= attractionNodes.length) continue;

        const node = attractionNodes[nodeIndex];
        if (!node.location) continue;

        const keywords: string[] = issue.suggestedKeywords || [];
        if (keywords.length === 0) continue;

        console.log(`[Pipeline] Fixing invalid: "${node.name}" (${issue.reason}) -> keywords: [${keywords.join(', ')}]`);

        // 收集候选
        const allCandidates: Array<{ name: string; address: string; location: string; rating?: string; typeName?: string }> = [];
        const seenNames = new Set<string>();

        for (const kw of keywords) {
          try {
            const pois = await amapClient.searchAround(node.location, 8000, {
              keywords: kw,
              types: '110000|140000',
              pageSize: 15,
              sortRule: 'distance',
            });
            for (const p of pois) {
              if (!p.location || usedPOIs.has(p.name) || p.name === node.name || seenNames.has(p.name)) continue;
              if (!this.isValidAttractionName(p.name)) continue;
              seenNames.add(p.name);
              allCandidates.push({
                name: p.name,
                address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
                location: p.location,
                rating: p.rating,
                typeName: (p as any).typeName || '',
              });
            }
          } catch (e) {
            console.warn(`[Pipeline] Search failed for keyword "${kw}":`, e);
          }
        }

        if (allCandidates.length === 0) {
          console.warn(`[Pipeline] No candidates found for invalid "${node.name}"`);
          continue;
        }

        // LLM 从候选中选最佳
        const candidateList = allCandidates.slice(0, 10).map((c, i) =>
          `${i + 1}. ${c.name}${c.rating ? `（评分${c.rating}）` : ''}${c.typeName ? `[${c.typeName}]` : ''}`
        ).join('\n');

        const selectPrompt = `需要替换不合理景点"${node.name}"（原因：${issue.reason}）。

候选景点：
${candidateList}

选择1个最适合旅游的景点。要求：
- 绝对不要选：学校、学院、大学、职业技术学院、培训机构、政府机构、垃圾处理/分类相关设施、生活服务类场所
- 必须是游客会想去的地方
- 如果所有候选都不适合旅游，返回 0

只返回序号数字。`;

        try {
          const pickResult = await deepseekClient.chat([
            { role: 'system', content: '你是旅游景点筛选专家。只返回一个数字序号。如果没有合适的候选，返回0。' },
            { role: 'user', content: selectPrompt },
          ]);
          const pickIndex = parseInt(pickResult.trim(), 10) - 1;
          if (pickIndex === -1) {
            console.warn(`[Pipeline] LLM rejected all candidates for invalid "${node.name}", trying fallback search...`);
            // 兜底：用通用关键词再搜一轮
            let fallbackFound = false;
            for (const fallbackKw of ['景点', '公园', '博物馆', '广场']) {
              try {
                const fallbackPois = await amapClient.searchAround(node.location, 12000, {
                  keywords: fallbackKw,
                  types: '110000|140000',
                  pageSize: 10,
                  sortRule: 'distance',
                });
                const fallbackPoi = fallbackPois.find(p => 
                  p.location && !usedPOIs.has(p.name) && p.name !== node.name 
                  && !seenNames.has(p.name) && this.isValidAttractionName(p.name)
                );
                if (fallbackPoi) {
                  console.log(`[Pipeline] Fallback found "${fallbackPoi.name}" for invalid "${node.name}"`);
                  usedPOIs.delete(node.name);
                  node.name = fallbackPoi.name;
                  node.address = [fallbackPoi.city, fallbackPoi.district, fallbackPoi.address].filter(Boolean).join('') || '';
                  node.location = fallbackPoi.location;
                  node.description = '';
                  node.activity = node.activity?.replace(/：.*/, `：${fallbackPoi.name}`) || node.activity;
                  usedPOIs.add(fallbackPoi.name);
                  fallbackFound = true;
                  break;
                }
              } catch { /* ignore */ }
            }
            if (!fallbackFound) {
              console.warn(`[Pipeline] Fallback also failed for invalid "${node.name}", keeping as-is`);
            }
            continue;
          }
          const picked = (pickIndex >= 0 && pickIndex < allCandidates.length) ? allCandidates[pickIndex] : allCandidates[0];

          console.log(`[Pipeline] LLM picked "${picked.name}" for replacing invalid "${node.name}"`);
          usedPOIs.delete(node.name);
          node.name = picked.name;
          node.address = picked.address;
          node.location = picked.location;
          node.description = picked.rating ? `评分${picked.rating}` : '';
          node.activity = node.activity?.replace(/：.*/, `：${picked.name}`) || node.activity;
          usedPOIs.add(picked.name);
        } catch (e) {
          const fallback = allCandidates[0];
          console.warn(`[Pipeline] LLM selection failed, falling back to "${fallback.name}":`, e);
          usedPOIs.delete(node.name);
          node.name = fallback.name;
          node.address = fallback.address;
          node.location = fallback.location;
          node.description = fallback.rating ? `评分${fallback.rating}` : '';
          node.activity = node.activity?.replace(/：.*/, `：${fallback.name}`) || node.activity;
          usedPOIs.add(fallback.name);
        }
      }
    } catch (e) {
      console.warn('[Pipeline] Invalid attraction review failed, skipping:', e);
    }
  }

  /**
   * LLM 审查景点合理性并替换同质化严重的景点
   * 
   * 流程：
   * 1. 把所有景点节点按天整理发给 LLM
   * 2. LLM 一次性返回同质化或低趣味的景点及建议替换的类型
   * 3. 逐个用高德搜索建议类型的附近景点进行替换
   */
  private async reviewAndFixAttractions(
    nodes: TravelNode[], destination: string, usedPOIs: Set<string>
  ): Promise<void> {
    const attractionNodes = nodes.filter(n => n.type === 'attraction');
    if (attractionNodes.length === 0) return;

    const attractionList = attractionNodes.map((n, i) =>
      `${i + 1}. 第${n.dayIndex}天${n.timeSlot}：${n.name}`
    ).join('\n');

    const prompt = `以下是${destination}旅行行程中的所有景点安排，请审查是否合理：

${attractionList}

请按以下优先级检查问题（优先级从高到低）：
1. 【最高优先级】宗祠/祠堂/庙宇过多（如安排了2个以上的祠堂、庙宇、宗祠类景点），这类景点必须优先标记替换
2. 同类型景点扎堆（如连续多个公园、连续多个博物馆、连续多个古镇）
3. 趣味性低的景点过多（如多个政府广场、普通学校、无特色的小公园、水利设施等）
4. 整体缺乏多样性（应该有自然风光、人文历史、现代体验、休闲娱乐等不同类型）

重要：最多只标记5个需要替换的景点，不一定要标满5个，只标记确实有问题的。宗祠/祠堂/庙宇类问题必须排在最前面。

对于有问题的景点，请给出应该替换成什么类型。
注意：suggestedKeywords 必须是简短的、可直接用于地图搜索的关键词数组，每个关键词2-4个字。
返回JSON数组，只包含需要替换的项（最多5项），宗祠类问题排在前面，格式：
[{"index": 序号, "reason": "问题原因", "isTemple": true或false, "suggestedKeywords": ["购物中心", "步行街", "夜市"]}]

isTemple 字段：如果该景点是宗祠/祠堂/庙宇类，设为 true，否则 false。

suggestedKeywords 示例（必须简短具体）：
- 想替换成商业区：["购物中心", "步行街", "商业广场"]
- 想替换成文创类：["文创园", "艺术馆", "创意园"]
- 想替换成现代体验：["科技馆", "展览馆", "体验馆"]
- 想替换成休闲娱乐：["游乐场", "密室逃脱", "电影院"]
- 想替换成自然风光：["湖", "山", "海滨栈道"]

如果所有景点都合理，返回空数组 []。只返回JSON，不要其他内容。`;

    try {
      const issues = await deepseekClient.chatWithJson<Array<{
        index: number; reason: string; isTemple?: boolean; suggestedKeywords: string[];
      }>>([
        { role: 'system', content: '你是一个资深旅行规划师，擅长审查行程中的景点安排是否多样有趣。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);

      if (!issues || issues.length === 0) {
        console.log('[Pipeline] Attraction review: all OK');
        return;
      }

      // 宗祠类优先排序，然后限制最多5个
      const templePattern = /宗祠|祠堂|庙宇|庙|佛祖|土地庙|神庙|关帝|城隍|天后宫/;
      const sorted = issues.sort((a, b) => {
        const aIsTemple = a.isTemple || templePattern.test(a.reason);
        const bIsTemple = b.isTemple || templePattern.test(b.reason);
        if (aIsTemple && !bIsTemple) return -1;
        if (!aIsTemple && bIsTemple) return 1;
        return 0;
      });
      const limitedIssues = sorted.slice(0, 5);

      console.log(`[Pipeline] Attraction review: ${issues.length} issues found, processing ${limitedIssues.length} (max 5)`);

      for (const issue of limitedIssues) {
        const nodeIndex = issue.index - 1;
        if (nodeIndex < 0 || nodeIndex >= attractionNodes.length) continue;

        const node = attractionNodes[nodeIndex];
        if (!node.location) continue;

        // 兼容旧格式：如果 LLM 返回了 suggestedType 而不是 suggestedKeywords
        const keywords: string[] = issue.suggestedKeywords 
          || ((issue as any).suggestedType ? (issue as any).suggestedType.split(/[或、,，]/).map((s: string) => s.trim()).filter(Boolean) : []);
        
        if (keywords.length === 0) continue;

        console.log(`[Pipeline] Fixing attraction: "${node.name}" (${issue.reason}) -> keywords: [${keywords.join(', ')}]`);

        // 收集所有关键词的候选，硬过滤只排除明显非景点（公司、培训机构等）
        const allCandidates: Array<{ name: string; address: string; location: string; rating?: string; typeName?: string }> = [];
        const seenNames = new Set<string>();

        for (const kw of keywords) {
          try {
            const pois = await amapClient.searchAround(node.location, 8000, {
              keywords: kw,
              types: '110000|140000',
              pageSize: 15,
              sortRule: 'distance',
            });
            for (const p of pois) {
              if (!p.location || usedPOIs.has(p.name) || p.name === node.name || seenNames.has(p.name)) continue;
              if (!this.isValidAttractionName(p.name)) continue; // 只过滤明显非景点
              seenNames.add(p.name);
              allCandidates.push({
                name: p.name,
                address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
                location: p.location,
                rating: p.rating,
                typeName: (p as any).typeName || (p as any).type || '',
              });
            }
          } catch (e) {
            console.warn(`[Pipeline] Search failed for keyword "${kw}":`, e);
          }
        }

        // 兜底：通用关键词补充候选
        if (allCandidates.length < 3) {
          for (const kw of ['景点', '公园', '广场']) {
            try {
              const pois = await amapClient.searchAround(node.location, 10000, {
                keywords: kw,
                types: '110000|140000',
                pageSize: 10,
                sortRule: 'distance',
              });
              for (const p of pois) {
                if (!p.location || usedPOIs.has(p.name) || p.name === node.name || seenNames.has(p.name)) continue;
                if (!this.isValidAttractionName(p.name)) continue;
                seenNames.add(p.name);
                allCandidates.push({
                  name: p.name,
                  address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
                  location: p.location,
                  rating: p.rating,
                  typeName: (p as any).typeName || (p as any).type || '',
                });
              }
            } catch (e) { /* ignore */ }
            if (allCandidates.length >= 8) break;
          }
        }

        if (allCandidates.length === 0) {
          console.warn(`[Pipeline] No candidates found for "${node.name}"`);
          continue;
        }

        // 让 LLM 从候选中选择最适合的景点
        const candidateList = allCandidates.slice(0, 10).map((c, i) =>
          `${i + 1}. ${c.name}${c.rating ? `（评分${c.rating}）` : ''}${c.typeName ? `[${c.typeName}]` : ''}`
        ).join('\n');

        const selectPrompt = `当前行程需要替换景点"${node.name}"，原因：${issue.reason}

以下是附近的候选景点：
${candidateList}

请从中选择1个最适合作为旅游景点的选项。要求：
- 必须是真正的旅游景点、公园、商业街、文化场所等，适合游客游览
- 绝对不要选：学校、学院、大学、职业技术学院、培训机构、政府机构、垃圾处理/分类相关设施、生活服务类场所
- 优先选择评分高、知名度高、趣味性强的景点
- 如果所有候选都不适合旅游，返回 0

只返回选中的序号（数字），不要其他内容。`;

        try {
          const pickResult = await deepseekClient.chat([
            { role: 'system', content: '你是旅游景点筛选专家。只返回一个数字序号。如果没有合适的候选，返回0。' },
            { role: 'user', content: selectPrompt },
          ]);
          const pickIndex = parseInt(pickResult.trim(), 10) - 1;
          if (pickIndex === -1) {
            console.warn(`[Pipeline] LLM rejected all candidates for "${node.name}"`);
            continue;
          }
          const picked = (pickIndex >= 0 && pickIndex < allCandidates.length) ? allCandidates[pickIndex] : allCandidates[0];

          console.log(`[Pipeline] LLM picked "${picked.name}" for replacing "${node.name}"`);
          usedPOIs.delete(node.name);
          node.name = picked.name;
          node.address = picked.address;
          node.location = picked.location;
          node.description = picked.rating ? `评分${picked.rating}` : '';
          node.activity = node.activity?.replace(/：.*/, `：${picked.name}`) || node.activity;
          usedPOIs.add(picked.name);
        } catch (e) {
          // LLM 失败时回退到第一个候选
          const fallback = allCandidates[0];
          console.warn(`[Pipeline] LLM selection failed, falling back to "${fallback.name}":`, e);
          usedPOIs.delete(node.name);
          node.name = fallback.name;
          node.address = fallback.address;
          node.location = fallback.location;
          node.description = fallback.rating ? `评分${fallback.rating}` : '';
          node.activity = node.activity?.replace(/：.*/, `：${fallback.name}`) || node.activity;
          usedPOIs.add(fallback.name);
        }
      }
    } catch (e) {
      console.warn('[Pipeline] Attraction review failed, skipping:', e);
    }
  }

  /**
   * 长途旅行换酒店后处理（≥5天触发）
   * 
   * 在行程全部生成完毕后，根据天数决定换酒店时机，
   * 为后续几天选择更便利的酒店，插入退房→午餐→入住节点。
   * 
   * 换酒店规则：
   * - ≤4天：不换
   * - 5天：Day 4 换（服务 Day 4-5）
   * - 6天：Day 4 换（服务 Day 4-6）
   * - 7天：Day 4 换（服务 Day 4-7）
   * - 8天：Day 4 换 + Day 6 换（服务 Day 4-5, Day 6-8）
   * - 9天：Day 4 换 + Day 7 换（服务 Day 4-6, Day 7-9）
   * - 10天：Day 4 换 + Day 7 换（服务 Day 4-6, Day 7-10）
   * - 最后一天绝不换
   */
  private async injectHotelChanges(
    allNodes: TravelNode[],
    days: number,
    scoredAttractions: ScoredPOI[],
    hotelAssignments: DailyHotelAssignment[],
    destination: string
  ): Promise<void> {
    // 确定换酒店的天
    const changeDays = this.getHotelChangeDays(days);
    if (changeDays.length === 0) return;

    console.log(`[Pipeline] Hotel change days for ${days}-day trip: ${changeDays.join(', ')}`);

    // 收集每天的景点位置，用于计算后续天的活动中心
    const dayAttractionLocations = new Map<number, string[]>();
    for (const node of allNodes) {
      if (node.type !== 'attraction' || !node.location) continue;
      if (!dayAttractionLocations.has(node.dayIndex)) {
        dayAttractionLocations.set(node.dayIndex, []);
      }
      dayAttractionLocations.get(node.dayIndex)!.push(node.location);
    }

    // 当前酒店（初始为第一天的酒店）
    let currentHotel = hotelAssignments[0]?.hotel;
    if (!currentHotel) return;

    // 累积所有已住过的酒店名，换酒店时排除这些
    const usedHotelNames = new Set<string>([currentHotel.name]);

    for (const changeDay of changeDays) {
      // 计算 changeDay 到行程结束（或下一个换酒店日）的景点活动中心
      const nextChangeDay = changeDays.find(d => d > changeDay);
      const endDay = nextChangeDay ? nextChangeDay - 1 : days;

      const futureLocs: string[] = [];
      for (let d = changeDay; d <= endDay; d++) {
        const locs = dayAttractionLocations.get(d) || [];
        futureLocs.push(...locs);
      }

      if (futureLocs.length === 0) {
        console.warn(`[Pipeline] No attraction locations for days ${changeDay}-${endDay}, skipping hotel change`);
        continue;
      }

      // 计算未来几天的景点中心
      let sumLng = 0, sumLat = 0;
      for (const loc of futureLocs) {
        const [lng, lat] = loc.split(',').map(Number);
        sumLng += lng;
        sumLat += lat;
      }
      const futureCentroid = {
        lng: sumLng / futureLocs.length,
        lat: sumLat / futureLocs.length,
      };

      console.log(`[Pipeline] Hotel change Day ${changeDay}: future centroid for days ${changeDay}-${endDay} = ${futureCentroid.lng.toFixed(4)},${futureCentroid.lat.toFixed(4)}`);

      // 搜索新酒店（靠近未来活动中心，排除所有已住过的酒店）
      let newHotel = await this.searchNearbyHotel(futureCentroid, usedHotelNames);
      
      // 兜底：如果排除已住酒店后找不到，放宽限制（允许同名但不同分店）
      if (!newHotel) {
        console.warn(`[Pipeline] No hotel found excluding used names, retrying without exclusion...`);
        newHotel = await this.searchNearbyHotel(futureCentroid);
      }
      
      // 再兜底：用各个未来天的景点位置逐个搜索
      if (!newHotel) {
        for (let d = changeDay; d <= endDay && !newHotel; d++) {
          const locs = dayAttractionLocations.get(d) || [];
          for (const loc of locs) {
            if (newHotel) break;
            const [lng, lat] = loc.split(',').map(Number);
            newHotel = await this.searchNearbyHotel({ lng, lat }, usedHotelNames);
          }
        }
      }
      
      if (!newHotel) {
        console.warn(`[Pipeline] Could not find any hotel for Day ${changeDay} change after all retries, skipping`);
        continue;
      }

      const prevHotel = currentHotel;
      console.log(`[Pipeline] Day ${changeDay}: HOTEL CHANGE "${prevHotel.name}" -> "${newHotel.name}"`);

      // 插入换酒店节点：退房(11:30) → 午餐保持不变 → 入住(13:30)
      // 找到当天的 lunch 节点，在它前面插入退房，后面插入入住
      const dayNodes = allNodes.filter(n => n.dayIndex === changeDay);
      const lunchNode = dayNodes.find(n => n.timeSlot === 'lunch');
      const lunchTime = lunchNode?.scheduledTime || '12:00';

      // 退房节点：午餐前 30 分钟
      const checkoutTime = this.addMinutes(lunchTime, -30);
      const checkoutNode = this.createNode(
        changeDay, 0, 'checkout', checkoutTime,
        prevHotel.name, 'hotel', prevHotel.address,
        '退房：办理退房手续，前往新住处', prevHotel.location
      );
      checkoutNode.estimatedDuration = 20;

      // 入住节点：午餐后 30 分钟（假设午餐 90 分钟）
      const lunchDuration = lunchNode?.estimatedDuration || 90;
      const checkinTime = this.addMinutes(lunchTime, lunchDuration + 15);
      const checkinNode = this.createNode(
        changeDay, 0, 'checkin', checkinTime,
        newHotel.name, 'hotel', newHotel.address,
        '入住：办理入住/寄存行李', newHotel.location
      );
      checkinNode.estimatedDuration = 20;

      allNodes.push(checkoutNode, checkinNode);

      // 更新当天及后续天的回酒店节点
      for (let d = changeDay; d <= endDay; d++) {
        const hotelReturnNode = allNodes.find(
          n => n.dayIndex === d && n.timeSlot === 'hotel' && n.type === 'hotel'
        );
        if (hotelReturnNode) {
          hotelReturnNode.name = newHotel.name;
          hotelReturnNode.address = newHotel.address;
          hotelReturnNode.location = newHotel.location;
          hotelReturnNode.description = '回酒店：休息';
        }
      }

      // 移除当天早上可能存在的旧换酒店节点（planHotelStrategy 可能已经生成了）
      const oldCheckout = allNodes.findIndex(
        n => n.dayIndex === changeDay && n.timeSlot === 'checkout' && n !== checkoutNode
      );
      if (oldCheckout >= 0) {
        allNodes.splice(oldCheckout, 1);
      }
      const oldCheckin = allNodes.findIndex(
        n => n.dayIndex === changeDay && n.timeSlot === 'checkin' && n !== checkinNode
      );
      if (oldCheckin >= 0) {
        allNodes.splice(oldCheckin, 1);
      }

      currentHotel = newHotel;
      usedHotelNames.add(newHotel.name);
    }

    // 验证：打印最终每天的酒店分配
    const hotelByDay = new Map<number, string>();
    for (const node of allNodes) {
      if (node.timeSlot === 'hotel' && node.type === 'hotel') {
        hotelByDay.set(node.dayIndex, node.name);
      }
    }
    console.log(`[Pipeline] Final hotel assignments after inject:`);
    for (let d = 1; d <= days; d++) {
      console.log(`[Pipeline]   Day ${d}: ${hotelByDay.get(d) || '(no hotel node)'}`);
    }

    // 重新排序所有节点
    this.reorderNodes(allNodes);
  }

  /**
   * 根据总天数确定换酒店的天
   * 规则：不能在最后一天换，前 3 天不换
   */
  private getHotelChangeDays(days: number): number[] {
    if (days <= 4) return [];
    if (days <= 7) return [4];           // 5-7天：Day 4 换一次
    if (days === 8) return [4, 6];       // 8天：Day 4 + Day 6
    return [4, 7];                        // 9-10天：Day 4 + Day 7
  }

  /**
   * 规划酒店策略
   * 
   * 核心逻辑：酒店应该靠近当天游玩的景点，而不是固定一个酒店
   * 
   * 规则：
   * 1. 每天晚上住的酒店应该靠近当天的景点区域
   * 2. 如果连续几天在同一区域，住同一个酒店
   * 3. 跨区时换酒店
   * 4. 最后一天不需要回酒店，所以最后一天的酒店分配沿用前一天
   */
  private async planHotelStrategy(
    days: number,
    clusterResult: ClusterResult,
    allHotels: EnrichedPOI[],
    scoredHotels: ScoredPOI[]
  ): Promise<DailyHotelAssignment[]> {
    const assignments: DailyHotelAssignment[] = [];
    
    // 按出现顺序去重，保留 cluster 切换顺序
    const orderedClusterIds: string[] = [];
    for (const cid of clusterResult.dailyClusterAssignment) {
      if (orderedClusterIds.length === 0 || orderedClusterIds[orderedClusterIds.length - 1] !== cid) {
        orderedClusterIds.push(cid);
      }
    }
    
    console.log(`[Pipeline] Trip: ${days} days, ${orderedClusterIds.length} cluster segments: ${orderedClusterIds.join(' -> ')}`);

    // 为每个区域选择最佳酒店，确保不同区域选不同酒店
    const clusterHotelMap = new Map<string, EnrichedPOI>();
    const usedHotelNames = new Set<string>();
    
    for (const clusterId of orderedClusterIds) {
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      if (!cluster) {
        console.log(`[Pipeline] WARNING: Cluster "${clusterId}" not found!`);
        continue;
      }
      
      const hotel = this.selectHotelForCluster(cluster, allHotels, scoredHotels, usedHotelNames);
      if (hotel) {
        clusterHotelMap.set(clusterId, hotel);
        usedHotelNames.add(hotel.name);
        console.log(`[Pipeline] Cluster "${cluster.name}" (${clusterId}) -> Hotel "${hotel.name}"`);
      }
    }

    // 如果某些 cluster 没选到酒店，搜索附近
    for (const clusterId of orderedClusterIds) {
      if (clusterHotelMap.has(clusterId)) continue;
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      if (!cluster) continue;
      
      console.log(`[Pipeline] Cluster "${cluster.name}" has no hotel, searching nearby...`);
      const nearbyHotel = await this.searchNearbyHotel(cluster.centroid);
      if (nearbyHotel && !usedHotelNames.has(nearbyHotel.name)) {
        clusterHotelMap.set(clusterId, nearbyHotel);
        usedHotelNames.add(nearbyHotel.name);
        console.log(`[Pipeline] Found nearby hotel "${nearbyHotel.name}" for cluster "${cluster.name}"`);
      } else if (nearbyHotel) {
        // 搜到的酒店名字和已选的重复，但还是用它（总比没有好）
        clusterHotelMap.set(clusterId, nearbyHotel);
        console.log(`[Pipeline] Using duplicate nearby hotel "${nearbyHotel.name}" for cluster "${cluster.name}"`);
      }
    }

    // 兜底酒店
    let fallbackHotel: EnrichedPOI | null = this.selectCentralHotel(allHotels, clusterResult.clusters);
    if (!fallbackHotel) {
      fallbackHotel = await this.searchNearbyHotel(clusterResult.clusters[0]?.centroid);
    }
    if (!fallbackHotel) {
      throw new Error('HOTEL_NOT_FOUND: 无法找到合适的酒店，请重试');
    }

    // 核心逻辑：酒店跟着 cluster 走
    // 同一个 cluster 连续的天数住同一个酒店，换 cluster 才换酒店
    // 最后一天绝对不换酒店（沿用前一天的）
    // ≥5天的长途旅行：全程先用同一家酒店，换酒店由后处理 injectHotelChanges 决定
    let currentHotel: EnrichedPOI | null = null;
    let currentClusterId: string | null = null;

    // ≥5天时，选第一个 cluster 的酒店作为初始酒店，后处理会在合适的天换
    const longTrip = days >= 5;

    for (let day = 1; day <= days; day++) {
      const clusterId = clusterResult.dailyClusterAssignment[day - 1];
      const isLastDay = day === days;

      // 最后一天：沿用前一天的酒店，不换
      if (isLastDay && currentHotel) {
        assignments.push({
          dayIndex: day,
          clusterId,
          hotel: currentHotel,
          isNewHotel: false,
        });
        continue;
      }

      // 长途旅行：全程不在这里换酒店，交给后处理
      if (longTrip && currentHotel) {
        assignments.push({
          dayIndex: day,
          clusterId,
          hotel: currentHotel,
          isNewHotel: false,
        });
        continue;
      }

      // cluster 没变 → 酒店不变
      if (clusterId === currentClusterId && currentHotel) {
        assignments.push({
          dayIndex: day,
          clusterId,
          hotel: currentHotel,
          isNewHotel: false,
        });
        continue;
      }

      // cluster 变了 → 换酒店
      const clusterHotel = clusterHotelMap.get(clusterId) || fallbackHotel;
      const isNewHotel = currentHotel !== null && currentHotel.name !== clusterHotel.name;

      if (isNewHotel) {
        console.log(`[Pipeline] Day ${day}: *** CHANGING HOTEL *** "${currentHotel!.name}" -> "${clusterHotel.name}" (cluster: ${currentClusterId} -> ${clusterId})`);
      }

      currentHotel = clusterHotel;
      currentClusterId = clusterId;

      assignments.push({
        dayIndex: day,
        clusterId,
        hotel: clusterHotel,
        isNewHotel,
      });
    }

    return assignments;
  }

  /**
   * Step 3: 锚点选择 —— 在规划前确定必须出现的景点
   * 
   * 根据城市体验画像的 must_have 域，从所有 POI 中为每个必须体验域
   * 选出最佳代表景点作为"锚点"。
   * 
   * 新增：根据景点规模分配 timeWeight：
   * - 大景点（山、大型景区、古镇）= 1.0（占整天）
   * - 中景点（祖庙、博物馆、园林）= 0.5（占半天）
   */
  /**
   * 锚点选择 —— 硬约束阶段
   * 
   * 这不是推荐，而是约束。
   * must_have 域的锚点必须存在，否则行程不合法。
   * 
   * 选择顺序：
   * 1. 每个 must_have 域选最佳锚点（硬约束）
   * 2. 天数充裕时，为 optional 域选锚点
   * 3. 从 must_have 域选第二锚点（确保热门景点不遗漏）
   * 4. 全局高分兜底
   */
  private selectAnchors(
    cityProfile: CityProfile,
    scoredAttractions: ScoredPOI[],
    days: number
  ): AnchorPOI[] {
    const anchors: AnchorPOI[] = [];
    const usedNames = new Set<string>();

    // === 候选池反向校验：发现城市画像遗漏的高质量域 ===
    // 两层保护：
    // 1. 如果候选池中某个 domain 有 CORE_ATTRACTION 角色的景点，该 domain 必须在画像中
    // 2. 如果候选池中某个 domain 有高分景点（score >= 0.7 且非 FILLER），自动补入 optional
    const allProfileDomains = new Set([...cityProfile.mustHave, ...cityProfile.optional]);
    const domainTopScores = new Map<ExperienceDomain, { score: number; name: string; role: string }>();
    
    for (const a of scoredAttractions) {
      const domain = a.poi.experienceDomain;
      if (!domain) continue;
      if (a.poi.tourismRole === 'FILLER') continue;
      
      const existing = domainTopScores.get(domain);
      if (!existing || a.score > existing.score || 
          (a.poi.tourismRole === 'CORE_ATTRACTION' && existing.role !== 'CORE_ATTRACTION')) {
        domainTopScores.set(domain, { score: a.score, name: a.poi.name, role: a.poi.tourismRole || 'FILLER' });
      }
    }
    
    const POOL_INJECT_THRESHOLD = 0.7;
    for (const [domain, top] of domainTopScores) {
      if (allProfileDomains.has(domain)) continue;
      
      // 有 CORE_ATTRACTION 的 domain 无条件补入（这是城市名片级景点）
      if (top.role === 'CORE_ATTRACTION') {
        cityProfile.optional.unshift(domain); // unshift 让它排在 optional 前面，优先选
        allProfileDomains.add(domain);
        console.log(`[Pipeline] Pool-inject (CORE): domain "${domain}" added to optional front (top="${top.name}", score=${top.score.toFixed(2)})`);
      } else if (top.score >= POOL_INJECT_THRESHOLD) {
        cityProfile.optional.push(domain);
        allProfileDomains.add(domain);
        console.log(`[Pipeline] Pool-inject (score): domain "${domain}" added to optional (top="${top.name}", score=${top.score.toFixed(2)}, role=${top.role})`);
      }
    }
    
    // === 硬约束：每个 must_have 域必须有锚点 ===
    for (const domain of cityProfile.mustHave) {
      const candidates = scoredAttractions
        .filter(a => a.poi.experienceDomain === domain && !usedNames.has(a.poi.name))
        .sort((a, b) => b.score - a.score);
      
      if (candidates.length > 0) {
        const best = candidates[0];
        const tw = this.inferTimeWeight(best.poi);
        anchors.push({ poi: best.poi, domain, score: best.score, timeWeight: tw });
        usedNames.add(best.poi.name);
        console.log(`[Pipeline] MUST-HAVE anchor for ${domain}: ${best.poi.name} (score=${best.score.toFixed(2)}, role=${best.poi.tourismRole}, timeWeight=${tw})`);
      } else {
        // 硬约束失败：降低门槛再试一次（score >= 0 的都接受）
        const fallback = scoredAttractions
          .filter(a => a.poi.experienceDomain === domain && !usedNames.has(a.poi.name))
          .sort((a, b) => b.score - a.score);
        
        if (fallback.length > 0) {
          const best = fallback[0];
          const tw = this.inferTimeWeight(best.poi);
          anchors.push({ poi: best.poi, domain, score: best.score, timeWeight: tw });
          usedNames.add(best.poi.name);
          console.warn(`[Pipeline] MUST-HAVE anchor for ${domain} (fallback): ${best.poi.name} (score=${best.score.toFixed(2)})`);
        } else {
          console.error(`[Pipeline] CRITICAL: No POI found for must_have domain: ${domain}. City experience coverage will be incomplete.`);
        }
      }
    }
    
    const totalWeight = () => anchors.reduce((s, a) => s + (a.timeWeight || 0.5), 0);
    
    // optional 域锚点（天数充裕时）
    if (totalWeight() + 0.5 <= days) {
      for (const domain of cityProfile.optional) {
        if (totalWeight() + 0.5 > days) break;
        if (anchors.length >= days) break;
        
        const candidates = scoredAttractions
          .filter(a => a.poi.experienceDomain === domain && !usedNames.has(a.poi.name))
          .sort((a, b) => b.score - a.score);
        
        if (candidates.length > 0) {
          const best = candidates[0];
          const tw = this.inferTimeWeight(best.poi);
          anchors.push({ poi: best.poi, domain, score: best.score, timeWeight: tw });
          usedNames.add(best.poi.name);
          console.log(`[Pipeline] Optional anchor for ${domain}: ${best.poi.name} (score=${best.score.toFixed(2)}, timeWeight=${tw})`);
        }
      }
    }
    
    // must_have 域的第二锚点（确保热门景点不遗漏）
    if (totalWeight() + 0.5 <= days && anchors.length < days) {
      const allDomains = [...cityProfile.mustHave, ...cityProfile.optional];
      const domainCandidates = allDomains.map(domain => ({
        domain,
        candidates: scoredAttractions
          .filter(a => a.poi.experienceDomain === domain && !usedNames.has(a.poi.name) && a.score >= 0.5)
          .sort((a, b) => b.score - a.score),
      })).filter(d => d.candidates.length > 0)
        .sort((a, b) => b.candidates[0].score - a.candidates[0].score);
      
      for (const { domain, candidates } of domainCandidates) {
        if (totalWeight() + 0.5 > days) break;
        if (anchors.length >= days) break;
        
        const best = candidates[0];
        const tw = this.inferTimeWeight(best.poi);
        anchors.push({ poi: best.poi, domain, score: best.score, timeWeight: tw });
        usedNames.add(best.poi.name);
        console.log(`[Pipeline] Extra anchor for ${domain}: ${best.poi.name} (score=${best.score.toFixed(2)}, timeWeight=${tw})`);
      }
    }
    
    // 全局高分兜底（不限域，但排除 FILLER）
    if (anchors.length < days && totalWeight() + 0.5 <= days) {
      const remaining = scoredAttractions
        .filter(a => !usedNames.has(a.poi.name) && a.score >= 0.5 && a.poi.tourismRole !== 'FILLER')
        .sort((a, b) => b.score - a.score);
      
      for (const candidate of remaining) {
        if (totalWeight() + 0.5 > days) break;
        if (anchors.length >= days) break;
        
        const tw = this.inferTimeWeight(candidate.poi);
        anchors.push({
          poi: candidate.poi,
          domain: candidate.poi.experienceDomain || 'NATURAL_LANDSCAPE',
          score: candidate.score,
          timeWeight: tw,
        });
        usedNames.add(candidate.poi.name);
        console.log(`[Pipeline] Global top anchor: ${candidate.poi.name} (score=${candidate.score.toFixed(2)}, domain=${candidate.poi.experienceDomain}, timeWeight=${tw})`);
      }
    }
    
    console.log(`[Pipeline] Selected ${anchors.length} anchors for ${days}-day trip (total weight=${totalWeight().toFixed(1)})`);
    console.log(`[Pipeline] Must-have coverage: ${cityProfile.mustHave.map(d => {
      const a = anchors.find(a => a.domain === d);
      return a ? `${d}✓(${a.poi.name})` : `${d}✗`;
    }).join(', ')}`);
    return anchors;
  }

  /**
   * 根据景点属性推断时间权重
   * 1.0 = 整天（大景点），0.5 = 半天（中景点）
   */
  private inferTimeWeight(poi: EnrichedPOI): number {
    const role = poi.tourismRole;
    const domain = poi.experienceDomain;
    const cat = poi.category || '';
    
    // 大景点 = 整天
    // 山、大型景区、古镇、森林公园
    if (['mountain', 'forest', 'scenic_area'].includes(cat)) return 1.0;
    if (domain === 'NATURAL_LANDSCAPE' && role === 'CORE_ATTRACTION') return 1.0;
    if (domain === 'HISTORIC_TOWN') return 1.0;
    if (role === 'MAJOR_AREA' && ['ancient_town'].includes(cat)) return 1.0;
    
    // 中景点 = 半天
    // 祖庙、博物馆、园林、文化地标
    return 0.5;
  }

  /**
   * 将锚点分配到具体的天（Step 4 核心改造）
   * 
   * 新策略：
   * - timeWeight=1.0 的大景点独占一天，该天只围绕它扩展附近 POI
   * - timeWeight=0.5 的中景点占半天，同一天可以放两个半天锚点
   * - 分配时优先考虑地理位置（最近的聚类），再解决冲突
   */
  private assignAnchorsToDay(
      anchors: AnchorPOI[],
      clusterResult: ClusterResult,
      dailyClusterAssignment: string[],
      days: number
    ): AnchorPOI[] {
      if (anchors.length === 0) return anchors;

      // === 新逻辑：锚点先定义天，cluster 服从天 ===

      // Step 1: 全天锚点（timeWeight >= 1.0）各占独立一天
      const fullDayAnchors = anchors.filter(a => (a.timeWeight || 0.5) >= 1.0);
      const halfDayAnchors = anchors.filter(a => (a.timeWeight || 0.5) < 1.0);

      // 每天的已用时间权重
      const dayUsedWeight = new Map<number, number>();
      for (let d = 1; d <= days; d++) dayUsedWeight.set(d, 0);

      let nextDay = 1;

      // 全天锚点：每个独占一天
      for (const anchor of fullDayAnchors) {
        if (nextDay > days) {
          // 天数不够，找剩余空间最大的天
          const bestDay = this.findAvailableDay(1, days, dayUsedWeight, anchor.timeWeight || 1.0);
          anchor.assignedDay = bestDay > 0 ? bestDay : days;
        } else {
          anchor.assignedDay = nextDay;
          nextDay++;
        }
        const d = anchor.assignedDay!;
        dayUsedWeight.set(d, (dayUsedWeight.get(d) || 0) + (anchor.timeWeight || 1.0));
        console.log(`[Pipeline] Full-day anchor "${anchor.poi.name}" -> Day ${d}`);
      }

      // Step 2: 半天锚点按距离贪心配对（distance < 18km 才能同一天）
      const PAIR_DISTANCE_LIMIT = 18;
      const unpairedHalf: AnchorPOI[] = [];
      const pairedSet = new Set<AnchorPOI>();

      // 按 score 降序，高分锚点优先配对
      const sortedHalf = [...halfDayAnchors].sort((a, b) => b.score - a.score);

      for (let i = 0; i < sortedHalf.length; i++) {
        if (pairedSet.has(sortedHalf[i])) continue;

        let bestPartner: AnchorPOI | null = null;
        let bestDist = Infinity;

        for (let j = i + 1; j < sortedHalf.length; j++) {
          if (pairedSet.has(sortedHalf[j])) continue;
          const locI = sortedHalf[i].poi.location;
          const locJ = sortedHalf[j].poi.location;
          if (!locI || !locJ) continue;

          const dist = amapClient.calculateDistance(locI, locJ);
          if (dist < PAIR_DISTANCE_LIMIT && dist < bestDist) {
            bestDist = dist;
            bestPartner = sortedHalf[j];
          }
        }

        if (bestPartner) {
          // 配对成功，共享一天
          const d = nextDay <= days ? nextDay++ : this.findAvailableDay(1, days, dayUsedWeight, 1.0);
          const assignDay = d > 0 ? d : days;

          sortedHalf[i].assignedDay = assignDay;
          bestPartner.assignedDay = assignDay;
          dayUsedWeight.set(assignDay, (dayUsedWeight.get(assignDay) || 0) + (sortedHalf[i].timeWeight || 0.5) + (bestPartner.timeWeight || 0.5));
          pairedSet.add(sortedHalf[i]);
          pairedSet.add(bestPartner);
          console.log(`[Pipeline] Half-day pair: "${sortedHalf[i].poi.name}" + "${bestPartner.poi.name}" -> Day ${assignDay} (dist=${bestDist.toFixed(1)}km)`);
        } else {
          unpairedHalf.push(sortedHalf[i]);
        }
      }

      // 未配对的半天锚点：各占一天
      for (const anchor of unpairedHalf) {
        if (pairedSet.has(anchor)) continue;
        const tw = anchor.timeWeight || 0.5;
        const d = nextDay <= days ? nextDay++ : this.findAvailableDay(1, days, dayUsedWeight, tw);
        const assignDay = d > 0 ? d : days;
        anchor.assignedDay = assignDay;
        dayUsedWeight.set(assignDay, (dayUsedWeight.get(assignDay) || 0) + tw);
        console.log(`[Pipeline] Unpaired half-day anchor "${anchor.poi.name}" -> Day ${assignDay}`);
      }

      // Step 3: 反向更新 dailyClusterAssignment —— 让 cluster 服从锚点
      // 对于有锚点的天，cluster 改为锚点所在的最近 cluster
      for (const anchor of anchors) {
        const d = anchor.assignedDay;
        if (!d || d < 1 || d > days) continue;
        if (!anchor.poi.location) continue;

        // 找锚点最近的 cluster
        let bestClusterId = dailyClusterAssignment[d - 1];
        let bestDist = Infinity;
        for (const cluster of clusterResult.clusters) {
          const dist = amapClient.calculateDistance(
            anchor.poi.location,
            `${cluster.centroid.lng},${cluster.centroid.lat}`
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestClusterId = cluster.id;
          }
        }

        // 如果该天的 cluster 和锚点不匹配，更新为锚点的 cluster
        if (dailyClusterAssignment[d - 1] !== bestClusterId) {
          console.log(`[Pipeline] Day ${d}: cluster reassigned from "${dailyClusterAssignment[d - 1]}" to "${bestClusterId}" (anchor: ${anchor.poi.name})`);
          dailyClusterAssignment[d - 1] = bestClusterId;
        }
      }

      // 无锚点的天保持原有 cluster 分配（密度填充）
      // 但需要确保不重复使用已被锚点占用的 cluster-day 组合
      // （这里不需要额外处理，因为 dailyClusterAssignment 已经被更新了）

      console.log('[Pipeline] Anchor-first day assignments:');
      anchors.forEach(a => console.log(`  Day ${a.assignedDay}: ${a.poi.name} [${a.domain}] weight=${a.timeWeight}`));

      console.log('[Pipeline] Updated daily cluster assignment:', dailyClusterAssignment.join(' -> '));

      // 打印每天的锚点时间占用
      for (let d = 1; d <= days; d++) {
        const w = dayUsedWeight.get(d) || 0;
        const dayAnchors = anchors.filter(a => a.assignedDay === d);
        if (dayAnchors.length > 0) {
          console.log(`[Pipeline] Day ${d} anchor weight: ${w} (${dayAnchors.map(a => a.poi.name).join(', ')})`);
        }
      }

      return anchors;
    }



  /**
   * 找到离 preferredDay 最近的、有足够空间的天
   */
  private findAvailableDay(
    preferredDay: number,
    days: number,
    dayUsedWeight: Map<number, number>,
    requiredWeight: number
  ): number {
    let bestDay = -1;
    let bestDist = Infinity;
    
    for (let d = 1; d <= days; d++) {
      const used = dayUsedWeight.get(d) || 0;
      if (used + requiredWeight <= 1.0) {
        const dist = Math.abs(d - preferredDay);
        if (dist < bestDist) {
          bestDist = dist;
          bestDay = d;
        }
      }
    }
    
    return bestDay;
  }

  /**
   * 第四步：让 LLM 决定每天的主题
   * 
   * 在选 POI 之前，先根据城市特色和聚类区域的 POI 分布，
   * 为每天规划一个体验主题。后续 POI 选择会优先匹配当天主题。
   */
  private async planDayThemes(
    destination: string,
    days: number,
    clusterResult: ClusterResult,
    dailyClusterAssignment: string[],
    attractions: ScoredPOI[]
  ): Promise<DayTheme[]> {
    // 构建每天区域的 POI 角色分布摘要
    const daySummaries: string[] = [];
    for (let day = 1; day <= days; day++) {
      const clusterId = dailyClusterAssignment[day - 1];
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      if (!cluster) {
        daySummaries.push(`第${day}天：区域信息不可用`);
        continue;
      }
      
      // 统计该区域的角色分布
      const roleDist: Record<string, string[]> = {};
      for (const attr of cluster.attractions) {
        const matched = attractions.find(a => a.poi.name === attr.name);
        const role = matched?.poi.tourismRole || 'FILLER';
        if (!roleDist[role]) roleDist[role] = [];
        roleDist[role].push(attr.name);
      }
      
      const roleDesc = Object.entries(roleDist)
        .map(([role, names]) => `${role}: ${names.slice(0, 5).join('、')}${names.length > 5 ? `等${names.length}个` : ''}`)
        .join('；');
      
      daySummaries.push(`第${day}天（${cluster.name}区域）：${roleDesc}`);
    }

    const prompt = `你是一个资深旅行规划师。请为${destination}的${days}天行程规划每天的主题。

重要：你现在只需要决定"今天应该是什么类型的一天"，不需要选择具体景点。
主题决定了当天的核心体验方向，后续算法会根据主题选择匹配的景点。

每天的区域和可用景点角色分布：
${daySummaries.join('\n')}

要求：
1. 每天一个鲜明的主题，如"岭南文化日"、"山水自然日"、"城市漫步日"、"历史人文日"等
2. 主题决定了当天的 CORE_ATTRACTION 必须是什么类型 —— 这是最关键的约束
3. 相邻两天的主题必须不同，保持体验节奏变化（文化→自然→城市→历史）
4. 第一天如果是下午到达，主题可以轻松些（城市漫步、美食探索）
5. 最后一天如果要赶车，主题可以是"休闲收尾"
6. preferredRoles 的第一个角色是当天 CORE 时段的硬约束，只有该角色的景点才能占据上午核心时段

返回JSON数组，格式：
[{
  "dayIndex": 1,
  "theme": "主题名称",
  "description": "一句话描述今天的体验重点",
  "preferredRoles": ["CORE_ATTRACTION", "MAJOR_AREA"],
  "preferredCategories": ["ancient_town", "historic_building", "temple"]
}]

可用的 roles: CORE_ATTRACTION, MAJOR_AREA, NATURE_RELAX, NIGHT_EXPERIENCE, CULTURAL_SITE, VIEWPOINT, SHOPPING_AREA, FILLER
可用的 categories: mountain, lake, river, sea, forest, scenic_area, ancient_town, temple, historic_building, ancestral_hall, memorial, museum, art_gallery, library, university, garden, park, botanical, zoo, commercial_street, plaza, other

只返回JSON，不要其他内容。`;

    try {
      const result = await deepseekClient.chatWithJson<Array<{
        dayIndex: number;
        theme: string;
        description: string;
        preferredRoles: string[];
        preferredCategories: string[];
      }>>([
        { role: 'system', content: '你是旅行规划专家。只返回JSON。' },
        { role: 'user', content: prompt }
      ]);
      
      const VALID_ROLES = [
        'CORE_ATTRACTION', 'MAJOR_AREA', 'NATURE_RELAX', 'NIGHT_EXPERIENCE',
        'CULTURAL_SITE', 'VIEWPOINT', 'SHOPPING_AREA', 'FILLER'
      ];
      
      const themes: DayTheme[] = [];
      for (const item of result) {
        if (item.dayIndex >= 1 && item.dayIndex <= days) {
          themes.push({
            dayIndex: item.dayIndex,
            theme: item.theme,
            description: item.description,
            preferredRoles: (item.preferredRoles || []).filter(r => VALID_ROLES.includes(r)) as TourismRole[],
            preferredCategories: item.preferredCategories || [],
          });
        }
      }
      
      // 补全缺失的天
      for (let day = 1; day <= days; day++) {
        if (!themes.find(t => t.dayIndex === day)) {
          themes.push({
            dayIndex: day,
            theme: '自由探索日',
            description: '随心游览当地特色',
            preferredRoles: ['CORE_ATTRACTION', 'MAJOR_AREA', 'NATURE_RELAX'],
            preferredCategories: [],
          });
        }
      }
      
      themes.sort((a, b) => a.dayIndex - b.dayIndex);
      
      console.log('[Pipeline] Day themes:');
      themes.forEach(t => console.log(`  Day ${t.dayIndex}: ${t.theme} - ${t.description} (roles: ${t.preferredRoles.join(',')})`));
      
      return themes;
    } catch (error) {
      console.warn('[Pipeline] LLM day theme planning failed, using defaults:', error);
      // 回退：交替文化日和自然日
      return Array.from({ length: days }, (_, i) => ({
        dayIndex: i + 1,
        theme: i % 2 === 0 ? '文化探索日' : '自然休闲日',
        description: i % 2 === 0 ? '探索当地文化和历史' : '享受自然风光和休闲时光',
        preferredRoles: i % 2 === 0 
          ? ['CORE_ATTRACTION', 'CULTURAL_SITE', 'MAJOR_AREA'] as TourismRole[]
          : ['NATURE_RELAX', 'CORE_ATTRACTION', 'MAJOR_AREA'] as TourismRole[],
        preferredCategories: i % 2 === 0 
          ? ['ancient_town', 'historic_building', 'temple', 'museum']
          : ['mountain', 'lake', 'river', 'forest', 'scenic_area', 'garden'],
      }));
    }
  }

  /**
   * 第五步：将 cluster 内的 POI 聚合成体验区域
   * 
   * 一个 cluster 可能有 30 个 POI，但实际上是 3 个可步行游览的区域。
   * 先识别这些区域，再让路线优化器按区域选择，而不是逐个 POI 竞争。
   */
  private identifyExperienceAreas(
    attractions: ScoredPOI[],
    restaurants: ScoredPOI[],
    maxRadius: number = 1.5  // 体验区域最大半径 1.5km（步行可达）
  ): ExperienceArea[] {
    if (attractions.length === 0) return [];
    
    // 简单的凝聚聚类：从每个 POI 出发，合并距离 < maxRadius 的邻居
    const assigned = new Set<number>();
    const areas: ExperienceArea[] = [];
    
    // 按评分排序，高分 POI 优先成为区域核心
    const sorted = attractions
      .map((a, i) => ({ ...a, originalIndex: i }))
      .sort((a, b) => b.score - a.score);
    
    for (const seed of sorted) {
      if (assigned.has(seed.originalIndex)) continue;
      if (!seed.poi.location) continue;
      
      // 以这个 POI 为核心，找出所有在 maxRadius 内的未分配 POI
      const areaAttractions: ScoredPOI[] = [seed];
      assigned.add(seed.originalIndex);
      
      for (const candidate of sorted) {
        if (assigned.has(candidate.originalIndex)) continue;
        if (!candidate.poi.location) continue;
        
        const dist = amapClient.calculateDistance(seed.poi.location, candidate.poi.location);
        if (dist <= maxRadius) {
          areaAttractions.push(candidate);
          assigned.add(candidate.originalIndex);
        }
      }
      
      // 找出区域内的餐厅
      const areaRestaurants = restaurants.filter(r => {
        if (!r.poi.location) return false;
        const dist = amapClient.calculateDistance(seed.poi.location!, r.poi.location);
        return dist <= maxRadius;
      });
      
      // 计算区域中心
      const lngs = areaAttractions.filter(a => a.poi.location).map(a => parseFloat(a.poi.location!.split(',')[0]));
      const lats = areaAttractions.filter(a => a.poi.location).map(a => parseFloat(a.poi.location!.split(',')[1]));
      const centroid = {
        lng: lngs.reduce((s, v) => s + v, 0) / lngs.length,
        lat: lats.reduce((s, v) => s + v, 0) / lats.length,
      };
      
      // 计算实际半径
      let maxDist = 0;
      for (const a of areaAttractions) {
        if (!a.poi.location) continue;
        const dist = amapClient.calculateDistance(`${centroid.lng},${centroid.lat}`, a.poi.location);
        if (dist > maxDist) maxDist = dist;
      }
      
      // 统计主导角色和类别
      const roleCounts: Record<string, number> = {};
      const catCounts: Record<string, number> = {};
      for (const a of areaAttractions) {
        const role = a.poi.tourismRole || 'FILLER';
        const cat = a.poi.category || 'other';
        roleCounts[role] = (roleCounts[role] || 0) + 1;
        catCounts[cat] = (catCounts[cat] || 0) + 1;
      }
      
      const dominantRole = Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'FILLER';
      const dominantCategory = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other';
      
      // 区域质量分 = 最高分 POI × 0.5 + 平均分 × 0.3 + 角色质量 × 0.2
      // 角色质量：有 CORE/MAJOR 的区域天然高分，纯 FILLER 区域低分
      const maxScore = Math.max(...areaAttractions.map(a => a.score));
      const avgScore = areaAttractions.reduce((s, a) => s + a.score, 0) / areaAttractions.length;
      
      const roleQualityMap: Record<string, number> = {
        CORE_ATTRACTION: 1.0, MAJOR_AREA: 0.8, NATURE_RELAX: 0.7,
        CULTURAL_SITE: 0.6, NIGHT_EXPERIENCE: 0.5, VIEWPOINT: 0.4,
        SHOPPING_AREA: 0.4, FILLER: 0.1,
      };
      const roleQuality = Math.max(
        ...areaAttractions.map(a => roleQualityMap[a.poi.tourismRole || 'FILLER'] ?? 0.1)
      );
      const qualityScore = maxScore * 0.5 + avgScore * 0.3 + roleQuality * 0.2;
      
      // 生成区域名称：用最高分 POI 的名称 + 区域后缀
      const corePOI = areaAttractions[0]; // 已按分数排序
      const areaName = areaAttractions.length > 1 
        ? `${corePOI.poi.name}周边` 
        : corePOI.poi.name;
      
      areas.push({
        id: `area-${areas.length}`,
        name: areaName,
        centroid,
        radius: maxDist,
        attractions: areaAttractions,
        restaurants: areaRestaurants,
        dominantRole: dominantRole as TourismRole,
        dominantCategory,
        qualityScore,
      });
    }
    
    // 按质量分排序
    areas.sort((a, b) => b.qualityScore - a.qualityScore);
    
    console.log(`[Pipeline] Identified ${areas.length} experience areas:`);
    areas.forEach(a => {
      console.log(`  ${a.name}: ${a.attractions.length} attractions, ${a.restaurants.length} restaurants, role=${a.dominantRole}, quality=${a.qualityScore.toFixed(2)}`);
    });
    
    return areas;
  }

  /**
   * 为指定区域选择最佳酒店
   * 核心原则：自动规划只选连锁酒店
   */
  private selectHotelForCluster(
        cluster: POICluster,
        allHotels: EnrichedPOI[],
        _scoredHotels: ScoredPOI[],
        excludeNames: Set<string> = new Set()
      ): EnrichedPOI | null {
        console.log(`[Pipeline] Selecting hotel for cluster "${cluster.name}" with ${cluster.attractions.length} attractions, ${cluster.hotels.length} hotels (excluding ${excludeNames.size} hotels)`);

        if (allHotels.length === 0) {
          console.warn(`[Pipeline] No hotels available at all for cluster "${cluster.name}"`);
          return null;
        }

        // 计算区域内景点的中心点
        const attractionCenter = this.calculatePOICenter(cluster.attractions);

        const centerLocation = attractionCenter 
          ? `${attractionCenter.lng},${attractionCenter.lat}`
          : `${cluster.centroid.lng},${cluster.centroid.lat}`;

        // === 酒店必须在 cluster 活动域内（centroid + radius + 5km） ===
        const clusterMaxDist = cluster.radius + 5;
        const HARD_MAX_HOTEL_DIST = Math.max(clusterMaxDist, 8);

        // 只从连锁酒店中选择
        const chainHotels = this.filterChainHotelsOnly(allHotels);
        const candidatePool = chainHotels.length > 0 ? chainHotels : this.filterQualityHotels(allHotels);

        // 按距离排序，排除已被其他 cluster 选中的酒店
        const hotelsWithDist = candidatePool
          .filter(h => h.location && !excludeNames.has(h.name))
          .map(hotel => ({
            hotel,
            distance: amapClient.calculateDistance(hotel.location!, centerLocation),
          }))
          .sort((a, b) => a.distance - b.distance);

        // 优先选活动域内的酒店
        const inZoneHotels = hotelsWithDist.filter(h => h.distance <= HARD_MAX_HOTEL_DIST);

        if (inZoneHotels.length > 0) {
          const selected = inZoneHotels[0];
          console.log(`[Pipeline] Selected in-zone chain hotel "${selected.hotel.name}" at ${selected.distance.toFixed(1)}km (limit: ${HARD_MAX_HOTEL_DIST.toFixed(1)}km)`);
          return selected.hotel;
        }

        // 活动域内没有未排除的酒店，放宽距离
        if (hotelsWithDist.length > 0) {
          const selected = hotelsWithDist[0];
          console.warn(`[Pipeline] No hotel within cluster zone (${HARD_MAX_HOTEL_DIST.toFixed(1)}km), using nearest: "${selected.hotel.name}" at ${selected.distance.toFixed(1)}km`);
          return selected.hotel;
        }

        // 所有连锁/质量酒店都被排除了，从全量酒店中选（包括已排除的）
        const allWithDist = candidatePool
          .filter(h => h.location)
          .map(hotel => ({
            hotel,
            distance: amapClient.calculateDistance(hotel.location!, centerLocation),
          }))
          .sort((a, b) => a.distance - b.distance);
        
        if (allWithDist.length > 0) {
          console.warn(`[Pipeline] All unique hotels exhausted, using closest available: "${allWithDist[0].hotel.name}"`);
          return allWithDist[0].hotel;
        }

        return allHotels.find(h => h.location && this.isActualHotel(h.name)) || allHotels.find(h => h.location) || allHotels[0] || null;
      }




  /**
   * 计算POI列表的地理中心
   */
  private calculatePOICenter(pois: EnrichedPOI[]): { lng: number; lat: number } | null {
    const validPOIs = pois.filter(p => p.location);
    if (validPOIs.length === 0) return null;
    
    let sumLng = 0, sumLat = 0;
    for (const poi of validPOIs) {
      const [lng, lat] = poi.location!.split(',').map(Number);
      sumLng += lng;
      sumLat += lat;
    }
    
    return {
      lng: sumLng / validPOIs.length,
      lat: sumLat / validPOIs.length,
    };
  }

  /**
   * 舒适型连锁酒店品牌列表
   */
  private readonly PREFERRED_HOTEL_BRANDS = [
    '如家', '全季', '亚朵', '汉庭', '锦江之星', '7天', '速8', 
    '格林豪泰', '维也纳', '城市便捷', '桔子', '和颐', '智选假日',
    '希尔顿欢朋', '宜必思', '麗枫', '喆啡', '希尔顿', '万豪', '洲际',
    '凯悦', '香格里拉', '皇冠假日', '假日酒店', '美豪', '都市花园',
    '锦江都城', '铂涛', '华住', '首旅', '开元', '雅斯特', '尚客优',
    '丽呈', '潮漫', '希岸', '非繁城品', '柏曼', '郁锦香',
  ];

  /**
   * 低端/非正规住宿关键词（应该过滤掉）
   */
  private readonly LOW_END_HOTEL_KEYWORDS = [
    '招待所', '旅社', '旅馆', '民宿', '公寓', '青旅', '青年旅舍',
    '日租', '钟点房', '小时房',
    '山庄', '庄园', '农庄', '农家', '别墅',
    '宿舍', '出租', '短租', '合租',
    '疗养', '养老', '敬老',
    '宾馆',
  ];

  /**
   * 检查酒店是否是舒适型连锁品牌
   */
  private isPreferredBrandHotel(hotelName: string): boolean {
    return this.PREFERRED_HOTEL_BRANDS.some(brand => hotelName.includes(brand));
  }

  /**
   * 检查是否是低端住宿（应该过滤掉）
   */
  private isLowEndHotel(hotelName: string): boolean {
    return this.LOW_END_HOTEL_KEYWORDS.some(keyword => hotelName.includes(keyword));
  }

  /**
   * 检查名称是否像一个真正的酒店（白名单思路）
   * 名称中必须包含酒店类关键词，否则不认为是酒店
   */
  private readonly HOTEL_TYPE_KEYWORDS = [
    '酒店', '宾馆', '旅店', '旅馆', '饭店',
    'hotel', 'inn', 'motel', 'resort',
    // 连锁品牌本身就代表酒店（如"亚朵"、"全季"不一定带"酒店"二字）
  ];
  private isActualHotel(hotelName: string): boolean {
    const lower = hotelName.toLowerCase();
    if (this.HOTEL_TYPE_KEYWORDS.some(kw => lower.includes(kw))) return true;
    // 连锁品牌名本身就是酒店
    if (this.isPreferredBrandHotel(hotelName)) return true;
    return false;
  }

  /**
   * 过滤酒店列表，排除低端住宿和非酒店
   */
  private filterQualityHotels(hotels: EnrichedPOI[]): EnrichedPOI[] {
    const filtered = hotels.filter(h => this.isActualHotel(h.name) && !this.isLowEndHotel(h.name));
    // 如果过滤后没有酒店了，返回原列表
    return filtered.length > 0 ? filtered : hotels;
  }

  /**
   * 只保留连锁品牌酒店（自动规划专用）
   */
  private filterChainHotelsOnly(hotels: EnrichedPOI[]): EnrichedPOI[] {
    return hotels.filter(h => this.isPreferredBrandHotel(h.name) && !this.isLowEndHotel(h.name));
  }

  /**
   * 选择离所有聚类中心最近的酒店（用于短行程）
   * 自动规划只选连锁酒店
   */
  private selectCentralHotel(hotels: EnrichedPOI[], clusters: POICluster[]): EnrichedPOI | null {
    if (hotels.length === 0) return null;
    
    const chainHotels = this.filterChainHotelsOnly(hotels);
    const candidates = chainHotels.length > 0 ? chainHotels : this.filterQualityHotels(hotels);
    const hotelsWithLocation = candidates.filter(h => h.location);
    
    if (hotelsWithLocation.length === 0) return hotels[0] || null;
    if (clusters.length === 0) return hotelsWithLocation[0];

    // 计算每个酒店到所有聚类中心的总距离
    const hotelsWithDistance = hotelsWithLocation.map(hotel => {
      let totalDistance = 0;
      for (const cluster of clusters) {
        const clusterCenter = `${cluster.centroid.lng},${cluster.centroid.lat}`;
        totalDistance += amapClient.calculateDistance(hotel.location!, clusterCenter);
      }
      return { hotel, totalDistance };
    });

    hotelsWithDistance.sort((a, b) => a.totalDistance - b.totalDistance);
    const selected = hotelsWithDistance[0];
    console.log(`[Pipeline] Selected central chain hotel "${selected.hotel.name}" (total distance: ${selected.totalDistance.toFixed(1)}km)`);
    return selected.hotel;
  }

  /**
   * 选择离指定位置最近的酒店
   * 自动规划只选连锁酒店
   */
  private selectNearestHotel(hotels: EnrichedPOI[], centroid: { lng: number; lat: number }): EnrichedPOI | null {
    const chainHotels = this.filterChainHotelsOnly(hotels);
    const candidates = chainHotels.length > 0 ? chainHotels : this.filterQualityHotels(hotels);
    const hotelsWithLocation = candidates.filter(h => h.location);
    if (hotelsWithLocation.length === 0) return null;

    const centerLocation = `${centroid.lng},${centroid.lat}`;
    
    const sorted = hotelsWithLocation
      .map(hotel => ({
        hotel,
        distance: amapClient.calculateDistance(hotel.location!, centerLocation),
      }))
      .sort((a, b) => a.distance - b.distance);

    console.log(`[Pipeline] Selected nearest chain hotel "${sorted[0].hotel.name}" (distance: ${sorted[0].distance.toFixed(1)}km)`);
    return sorted[0].hotel;
  }


  generateDayFramework(dayIndex: number, days: number, arrivalTime: string, departureTime: string): TimeSlot[] {
    const arrivalHour = parseInt(arrivalTime.split(':')[0], 10);
    const departureHour = parseInt(departureTime.split(':')[0], 10);
    const slots: TimeSlot[] = [];

    // 角色化时段定义：每个景点时段有明确的角色偏好和权重
    // 权重体现"峰值优先"：core 时段权重最高，filler 最低
    const standardSlots = {
      breakfast: { 
        startTime: '08:00', duration: 60, poiType: 'restaurant' as const 
      },
      morning: { 
        startTime: '09:30', duration: 120, poiType: 'attraction' as const,
        // 上午：核心景点时段，一天的高潮
        preferredRoles: ['CORE_ATTRACTION', 'MAJOR_AREA', 'NATURE_RELAX'] as TourismRole[],
        roleWeight: 2.5,
      },
      lunch: { 
        startTime: '12:00', duration: 90, poiType: 'restaurant' as const 
      },
      afternoon: { 
        startTime: '14:00', duration: 180, poiType: 'attraction' as const,
        // 下午：次核心时段，大型区域或自然休闲
        preferredRoles: ['MAJOR_AREA', 'NATURE_RELAX', 'CORE_ATTRACTION', 'CULTURAL_SITE'] as TourismRole[],
        roleWeight: 1.5,
      },
      dinner: { 
        startTime: '18:00', duration: 90, poiType: 'restaurant' as const 
      },
      evening: { 
        startTime: '20:00', duration: 90, poiType: 'attraction' as const,
        // 晚上：夜间体验或商圈，不适合大景点
        preferredRoles: ['NIGHT_EXPERIENCE', 'SHOPPING_AREA', 'VIEWPOINT'] as TourismRole[],
        roleWeight: 0.5,
      },
    };

    // 辅助函数：判断时段是否在指定时间之前（留出活动时间）
    const isSlotBefore = (slotTime: string, hour: number, bufferHours: number = 2): boolean => {
      const [slotHour] = slotTime.split(':').map(Number);
      return slotHour + bufferHours <= hour;
    };

    if (dayIndex === 1) {
      const availableFromHour = arrivalHour + 1;
      
      if (availableFromHour <= 9) {
        slots.push({ type: 'morning', ...standardSlots.morning });
      }
      if (availableFromHour <= 11) {
        slots.push({ type: 'lunch', ...standardSlots.lunch });
      }
      if (availableFromHour <= 13) {
        slots.push({ type: 'afternoon', ...standardSlots.afternoon });
      }
      if (availableFromHour <= 17) {
        slots.push({ type: 'dinner', ...standardSlots.dinner });
      }
      if (availableFromHour <= 19) {
        slots.push({ type: 'evening', ...standardSlots.evening });
      }
    } else if (dayIndex === days) {
      slots.push({ type: 'breakfast', ...standardSlots.breakfast });
      
      if (isSlotBefore(standardSlots.morning.startTime, departureHour, 2)) {
        slots.push({ type: 'morning', ...standardSlots.morning });
      }
      if (isSlotBefore(standardSlots.lunch.startTime, departureHour, 2)) {
        slots.push({ type: 'lunch', ...standardSlots.lunch });
      }
      if (isSlotBefore(standardSlots.afternoon.startTime, departureHour, 2)) {
        slots.push({ type: 'afternoon', ...standardSlots.afternoon });
      }
    } else {
      slots.push({ type: 'breakfast', ...standardSlots.breakfast });
      slots.push({ type: 'morning', ...standardSlots.morning });
      slots.push({ type: 'lunch', ...standardSlots.lunch });
      slots.push({ type: 'afternoon', ...standardSlots.afternoon });
      slots.push({ type: 'dinner', ...standardSlots.dinner });
      slots.push({ type: 'evening', ...standardSlots.evening });
    }
    
    return slots;
  }

  /**
   * 优化路线选择 —— "角色位填充"模式
   * 
   * 核心变化：不再让所有 POI 在 combinedScore 上平等竞争。
   * 而是：
   *   1. 每个景点时段是一个"角色位"（Role Slot），有明确的角色需求
   *   2. 先为角色位筛选角色匹配的候选池，再在池内按距离/质量选最优
   *   3. 日评分 = 2.5×core + 1.5×secondary + 0.5×fillers - distance_penalty
   *   4. 主题约束：只有匹配当天主题的 POI 才能竞争 CORE 角色位
   *   5. FILLER 永远当不了 CORE，小景点自然消失
   */
  async optimizeRoute(slots: TimeSlot[], attractions: ScoredPOI[], restaurants: ScoredPOI[], 
    startLocation: string, usedPOIs: Set<string>, endLocation: string,
    globalCategoryCounts: Record<string, number> = {},
    dayTheme?: DayTheme,
    dayCenter?: string): Promise<DaySchedule> {
    const scheduled: ScheduledSlot[] = [];
    let currentLocation = startLocation;
    let totalDistance = 0;

    // 当天已使用的角色计数
    const dayRoleCounts: Record<string, number> = {};
    
    // 追踪当天已选景点位置
    const dayAttractionLocations: string[] = [];

    // 距离配置
    const RESTAURANT_DISTANCE = {
      idealMax: 2, acceptableMax: 5, hardMax: 8,
      penaltyPerKm: 0.2, mediumPenaltyPerKm: 0.4, hardPenaltyPerKm: 0.8,
    };
    const ATTRACTION_DISTANCE = {
      idealMax: 5, acceptableMax: 10, hardMax: 15,
      penaltyPerKm: 0.1, mediumPenaltyPerKm: 0.2, hardPenaltyPerKm: 0.4,
    };

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const isLast = i === slots.length - 1;
      const isRestaurant = slot.poiType === 'restaurant';
      const distConfig = isRestaurant ? RESTAURANT_DISTANCE : ATTRACTION_DISTANCE;
      
      // ========== 第一步：构建候选池 ==========
      let availableCandidates: ScoredPOI[];
      
      if (isRestaurant) {
        availableCandidates = restaurants.filter(c => !usedPOIs.has(c.poi.name) && c.poi.location);
        
        // 午餐/晚餐：降低非正餐类店铺的评分（甜品、奶茶、咖啡、饮品等）
        if (slot.type === 'lunch' || slot.type === 'dinner') {
          const snackPattern = /甜品|奶茶|咖啡|饮品|冰淇淋|蛋糕|面包|烘焙|果汁|冷饮|糖水|古茗|茶百道|蜜雪冰城|瑞幸|星巴克|喜茶|奈雪/;
          availableCandidates = availableCandidates.map(c => {
            if (snackPattern.test(c.poi.name)) {
              return { ...c, score: c.score * 0.1 }; // 大幅降分但不排除
            }
            return c;
          });
        }
        
        // 早餐：直接搜附近早餐店，不从通用餐厅池选
        if (slot.type === 'breakfast') {
          const breakfastCandidates = await this.searchNearbyBreakfast(currentLocation, usedPOIs);
          if (breakfastCandidates.length > 0) {
            availableCandidates = breakfastCandidates.map(poi => ({
              poi, score: this.calculatePOIScore(poi, 'restaurant') * 1.5,
            }));
          }
          // 搜不到早餐店时保留通用池作为兜底
        }
        
        // 餐厅候选池耗尽时实时搜索
        if (availableCandidates.length === 0) {
          console.log(`[Pipeline] Restaurant pool exhausted for slot ${slot.type}, searching nearby...`);
          const nearbyPOIs = await this.searchNearbyRestaurants(currentLocation, usedPOIs);
          if (nearbyPOIs.length > 0) {
            availableCandidates = nearbyPOIs.map(poi => ({ poi, score: this.calculatePOIScore(poi, 'restaurant') }));
          }
        }
      } else {
        // ========== 核心改造：景点按"角色位"筛选候选池 ==========
        const preferredRoles = slot.preferredRoles || [];
        // 过滤已使用的 POI（精确匹配 + 名称相似性检查）
        const usedNames = Array.from(usedPOIs);
        const allAvailable = attractions.filter(c => {
          if (!c.poi.location || c.score < 0.2) return false;
          if (usedPOIs.has(c.poi.name)) return false;
          // 名称相似性检查：防止"广州塔"和"广州塔E区"被视为不同POI
          return !usedNames.some(used => this.isSameAttraction(c.poi.name, used, c.poi.location, undefined));
        });
        
        if (preferredRoles.length > 0) {
          // 第一层：严格角色匹配（只选 preferredRoles 中的角色）
          // 主题约束：CORE 角色位只允许匹配当天主题的 POI
          const roleMatched = allAvailable.filter(c => {
            const poiRole = c.poi.tourismRole || 'FILLER';
            if (!preferredRoles.includes(poiRole)) return false;
            
            // 主题约束：如果有主题，CORE_ATTRACTION 角色位只允许主题匹配的 POI
            if (dayTheme && preferredRoles[0] === 'CORE_ATTRACTION' && poiRole === 'CORE_ATTRACTION') {
              const poiCat = c.poi.category || 'other';
              const roleMatch = dayTheme.preferredRoles.includes(poiRole);
              const catMatch = dayTheme.preferredCategories.includes(poiCat);
              // CORE 必须至少匹配主题的角色或类别
              if (!roleMatch && !catMatch) return false;
            }
            
            return true;
          });
          
          if (roleMatched.length > 0) {
            availableCandidates = roleMatched;
          } else {
            // 第二层：放宽到非 FILLER 的所有角色
            const nonFiller = allAvailable.filter(c => (c.poi.tourismRole || 'FILLER') !== 'FILLER');
            availableCandidates = nonFiller.length > 0 ? nonFiller : allAvailable;
          }
        } else {
          availableCandidates = allAvailable;
        }
      }
      
      // ========== 第二步：在候选池内按 峰值优先评分 选最优 ==========
      let bestPOI: EnrichedPOI | null = null;
      let bestScore = -Infinity;
      let bestDist = 0;

      const roleWeight = slot.roleWeight || 1.0;
      const preferredRoles = slot.preferredRoles || [];

      for (const { poi, score: baseScore } of availableCandidates) {
        // 计算当天景点几何中心
        let currentAttractionCenter: string | null = null;
        if (dayAttractionLocations.length > 0) {
          let sumLng = 0, sumLat = 0;
          for (const loc of dayAttractionLocations) {
            const [lng, lat] = loc.split(',').map(Number);
            sumLng += lng;
            sumLat += lat;
          }
          currentAttractionCenter = `${sumLng / dayAttractionLocations.length},${sumLat / dayAttractionLocations.length}`;
        }
        
        const activityCenter = currentAttractionCenter || dayCenter || startLocation;

        // 距离计算：餐厅基于景点中心，景点基于当前位置
        const distFromCurrent = amapClient.calculateDistance(currentLocation, poi.location!);
        const dist = isRestaurant && currentAttractionCenter
          ? amapClient.calculateDistance(currentAttractionCenter, poi.location!)
          : distFromCurrent;
        
        // 往返成本
        const returnToCenter = amapClient.calculateDistance(poi.location!, activityCenter);
        const effectiveDistance = dist + returnToCenter;
        
        // 距离惩罚（阈值翻倍适配往返距离）
        const effIdeal = distConfig.idealMax * 2;
        const effAcceptable = distConfig.acceptableMax * 2;
        const effHard = distConfig.hardMax * 2;
        let distancePenalty = 0;
        
        if (effectiveDistance <= effIdeal) {
          distancePenalty = effectiveDistance * distConfig.penaltyPerKm;
        } else if (effectiveDistance <= effAcceptable) {
          distancePenalty = effIdeal * distConfig.penaltyPerKm 
            + (effectiveDistance - effIdeal) * distConfig.mediumPenaltyPerKm;
        } else if (effectiveDistance <= effHard) {
          distancePenalty = effIdeal * distConfig.penaltyPerKm 
            + (effAcceptable - effIdeal) * distConfig.mediumPenaltyPerKm
            + (effectiveDistance - effAcceptable) * distConfig.hardPenaltyPerKm;
        } else {
          distancePenalty = effIdeal * distConfig.penaltyPerKm 
            + (effAcceptable - effIdeal) * distConfig.mediumPenaltyPerKm
            + (effHard - effAcceptable) * distConfig.hardPenaltyPerKm
            + (effectiveDistance - effHard) * 1.0;
        }
        
        // ========== 峰值优先评分 ==========
        // day_score = 2.5 * core_score + 1.5 * secondary_score + 0.5 * fillers - distance_penalty
        // roleWeight 已经编码了这个权重（morning=2.5, afternoon=1.5, evening=0.5）
        
        let roleScore = baseScore;
        
        if (!isRestaurant && preferredRoles.length > 0) {
          const poiRole = poi.tourismRole || 'FILLER';
          const roleIndex = preferredRoles.indexOf(poiRole);
          
          // 角色位匹配：首选角色大幅加分，非首选递减
          if (roleIndex === 0) {
            // 首选角色：满分
            roleScore = baseScore * 1.6;
          } else if (roleIndex > 0) {
            // 次选角色：递减
            roleScore = baseScore * (1.3 - roleIndex * 0.1);
          } else {
            // 不在偏好列表中
            if (poiRole === 'FILLER') {
              // FILLER 在有角色偏好的时段大幅降分 —— 这是"小景点消失"的关键
              roleScore = baseScore * 0.15;
            } else {
              // 其他非偏好角色：中等降分
              roleScore = baseScore * 0.5;
            }
          }
          
          // 同角色当天重复惩罚
          const roleCount = dayRoleCounts[poiRole] || 0;
          if (poiRole === 'FILLER' && roleCount >= 1) {
            roleScore -= roleCount * 0.4;
          } else if (poiRole !== 'FILLER' && poiRole !== 'NATURE_RELAX' && roleCount >= 1) {
            roleScore -= roleCount * 0.25;
          }
        }
        
        // 主题匹配加分（在角色位筛选之后的精细调整）
        if (!isRestaurant && dayTheme) {
          const poiRole = poi.tourismRole || 'FILLER';
          const poiCat = poi.category || 'other';
          
          if (dayTheme.preferredRoles.includes(poiRole)) {
            const themeRoleIdx = dayTheme.preferredRoles.indexOf(poiRole);
            roleScore *= 1.0 + (0.35 - themeRoleIdx * 0.05);
          }
          if (dayTheme.preferredCategories.includes(poiCat)) {
            roleScore *= 1.2;
          }
          // 不匹配主题的 FILLER 进一步惩罚
          if (!dayTheme.preferredRoles.includes(poiRole) && 
              !dayTheme.preferredCategories.includes(poiCat) &&
              poiRole === 'FILLER') {
            roleScore *= 0.5;
          }
        }
        
        // 最终得分 = 角色匹配分 × 时段权重 - 距离惩罚
        let combinedScore = roleScore * roleWeight - distancePenalty;
        
        // 全局类别多样性惩罚
        if (!isRestaurant && poi.category) {
          const globalCount = globalCategoryCounts[poi.category] || 0;
          const GLOBAL_LIMITS: Record<string, number> = {
            university: 1, school: 0, ancestral_hall: 1,
            park: 2, plaza: 2, memorial: 1, library: 1,
          };
          const globalLimit = GLOBAL_LIMITS[poi.category];
          if (globalLimit !== undefined && globalCount >= globalLimit) {
            combinedScore -= (globalCount - globalLimit + 1) * 0.5;
          }
        }
        
        // 最后一个时段考虑回酒店距离
        if (isLast) {
          const returnDist = amapClient.calculateDistance(poi.location!, endLocation);
          if (returnDist > 5) combinedScore -= (returnDist - 5) * 0.15;
          if (returnDist > 15) combinedScore -= 0.5;
        }
        
        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestPOI = poi;
          bestDist = dist;
        }
      }

      // 兜底：选距离最近的
      if (!bestPOI && availableCandidates.length > 0) {
        let minDist = Infinity;
        for (const { poi } of availableCandidates) {
          const dist = amapClient.calculateDistance(currentLocation, poi.location!);
          if (dist < minDist) {
            minDist = dist;
            bestPOI = poi;
            bestDist = dist;
          }
        }
      }

      if (bestPOI) {
        usedPOIs.add(bestPOI.name);
        if (!isRestaurant) {
          const role = bestPOI.tourismRole || 'FILLER';
          dayRoleCounts[role] = (dayRoleCounts[role] || 0) + 1;
          if (bestPOI.category) {
            globalCategoryCounts[bestPOI.category] = (globalCategoryCounts[bestPOI.category] || 0) + 1;
          }
          if (bestPOI.location) {
            dayAttractionLocations.push(bestPOI.location);
          }
        }
        scheduled.push({
          slot, poi: bestPOI, scheduledTime: slot.startTime,
          travelTimeFromPrev: this.estimateTravelTime(bestDist), distanceFromPrev: bestDist
        });
        totalDistance += bestDist;
        currentLocation = bestPOI.location!;
        
        if (!isRestaurant) {
          console.log(`[Pipeline] ${slot.type}: ${bestPOI.name} [${bestPOI.tourismRole || 'FILLER'}] (roleWeight=${roleWeight}, score=${bestScore.toFixed(2)})`);
        }
      } else {
        console.warn(`[Pipeline] No POI found for slot ${slot.type}, skipping`);
        scheduled.push({ slot, poi: null, scheduledTime: slot.startTime, travelTimeFromPrev: 0, distanceFromPrev: 0 });
      }
    }
    return { dayIndex: 0, slots: scheduled, totalDistance };
  }

  /**
   * 实时搜索附近早餐店
   */
  private async searchNearbyBreakfast(location: string, usedPOIs: Set<string>): Promise<EnrichedPOI[]> {
    const keywords = ['早餐', '早点', '粥', '包子', '豆浆', '面馆', '肠粉', '早茶'];
    const all: EnrichedPOI[] = [];
    try {
      for (const kw of keywords) {
        const pois = await amapClient.searchAround(location, 5000, {
          keywords: kw,
          types: '050000',
          pageSize: 10,
          sortRule: 'distance',
        });
        for (const p of pois) {
          if (p.location && !usedPOIs.has(p.name) && !all.some(a => a.name === p.name)) {
            all.push({
              name: p.name,
              type: 'restaurant' as const,
              address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
              description: p.rating ? `评分${p.rating}` : '早餐店',
              rating: p.rating ? parseFloat(p.rating) : undefined,
              price: p.cost ? parseFloat(p.cost) : undefined,
              location: p.location,
              amapId: p.id,
            });
          }
        }
        if (all.length >= 8) break; // 够了就不继续搜
      }
    } catch (e) {
      console.warn('[Pipeline] Failed to search nearby breakfast:', e);
    }
    return all;
  }

  /**
   * 实时搜索附近餐厅（当候选池耗尽时使用）
   */
  private async searchNearbyRestaurants(location: string, usedPOIs: Set<string>): Promise<EnrichedPOI[]> {
    try {
      const pois = await amapClient.searchAround(location, 10000, {
        types: '050000', // 餐饮服务
        pageSize: 50,
        sortRule: 'distance',
      });
      
      return pois
        .filter(p => p.location && !usedPOIs.has(p.name))
        .map(p => ({
          name: p.name,
          type: 'restaurant' as const,
          address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
          description: p.rating ? `评分${p.rating}` : '当地餐厅',
          rating: p.rating ? parseFloat(p.rating) : undefined,
          price: p.cost ? parseFloat(p.cost) : undefined,
          location: p.location,
          amapId: p.id,
        }));
    } catch (e) {
      console.warn('[Pipeline] Failed to search nearby restaurants:', e);
      return [];
    }
  }

  /**
   * 搜索附近酒店（当 POI 列表中没有酒店时的兜底方案）
   */
  private async searchNearbyHotel(centroid?: { lng: number; lat: number }, excludeNames?: Set<string>): Promise<EnrichedPOI | null> {
    if (!centroid) return null;
    const centerLocation = `${centroid.lng},${centroid.lat}`;
    try {
      console.log(`[Pipeline] Searching nearby hotels around ${centerLocation}...`);
      const pois = await amapClient.searchAround(centerLocation, 20000, {
        types: '100000', // 住宿服务
        pageSize: 20,
        sortRule: 'distance',
      });
      
      const hotels: EnrichedPOI[] = pois
        .filter(p => p.location)
        .map(p => ({
          name: p.name,
          type: 'hotel' as const,
          address: [p.city, p.district, p.address].filter(Boolean).join('') || '',
          description: p.rating ? `评分${p.rating}` : '酒店',
          rating: p.rating ? parseFloat(p.rating) : undefined,
          location: p.location,
          amapId: p.id,
        }));
      
      // 优先选连锁酒店
      const _exclude = excludeNames || new Set<string>();
      const chain = hotels.find(h => this.isPreferredBrandHotel(h.name) && !this.isLowEndHotel(h.name) && !_exclude.has(h.name));
      const quality = hotels.find(h => this.isActualHotel(h.name) && !this.isLowEndHotel(h.name) && !_exclude.has(h.name));
      const selected = chain || quality || hotels.find(h => !_exclude.has(h.name)) || null;
      if (selected) {
        console.log(`[Pipeline] Found nearby hotel: "${selected.name}"`);
      }
      return selected;
    } catch (e) {
      console.warn('[Pipeline] Failed to search nearby hotels:', e);
      return null;
    }
  }

  /**
   * 纯算法：解析 replacement 中的"移动"语义
   * 
   * LLM 只需返回"用户想在哪个位置放什么景点"（一条 replacement），
   * 本方法自动检测 newName 是否已在行程中：
   *   - 已存在且不在目标位置 → 移动操作：原位置标记 __AUTO_REPLACE__
   *   - 不存在 → 纯新增，无需额外处理
   * 
   * 同时处理名称相似性（如"广州塔"和"广州塔E区"视为同一景点）
   */
  private resolveReplacementConflicts(
    intent: UserIntent,
    currentNodes: TravelNode[]
  ): void {
    if (!intent.replacements || intent.replacements.length === 0) return;

    // 构建当前行程的景点/餐厅列表
    const existingPOIs: Array<{ name: string; dayIndex: number; timeSlot: string; location?: string }> = [];
    for (const node of currentNodes) {
      if (node.type === 'attraction' || node.type === 'restaurant') {
        existingPOIs.push({ name: node.name, dayIndex: node.dayIndex, timeSlot: node.timeSlot || '', location: node.location });
      }
    }

    // 收集本次 intent 中所有 replacement 的目标位置，避免重复处理
    const targetPositions = new Set<string>();
    for (const r of intent.replacements) {
      targetPositions.add(`${r.dayIndex}_${r.timeSlot}`);
    }

    // 收集已经被标记为 __AUTO_REPLACE__ 的原始名称
    const alreadyAutoReplaced = new Set<string>();
    for (const r of intent.replacements) {
      if (r.newName === '__AUTO_REPLACE__') {
        alreadyAutoReplaced.add(r.originalName);
      }
    }

    const additionalReplacements: Array<{ dayIndex: number; timeSlot: string; originalName: string; newName: string }> = [];

    for (const r of intent.replacements) {
      if (r.newName === '__AUTO_REPLACE__') continue;

      // 查找 newName 是否已在行程中（精确匹配 + 相似性匹配）
      const match = existingPOIs.find(p => {
        if (p.name === r.newName) return true;
        return this.isSameAttraction(p.name, r.newName, p.location, undefined);
      });

      if (!match) continue; // 纯新增

      // 在目标位置则跳过（原地替换）
      if (match.dayIndex === r.dayIndex && match.timeSlot === r.timeSlot) continue;

      // LLM 已正确处理则跳过
      if (alreadyAutoReplaced.has(match.name)) continue;

      // 原位置已是本次修改的目标则跳过（避免冲突）
      const sourceKey = `${match.dayIndex}_${match.timeSlot}`;
      if (targetPositions.has(sourceKey)) continue;

      // 需要移动：原位置标记为 __AUTO_REPLACE__
      console.log(`[Chat] Algorithm detected move: "${r.newName}" exists at Day ${match.dayIndex} ${match.timeSlot} → moving to Day ${r.dayIndex} ${r.timeSlot}`);
      additionalReplacements.push({
        dayIndex: match.dayIndex,
        timeSlot: match.timeSlot,
        originalName: match.name,
        newName: '__AUTO_REPLACE__',
      });
      targetPositions.add(sourceKey);
      alreadyAutoReplaced.add(match.name);

      // 相似性匹配时：不修正 newName，保留用户想要的名称
      // 例如用户说"广州塔"，行程中是"广州塔E区"，目标位置应该叫"广州塔"
      // 但原位置的"广州塔E区"需要用精确名称来定位
      if (r.newName !== match.name) {
        console.log(`[Chat] Similar match: user wants "${r.newName}", found "${match.name}" in itinerary at Day ${match.dayIndex} ${match.timeSlot}`);
      }
    }

    if (additionalReplacements.length > 0) {
      intent.replacements!.push(...additionalReplacements);
      console.log(`[Chat] Algorithm added ${additionalReplacements.length} auto-replace(s) for move operations`);
    }
  }

  /**
   * 最终兜底：基于修改记录的重复景点检查
   * 
   * 在所有修改完成后执行，检查是否仍有重复景点（精确匹配 + 相似性匹配）。
   * 根据修改记录决定保留哪个：用户本次指定的目标位置保留，其它重复的替换掉。
   */
  private async finalDuplicateCheck(
    nodes: TravelNode[],
    userTargets: Array<{ dayIndex: number; timeSlot: string; name: string }>
  ): Promise<void> {
    const attractionNodes = nodes.filter(n => n.type === 'attraction' || n.type === 'restaurant');
    
    // 按名称相似性分组
    const groups: Array<{ key: string; nodes: TravelNode[] }> = [];
    for (const node of attractionNodes) {
      const existingGroup = groups.find(g => this.isSameAttraction(g.key, node.name, 
        g.nodes[0]?.location, node.location));
      if (existingGroup) {
        existingGroup.nodes.push(node);
      } else {
        groups.push({ key: node.name, nodes: [node] });
      }
    }

    // 找出有重复的组
    const duplicateGroups = groups.filter(g => g.nodes.length > 1);
    if (duplicateGroups.length === 0) return;

    console.log(`[Chat] Final duplicate check: found ${duplicateGroups.length} group(s) with duplicates`);

    const usedNames = new Set(attractionNodes.map(n => n.name));

    for (const group of duplicateGroups) {
      console.log(`[Chat] Duplicate group "${group.key}": ${group.nodes.map(n => `Day${n.dayIndex}/${n.timeSlot}`).join(', ')}`);

      // 判断哪个是用户本次指定的目标 —— 保留它
      const userTarget = group.nodes.find(n => 
        userTargets.some(t => 
          t.dayIndex === n.dayIndex && t.timeSlot === n.timeSlot && this.isSameAttraction(t.name, n.name)
        )
      );

      // 需要替换的节点：除了用户指定的，其它都替换
      // 如果没有用户指定的（初始生成的重复），保留第一个
      const keepNode = userTarget || group.nodes[0];
      const replaceNodes = group.nodes.filter(n => n !== keepNode);

      for (const dupNode of replaceNodes) {
        // 搜索中心：优先用节点自身位置，没有则用当天酒店或其它节点的位置
        let searchCenter = dupNode.location;
        if (!searchCenter) {
          const dayNodes = nodes.filter(n => n.dayIndex === dupNode.dayIndex && n.location);
          searchCenter = dayNodes.find(n => n.type === 'hotel')?.location
            || dayNodes[0]?.location;
        }
        if (!searchCenter) continue;

        console.log(`[Chat] Final dedup: replacing "${dupNode.name}" at Day ${dupNode.dayIndex} ${dupNode.timeSlot} (keeping Day ${keepNode.dayIndex} ${keepNode.timeSlot})`);

        try {
          const poiType = dupNode.type === 'restaurant' ? '050000' : '110000|140000';
          const pois = await amapClient.searchAround(searchCenter, 10000, {
            types: poiType,
            pageSize: 20,
            sortRule: 'distance',
          });

          const replacement = pois.find(p => {
            if (!p.location || usedNames.has(p.name)) return false;
            if (dupNode.type === 'attraction' && !this.isValidAttractionName(p.name)) return false;
            // 不能与当前重复组的名称相似
            if (this.isSameAttraction(p.name, group.key, p.location, dupNode.location)) return false;
            // 距离排斥：距被保留节点 1.5km 内跳过（避免选到同一景区的子设施）
            if (keepNode.location && amapClient.calculateDistance(keepNode.location, p.location) < 1.5) return false;
            return true;
          });

          if (replacement) {
            console.log(`[Chat] Final dedup: replaced "${dupNode.name}" with "${replacement.name}"`);
            usedNames.delete(dupNode.name);
            usedNames.add(replacement.name);
            dupNode.name = replacement.name;
            dupNode.address = [replacement.city, replacement.district, replacement.address].filter(Boolean).join('') || '';
            dupNode.location = replacement.location;
            dupNode.description = '';
            dupNode.activity = `${this.getSlotLabel(dupNode.timeSlot || 'morning')}：${replacement.name}`;
          } else {
            console.warn(`[Chat] Final dedup: no replacement found for "${dupNode.name}" at Day ${dupNode.dayIndex}`);
          }
        } catch (e) {
          console.warn(`[Chat] Final dedup: search failed for "${dupNode.name}":`, e);
        }
      }
    }
  }


  async updateItineraryWithChat(
    currentNodes: TravelNode[], destination: string, userMessage: string,
    chatHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<{ nodes: TravelNode[]; response: string }> {
    const intent = await this.parseUserIntent(currentNodes, destination, userMessage, chatHistory);
    console.log('[Chat] Parsed intent:', JSON.stringify({
      hasModification: intent.hasModification,
      hotelChange: intent.hotelChange,
      replacements: intent.replacements,
      swaps: intent.swaps,
      response: intent.response?.substring(0, 100),
    }));
    if (!intent.hasModification) return { nodes: currentNodes, response: intent.response };

    let modifiedNodes = [...currentNodes];
    const totalDays = Math.max(...modifiedNodes.map(n => n.dayIndex), 1);

    // === Phase 0: 算法层面解析"移动"语义 ===
    // LLM 只需返回"用户想在哪个位置放什么景点"，算法自动检测是否需要移动
    // 替代旧的 LLM 依赖方案，彻底解决规则1a/1b的可靠性问题
    this.resolveReplacementConflicts(intent, currentNodes);

    // 构建修改记录：记录用户本次指定的目标位置（dayIndex + timeSlot + newName）
    // 用于最终重复检查时决定保留哪个、替换哪个
    const userModificationTargets: Array<{ dayIndex: number; timeSlot: string; name: string }> = [];
    for (const r of intent.replacements || []) {
      if (r.newName && r.newName !== '__AUTO_REPLACE__') {
        userModificationTargets.push({ dayIndex: r.dayIndex, timeSlot: r.timeSlot, name: r.newName });
      }
    }

    // === Phase 1: 应用用户修改（酒店 / 景点替换） ===
    if (intent.hotelChange) {
      const newName = intent.hotelChange.newHotelName;
      const targetOriginal = intent.hotelChange.originalHotelName;
      
      if (targetOriginal) {
        // 指定了要替换哪个酒店：只替换名称匹配的酒店节点
        console.log(`[Chat] Replacing hotel "${targetOriginal}" -> "${newName}"`);
        modifiedNodes = modifiedNodes.map(node => {
          if (node.type === 'hotel' && node.name === targetOriginal) {
            const newActivity = node.activity ? node.activity.replace(targetOriginal, newName) : node.activity;
            return { ...node, name: newName, activity: newActivity, address: intent.hotelChange!.address || node.address,
              priceInfo: intent.hotelChange!.priceInfo || node.priceInfo, location: undefined, description: '' };
          }
          return node;
        });
      } else {
        // 未指定：替换所有酒店（兼容旧逻辑，如"换酒店为XX"）
        console.log(`[Chat] Replacing ALL hotels -> "${newName}"`);
        modifiedNodes = modifiedNodes.map(node => {
          if (node.type === 'hotel') {
            const oldName = node.name;
            const newActivity = node.activity ? node.activity.replace(oldName, newName) : node.activity;
            return { ...node, name: newName, activity: newActivity, address: intent.hotelChange!.address || node.address,
              priceInfo: intent.hotelChange!.priceInfo || node.priceInfo, location: undefined, description: '' };
          }
          return node;
        });
      }
    }

    // 存储模糊偏好的搜索关键词，供 __PENDING_REPLACE__ 处理时使用
    const pendingKeywordsMap = new Map<string, string[]>();

    for (const r of intent.replacements || []) {
      // 优先按 dayIndex + timeSlot 精确匹配，其次按名称匹配
      let idx = modifiedNodes.findIndex(n => n.dayIndex === r.dayIndex && n.timeSlot === r.timeSlot);
      if (idx === -1) {
        idx = modifiedNodes.findIndex(n => n.name === r.originalName && n.dayIndex === r.dayIndex);
      }
      if (idx === -1) {
        idx = modifiedNodes.findIndex(n => n.name === r.originalName);
      }
      if (idx !== -1) {
        if (r.newName === '__AUTO_REPLACE__') {
          const oldName = modifiedNodes[idx].name;
          console.log(`[Chat] Marking "${oldName}" (Day ${r.dayIndex} ${r.timeSlot}) for auto-replacement${r.searchKeywords ? ` with keywords: [${r.searchKeywords.join(', ')}]` : ''}`);
          // 保留原始 location 用于后续搜索替代
          modifiedNodes[idx] = { ...modifiedNodes[idx], name: `__PENDING_REPLACE__${oldName}`, description: '' };
          // 存储搜索关键词供后续使用
          if (r.searchKeywords && r.searchKeywords.length > 0) {
            pendingKeywordsMap.set(`${r.dayIndex}_${r.timeSlot}`, r.searchKeywords);
          }
        } else {
          const oldName = modifiedNodes[idx].name;
          const newActivity = modifiedNodes[idx].activity ? modifiedNodes[idx].activity!.replace(oldName, r.newName) : modifiedNodes[idx].activity;
          console.log(`[Chat] Replacing "${oldName}" (Day ${modifiedNodes[idx].dayIndex} ${modifiedNodes[idx].timeSlot}) with "${r.newName}"`);
          modifiedNodes[idx] = { ...modifiedNodes[idx], name: r.newName, activity: newActivity, priceInfo: r.priceInfo, location: undefined, description: '' };
        }
      } else {
        console.warn(`[Chat] Could not find node to replace: dayIndex=${r.dayIndex}, timeSlot=${r.timeSlot}, originalName="${r.originalName}"`);
      }
    }

    // === Phase 1.1: 应用交换操作 ===
    for (const s of intent.swaps || []) {
      const idxA = modifiedNodes.findIndex(n => n.dayIndex === s.dayIndexA && n.timeSlot === s.timeSlotA);
      const idxB = modifiedNodes.findIndex(n => n.dayIndex === s.dayIndexB && n.timeSlot === s.timeSlotB);
      if (idxA !== -1 && idxB !== -1) {
        const nodeA = modifiedNodes[idxA];
        const nodeB = modifiedNodes[idxB];
        console.log(`[Chat] Swapping "${nodeA.name}" (Day ${s.dayIndexA} ${s.timeSlotA}) <-> "${nodeB.name}" (Day ${s.dayIndexB} ${s.timeSlotB})`);

        // 交换名称、地址、位置、描述、活动等内容，保留各自的时段框架信息
        const tempName = nodeA.name;
        const tempAddress = nodeA.address;
        const tempLocation = nodeA.location;
        const tempDescription = nodeA.description;
        const tempPriceInfo = nodeA.priceInfo;

        nodeA.name = nodeB.name;
        nodeA.address = nodeB.address;
        nodeA.location = nodeB.location;
        nodeA.description = nodeB.description;
        nodeA.priceInfo = nodeB.priceInfo;
        nodeA.activity = `${this.getSlotLabel(nodeA.timeSlot || 'morning')}：${nodeB.name}`;

        nodeB.name = tempName;
        nodeB.address = tempAddress;
        nodeB.location = tempLocation;
        nodeB.description = tempDescription;
        nodeB.priceInfo = tempPriceInfo;
        nodeB.activity = `${this.getSlotLabel(nodeB.timeSlot || 'morning')}：${tempName}`;
      } else {
        console.warn(`[Chat] Could not find nodes to swap: A=(Day ${s.dayIndexA} ${s.timeSlotA} "${s.nameA}"), B=(Day ${s.dayIndexB} ${s.timeSlotB} "${s.nameB}")`);
      }
    }

    // 判断候选 POI 是否应该被排除（与原景点过于相似或距离太近）
    const shouldExcludeCandidate = (candidateName: string, candidateLocation: string | undefined, originalName: string, originalLocation: string): boolean => {
      // 名称完全相同
      if (candidateName === originalName) return true;
      // 互相包含：如"广州塔A区"包含"广州塔"
      if (candidateName.includes(originalName) || originalName.includes(candidateName)) return true;
      // 去掉常见后缀后相同
      const cleanA = candidateName.replace(/[\(（].*[\)）]|[A-Za-z]区$|[东南西北]区$|[东南西北]门$|分[馆店]$/g, '').trim();
      const cleanB = originalName.replace(/[\(（].*[\)）]|[A-Za-z]区$|[东南西北]区$|[东南西北]门$|分[馆店]$/g, '').trim();
      if (cleanA === cleanB) return true;
      // 距离过滤：距原位置 500 米内的 POI 很可能是同一景点的子区域/设施
      if (candidateLocation && originalLocation) {
        const dist = amapClient.calculateDistance(candidateLocation, originalLocation);
        if (dist < 0.5) return true;
      }
      return false;
    };

    // 处理 __PENDING_REPLACE__ 标记的节点：搜索附近同类型 POI 替换
    const pendingNodes = modifiedNodes.filter(n => n.name.startsWith('__PENDING_REPLACE__'));
    if (pendingNodes.length > 0) {
      const usedNames = new Set(modifiedNodes.filter(n => !n.name.startsWith('__PENDING_REPLACE__') && (n.type === 'attraction' || n.type === 'restaurant')).map(n => n.name));

      for (const node of pendingNodes) {
        const origName = node.name.replace(/^__PENDING_REPLACE__/, '');
        const searchCenter = node.location
          || modifiedNodes.find(n => n.dayIndex === node.dayIndex && n.type === 'hotel')?.location
          || modifiedNodes.find(n => n.dayIndex === node.dayIndex && n.location)?.location;
        if (!searchCenter) {
          console.warn(`[Chat] No search center for pending node, restored "${origName}"`);
          node.name = origName;
          continue;
        }

        // 检查是否有用户指定的搜索关键词（模糊偏好场景）
        const keywords = pendingKeywordsMap.get(`${node.dayIndex}_${node.timeSlot}`);
        const poiType = node.type === 'restaurant' ? '050000' : '110000|140000';
        
        try {
          let replacement: { name: string; location: string; address?: string } | undefined;

          if (keywords && keywords.length > 0) {
            // 有关键词：按关键词逐个搜索，收集候选后让 LLM 选最佳
            console.log(`[Chat] Searching with user keywords [${keywords.join(', ')}] for pending node "${origName}"`);
            const allCandidates: Array<{ name: string; address: string; location: string; rating?: string }> = [];
            const seenNames = new Set<string>();

            for (const kw of keywords) {
              try {
                const pois = await amapClient.searchAround(searchCenter, 10000, {
                  keywords: kw,
                  types: poiType,
                  pageSize: 10,
                  sortRule: 'distance',
                });
                for (const p of pois) {
                  if (!p.location || usedNames.has(p.name) || shouldExcludeCandidate(p.name, p.location, origName, searchCenter) || seenNames.has(p.name)) continue;
                  if (node.type === 'attraction' && !this.isValidAttractionName(p.name)) continue;
                  seenNames.add(p.name);
                  allCandidates.push({
                    name: p.name,
                    address: p.address || '',
                    location: p.location,
                    rating: p.rating,
                  });
                }
              } catch { /* ignore individual keyword failures */ }
            }

            if (allCandidates.length > 0) {
              // 让 LLM 从候选中选最合适的
              const candidateList = allCandidates.slice(0, 10).map((c, i) =>
                `${i + 1}. ${c.name}${c.rating ? `（评分${c.rating}）` : ''}`
              ).join('\n');

              const selectPrompt = `用户想把"${origName}"替换为${keywords.join('/')}类型的景点。

候选：
${candidateList}

选择最适合的1个，只返回序号数字。`;

              try {
                const pickResult = await deepseekClient.chat([
                  { role: 'system', content: '你是旅游景点筛选专家。只返回一个数字序号。' },
                  { role: 'user', content: selectPrompt },
                ]);
                const pickIndex = parseInt(pickResult.trim(), 10) - 1;
                const picked = (pickIndex >= 0 && pickIndex < allCandidates.length) ? allCandidates[pickIndex] : allCandidates[0];
                replacement = picked;
              } catch {
                replacement = allCandidates[0];
              }
            }
          }

          // 无关键词或关键词搜索无结果：回退到通用类型搜索
          if (!replacement) {
            const pois = await amapClient.searchAround(searchCenter, 10000, {
              types: poiType,
              pageSize: 15,
              sortRule: 'distance',
            });
            replacement = pois.find(p => p.location && !usedNames.has(p.name) && !shouldExcludeCandidate(p.name, p.location, origName, searchCenter));
          }

          if (replacement) {
            console.log(`[Chat] Auto-replaced pending node "${origName}" (Day ${node.dayIndex} ${node.timeSlot}) with "${replacement.name}"`);
            usedNames.add(replacement.name);
            node.name = replacement.name;
            node.address = replacement.address || '';
            node.location = replacement.location;
            node.description = '';
            node.activity = `${this.getSlotLabel(node.timeSlot || 'morning')}：${replacement.name}`;
          } else {
            node.name = origName;
            console.warn(`[Chat] No replacement found for pending node, restored "${origName}"`);
          }
        } catch (e) {
          node.name = origName;
          console.warn(`[Chat] Auto-replace search failed, restored "${origName}":`, e);
        }
      }
    }

    // === Phase 1.5: 去重检查 —— 检测用户修改导致的同名 POI 重复 ===
    // 场景：用户说"我想晚上去广州塔"，LLM 把晚上换成广州塔，但白天已经有广州塔了
    // 策略：保留用户指定的那个，把非用户指定的重复节点替换掉
    const userRequestedSlots = new Set<string>();
    for (const r of intent.replacements || []) {
      userRequestedSlots.add(`${r.dayIndex}_${r.timeSlot}_${r.newName}`);
    }

    // 按名称分组，找出同名或名称相似的景点/餐厅节点
    const nameOccurrences = new Map<string, TravelNode[]>();
    for (const node of modifiedNodes) {
      if (node.type !== 'attraction' && node.type !== 'restaurant') continue;
      // 先检查是否与已有分组中的某个名称相似
      let matchedKey: string | null = null;
      for (const [key, _nodes] of nameOccurrences) {
        if (this.isSameAttraction(node.name, key, node.location, _nodes[0]?.location)) {
          matchedKey = key;
          break;
        }
      }
      if (matchedKey) {
        nameOccurrences.get(matchedKey)!.push(node);
      } else {
        nameOccurrences.set(node.name, [node]);
      }
    }

    const duplicateNodesToReplace: TravelNode[] = [];
    for (const [name, nodes] of nameOccurrences) {
      if (nodes.length <= 1) continue;
      console.log(`[Chat] Duplicate detected: "${name}" appears ${nodes.length} times`);

      // 判断哪些是用户指定的
      const userRequested: TravelNode[] = [];
      const nonUserRequested: TravelNode[] = [];
      for (const n of nodes) {
        const key = `${n.dayIndex}_${n.timeSlot}_${n.name}`;
        if (userRequestedSlots.has(key)) {
          userRequested.push(n);
        } else {
          nonUserRequested.push(n);
        }
      }

      // 如果全部都是用户指定的（极端情况），保留第一个
      if (nonUserRequested.length === 0 && userRequested.length > 1) {
        duplicateNodesToReplace.push(...userRequested.slice(1));
      } else {
        // 正常情况：替换掉非用户指定的重复节点
        duplicateNodesToReplace.push(...nonUserRequested);
      }
    }

    if (duplicateNodesToReplace.length > 0) {
      console.log(`[Chat] Replacing ${duplicateNodesToReplace.length} duplicate node(s)...`);
      const usedNames = new Set(modifiedNodes.filter(n => n.type === 'attraction' || n.type === 'restaurant').map(n => n.name));

      for (const dupNode of duplicateNodesToReplace) {
        // 搜索附近同类型的替代 POI
        const searchCenter = dupNode.location
          || modifiedNodes.find(n => n.dayIndex === dupNode.dayIndex && n.type === 'hotel')?.location;
        if (!searchCenter) continue;

        const poiType = dupNode.type === 'restaurant' ? '050000' : '110000|140000';
        try {
          const pois = await amapClient.searchAround(searchCenter, 10000, {
            types: poiType,
            pageSize: 15,
            sortRule: 'distance',
          });
          const replacement = pois.find(p => p.location && !usedNames.has(p.name) && !shouldExcludeCandidate(p.name, p.location, dupNode.name, searchCenter));
          if (replacement) {
            console.log(`[Chat] Replaced duplicate "${dupNode.name}" (Day ${dupNode.dayIndex} ${dupNode.timeSlot}) with "${replacement.name}"`);
            usedNames.add(replacement.name);
            dupNode.name = replacement.name;
            dupNode.address = replacement.address || '';
            dupNode.location = replacement.location;
            dupNode.description = '';
            dupNode.activity = `${this.getSlotLabel(dupNode.timeSlot || 'morning')}：${replacement.name}`;
          } else {
            console.warn(`[Chat] No replacement found for duplicate "${dupNode.name}" on Day ${dupNode.dayIndex}`);
          }
        } catch (e) {
          console.warn(`[Chat] Failed to replace duplicate "${dupNode.name}":`, e);
        }
      }
    }

    // === Phase 2: 为修改过的节点获取位置信息 ===
    const modifiedNodeNames = new Set<string>();
    if (intent.hotelChange) modifiedNodeNames.add(intent.hotelChange.newHotelName);
    for (const r of intent.replacements || []) modifiedNodeNames.add(r.newName);
    
    // 酒店品牌名 → 具体分店名的映射缓存，避免重复搜索
    const hotelNameResolution = new Map<string, { name: string; location: string; address: string }>();

    for (const node of modifiedNodes) {
      if (node.type === 'transport') continue;
      if (!node.location) {
        // 酒店节点：先检查是否已解析过同品牌名
        if (node.type === 'hotel' && hotelNameResolution.has(node.name)) {
          const resolved = hotelNameResolution.get(node.name)!;
          node.activity = node.activity?.replace(node.name, resolved.name) || node.activity;
          node.name = resolved.name;
          node.location = resolved.location;
          node.address = resolved.address;
          continue;
        }

        const result = await poiService.searchPOIs({ 
          city: destination, 
          type: node.type as 'hotel' | 'restaurant' | 'attraction', 
          keywords: node.name, 
          count: 1 
        });
        if (result.length > 0) {
          // 酒店：用搜到的具体分店名替换品牌名（如"全季酒店" → "全季酒店(广州塔琶醍店)"）
          if (node.type === 'hotel' && result[0].name && result[0].name !== node.name) {
            const oldName = node.name;
            const newName = result[0].name;
            console.log(`[Chat] Resolved hotel "${oldName}" -> "${newName}"`);
            hotelNameResolution.set(oldName, {
              name: newName,
              location: result[0].location || '',
              address: result[0].address || '',
            });
            node.activity = node.activity?.replace(oldName, newName) || node.activity;
            node.name = newName;
          }
          node.location = result[0].location;
          node.address = result[0].address || node.address;
        }
      }
    }

    // === Phase 3: 保留已有框架，只替换用户指定的节点 ===
    // 不再拆解重建整天，而是保持框架不变，仅对用户要求修改的节点做替换
    const affectedDays = new Set<number>();
    for (const r of intent.replacements || []) {
      affectedDays.add(r.dayIndex);
    }
    for (const s of intent.swaps || []) {
      affectedDays.add(s.dayIndexA);
      affectedDays.add(s.dayIndexB);
    }
    if (intent.hotelChange) {
      for (let d = 1; d <= totalDays; d++) affectedDays.add(d);
    }

    if (affectedDays.size > 0) {
      console.log(`[Chat] Affected days: ${[...affectedDays].join(', ')}, preserving framework, only replacing specified nodes...`);
      
      // 收集已用 POI
      const usedPOIs = new Set<string>();
      for (const node of modifiedNodes) {
        if (node.type === 'attraction' || node.type === 'restaurant') {
          usedPOIs.add(node.name);
        }
      }

      // 对于用户指定替换的节点，如果缺少位置信息，搜索附近候选补充
      for (const r of intent.replacements || []) {
        const node = modifiedNodes.find(n => n.name === r.newName && n.dayIndex === r.dayIndex);
        if (node && !node.location) {
          try {
            const result = await poiService.searchPOIs({
              city: destination,
              type: node.type as 'hotel' | 'restaurant' | 'attraction',
              keywords: node.name,
              count: 1,
            });
            if (result.length > 0) {
              node.location = result[0].location;
              node.address = result[0].address || node.address;
            }
          } catch (e) {
            console.warn(`[Chat] Failed to search location for "${node.name}":`, e);
          }
        }
      }

      // 全局重新排序
      this.reorderNodes(modifiedNodes);
    }
    
    // === Phase 4: 为修改过的节点生成描述 ===
    const allNewNames = new Set(modifiedNodeNames);
    for (const node of modifiedNodes) {
      if ((node.type === 'attraction' || node.type === 'restaurant') && !node.description) {
        allNewNames.add(node.name);
      }
    }
    
    const nodesToEnrich = modifiedNodes.filter(n => 
      allNewNames.has(n.name) && 
      (n.type === 'attraction' || n.type === 'restaurant') &&
      (!n.description || n.description === '')
    );
    
    if (nodesToEnrich.length > 0) {
      await this.enrichDescriptionsWithLLM(nodesToEnrich, destination);
    }

    // === Phase 5: 路径优化 + 距离计算 ===
    const hotelNode = modifiedNodes.find(n => n.type === 'hotel');
    if (hotelNode?.location) {
      const { routeOptimizer } = await import('./routeOptimizer');
      modifiedNodes = routeOptimizer.optimizeFullItinerary(modifiedNodes, hotelNode.location);
    }

    this.calculateDistanceToNext(modifiedNodes);

    // 餐厅去重
    this.deduplicateRestaurants(modifiedNodes);

    // 景点去重（防止用户修改导致同名/相似景点重复）
    await this.deduplicateAttractions(modifiedNodes);

    // 路线合理性检查
    const routeValidation = this.validateRouteReasonability(modifiedNodes);
    if (!routeValidation.valid) {
      console.warn('[Chat] Route has distance issues after re-optimization:', routeValidation.issues);
    }

    // === Phase 6: 框架完整性验证 ===
    // 确保修改后每天的时段框架仍然完整（breakfast/morning/lunch/afternoon/dinner/evening）
    console.log('[Chat] Validating daily framework after modifications...');
    const arrivalTime = modifiedNodes.find(n => n.timeSlot === 'arrival')?.scheduledTime || '10:00';
    const departureTime = modifiedNodes.find(n => n.timeSlot === 'departure')?.scheduledTime || '18:00';
    const frameworkCheck = this.validateDailyFramework(modifiedNodes, totalDays, arrivalTime, departureTime);
    if (!frameworkCheck.valid) {
      console.warn('[Chat] Framework issues after chat modification:', frameworkCheck.issues);
      if (frameworkCheck.missingSlots.length > 0) {
        console.log(`[Chat] Fixing ${frameworkCheck.missingSlots.length} missing slots...`);
        // 用搜索附近 POI 的方式补充缺失时段
        const usedPOIs = new Set<string>();
        for (const node of modifiedNodes) {
          if (node.type === 'attraction' || node.type === 'restaurant') {
            usedPOIs.add(node.name);
          }
        }
        for (const { dayIndex, slot } of frameworkCheck.missingSlots) {
          const slotConfig = this.getSlotConfig(slot);
          if (!slotConfig) continue;

          // 找当天的酒店或已有节点位置作为搜索中心
          const dayNodes = modifiedNodes.filter(n => n.dayIndex === dayIndex && n.location);
          const searchCenter = dayNodes.find(n => n.type === 'hotel')?.location
            || dayNodes[dayNodes.length - 1]?.location;
          if (!searchCenter) continue;

          const poiType = slotConfig.poiType;
          try {
            const pois = await amapClient.searchAround(searchCenter, 10000, {
              types: poiType === 'restaurant' ? '050000' : '110000|140000',
              pageSize: 15,
              sortRule: 'distance',
            });
            const replacement = pois.find(p => p.location && !usedPOIs.has(p.name));
            if (replacement) {
              usedPOIs.add(replacement.name);
              modifiedNodes.push({
                id: uuidv4(), itineraryId: '', name: replacement.name,
                type: poiType, address: replacement.address || '',
                description: '', activity: `${this.getSlotLabel(slot)}：${replacement.name}`,
                timeSlot: slot, estimatedDuration: slotConfig.duration,
                scheduledTime: slotConfig.time, dayIndex, order: 0,
                verified: true, isLit: false, location: replacement.location,
              });
              console.log(`[Chat] Fixed missing ${slot} on Day ${dayIndex}: "${replacement.name}"`);
            }
          } catch (e) {
            console.warn(`[Chat] Failed to fix missing ${slot} on Day ${dayIndex}:`, e);
          }
        }
        this.reorderNodes(modifiedNodes);
        this.calculateDistanceToNext(modifiedNodes);
      }
    } else {
      console.log('[Chat] Framework validation PASSED after modifications');
    }

    // === 最终兜底：基于修改记录的重复景点检查 ===
    // 前面的 resolveReplacementConflicts + deduplicateAttractions 可能因各种原因漏掉重复
    // 这里做最后一道防线：检查所有景点，如果发现重复，根据修改记录保留用户指定的那个
    await this.finalDuplicateCheck(modifiedNodes, userModificationTargets);

    return { nodes: modifiedNodes, response: intent.response };
  }

  /**
   * 计算 POI 的综合评分
   * 
   * 评分因素：
   * 1. 基础评分（rating）
   * 2. 类型质量（过滤低质量类型）
   * 3. 名称质量（过滤泛指名称）
   */
  private calculatePOIScore(poi: EnrichedPOI, type: 'hotel' | 'restaurant' | 'attraction'): number {
    // 基础评分：rating / 5，没有评分默认 0.5
    let score = poi.rating ? poi.rating / 5 : 0.5;
    
    // 景点类型质量过滤
    if (type === 'attraction') {
      const category = poi.category || 'other';
      const name = poi.name;
      
      // 按类别分级加减分（替代纯关键词匹配，更精准）
      const categoryScoreMap: Record<string, number> = {
        // 第一梯队：自然景观，大幅加分
        mountain: 0.25,
        lake: 0.25,
        river: 0.2,
        sea: 0.25,
        forest: 0.2,
        scenic_area: 0.2,
        
        // 第二梯队：人文精华
        ancient_town: 0.15,
        historic_building: 0.15,
        temple: 0.1,
        museum: 0.1,
        garden: 0.15,
        
        // 第三梯队：可以有但不要太多
        art_gallery: 0.05,
        botanical: 0.05,
        zoo: 0.05,
        park: -0.05,          // 普通公园轻微降分
        plaza: -0.1,          // 广场降分
        commercial_street: 0,
        
        // 第四梯队：尽量少选
        university: -0.3,     // 大学大幅降分
        school: -0.5,         // 中小学基本不选
        ancestral_hall: -0.2, // 宗祠降分
        memorial: -0.1,
        library: -0.1,
        
        other: -0.05,
      };
      
      score += categoryScoreMap[category] ?? -0.05;
      
      // 名称关键词惩罚：明显不适合旅游的 POI 大幅降分
      const LOW_QUALITY_PATTERNS = /牌坊|亭$|儿童.*公园|儿童.*乐园|驿站|绿道|碧道|广场$|球场|文化广场|体育/;
      if (LOW_QUALITY_PATTERNS.test(name)) {
        score -= 0.3;
      }

      // 非景点类 POI 直接归零（公司、教育机构、服务类等）
      if (!this.isValidAttractionName(name)) {
        return 0;
      }
      
      // 角色分级加分 —— 让角色直接影响基础分，CORE/MAJOR 天然高分
      const roleBonusMap: Record<string, number> = {
        CORE_ATTRACTION: 0.2,
        MAJOR_AREA: 0.15,
        NATURE_RELAX: 0.1,
        NIGHT_EXPERIENCE: 0.05,
        CULTURAL_SITE: 0.05,
        VIEWPOINT: 0,
        SHOPPING_AREA: 0,
        FILLER: -0.15,  // FILLER 大幅降分
      };
      score += roleBonusMap[poi.tourismRole || 'FILLER'] ?? -0.15;
      
      // 评分高的景点额外加分（鼓励选择热门景点）
      if (poi.rating && poi.rating >= 4.5) {
        score += 0.15;
      } else if (poi.rating && poi.rating >= 4.0) {
        score += 0.05;
      }
    }
    
    // 餐厅评分调整
    if (type === 'restaurant') {
      if (poi.rating && poi.rating >= 4.5) {
        score += 0.1;
      }
      if (poi.price) {
        score += 0.05;
      }
    }
    
    // 确保评分在 0-1 范围内
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 生成自然的描述文本
   */
  private generateNaturalDescription(poi: EnrichedPOI, type: string): string {
    const parts: string[] = [];
    
    // 优先使用 POI 自带的描述
    if (poi.description && poi.description.length > 5 && !poi.description.includes('值得一游')) {
      return poi.description;
    }
    
    if (type === 'restaurant') {
      // 餐厅描述
      const ratingText = poi.rating ? `评分${poi.rating}分` : '';
      const priceText = poi.price ? `人均约¥${poi.price}` : '';
      
      if (ratingText && priceText) {
        parts.push(`${ratingText}，${priceText}`);
      } else if (ratingText) {
        parts.push(ratingText);
      } else if (priceText) {
        parts.push(priceText);
      }
      
      if (parts.length === 0) {
        parts.push('当地人气餐厅，口碑不错');
      }
    } else if (type === 'hotel') {
      // 酒店描述
      if (poi.rating) {
        const ratingLevel = poi.rating >= 4.5 ? '好评如潮' : poi.rating >= 4 ? '口碑良好' : '性价比高';
        parts.push(`${ratingLevel}，评分${poi.rating}分`);
      }
      if (poi.price) {
        parts.push(`约¥${poi.price}/晚`);
      }
      if (parts.length === 0) {
        parts.push('位置便利，交通方便');
      }
    } else if (type === 'attraction') {
      // 景点描述
      if (poi.rating) {
        const ratingLevel = poi.rating >= 4.5 ? '热门必去' : poi.rating >= 4 ? '值得一游' : '可以打卡';
        parts.push(`${ratingLevel}，评分${poi.rating}分`);
      }
      if (parts.length === 0) {
        parts.push('当地特色景点，推荐游览');
      }
    }
    
    return parts.join('，');
  }

  private async parseUserIntent(currentNodes: TravelNode[], destination: string, 
    userMessage: string, chatHistory: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<UserIntent> {
    const summary = this.buildItinerarySummary(currentNodes);
    const prompt = `你是行程修改意图分析专家。分析用户对行程的修改意图，返回结构化的修改指令。

当前行程（${destination}）：
${summary}

用户说：${userMessage}

## 分析规则（按优先级排列）

规则1【最常见】：用户想在某天某时段安排某个具体景点/餐厅（如"我想在第5天晚上游览广州塔"、"把广州塔挪到第1天上午"）：
  - 只需一条 replacement，把目标时段的原景点替换为用户想要的景点
  - originalName 必须填写目标时段当前的景点名称
  - 不需要关心该景点是否已在行程中的其他位置，系统会自动处理移动逻辑

规则2：用户想交换两个景点的位置（如"把第1天晚上的寺庙和第2天上午的广州塔换一下"），使用 swaps 字段，不要用 replacements。这是直接互换，两个景点各自去对方的时段。

规则3：用户想直接替换某个景点为另一个（如"把第3天午餐换成海底捞"），只需一条 replacement。

规则4【模糊偏好】：用户没有给出具体景点名，而是描述了一个类型偏好（如"改成一个自然景观"、"换个博物馆"、"来个好吃的"、"想去个公园"）：
  - newName 设为 "__AUTO_REPLACE__"
  - 必须提供 searchKeywords 字段，包含2-3个可直接用于高德地图搜索的简短关键词（2-4个字）
  - 例如用户说"改成自然景观"，searchKeywords 应为 ["山", "湖", "森林公园"]
  - 例如用户说"换个博物馆"，searchKeywords 应为 ["博物馆"]
  - 例如用户说"来个好吃的"，searchKeywords 应为 ["美食", "餐厅"]
  - 绝对不要把用户的描述性文字（如"一个自然景观"）当作景点名填入 newName

规则5：用户想换酒店，使用 hotelChange。
  - 行程中可能有多个酒店（长途旅行会中途换酒店），从行程列表中可以看到不同的酒店名称
  - 如果用户指定了要换哪个酒店（如"第一次换酒店换成XX"、"把XX酒店换成YY"），originalHotelName 填写当前行程中要被替换的酒店名称
  - 如果用户没有指定换哪个（如"酒店换成XX"），originalHotelName 不填，表示替换所有酒店
  - 如果用户说的是模糊偏好（如"换个便宜点的酒店"、"换成亚朵系列"），newHotelName 填用户提到的品牌/关键词（如"亚朵酒店"）

规则6：用户只是闲聊或询问，hasModification 设为 false。

## 关键要求
- newName 只能是具体的景点/餐厅名称，或者 "__AUTO_REPLACE__"。绝不能是描述性文字（如"一个自然景观"、"一个博物馆"）
- originalName / nameA / nameB 必须是当前行程中该时段实际存在的景点/餐厅名称，从上面的行程列表中精确复制，不要编造
- dayIndex 和 timeSlot 必须与当前行程中的实际数据对应
- response 字段是对用户的简短友好回复

## 返回格式（严格JSON，不要其他内容）

示例1 - 在指定时段安排具体景点（无论该景点是否已在行程中，系统自动处理）：
{"hasModification":true,"response":"好的，已将第5天晚上改为游览广州塔","hotelChange":null,"replacements":[{"dayIndex":5,"timeSlot":"evening","originalName":"当前第5天evening的景点名","newName":"广州塔"}],"swaps":null}

示例2 - 交换两个景点的位置：
{"hasModification":true,"response":"好的，已将第1天晚上的光孝寺和第2天上午的广州塔互换","hotelChange":null,"replacements":null,"swaps":[{"dayIndexA":1,"timeSlotA":"evening","nameA":"光孝寺","dayIndexB":2,"timeSlotB":"morning","nameB":"广州塔"}]}

示例3 - 模糊偏好替换（用户没说具体景点名）：
{"hasModification":true,"response":"好的，我来帮您把第1天下午换成一个自然景观","hotelChange":null,"replacements":[{"dayIndex":1,"timeSlot":"afternoon","originalName":"当前景点名","newName":"__AUTO_REPLACE__","searchKeywords":["山","湖","森林公园"]}],"swaps":null}

示例4 - 换指定酒店（行程中有多个酒店时）：
{"hasModification":true,"response":"好的，已将第二家酒店换为亚朵酒店","hotelChange":{"newHotelName":"亚朵酒店","originalHotelName":"原来第二家酒店名"},"replacements":null,"swaps":null}

示例5 - 换所有酒店：
{"hasModification":true,"response":"好的，已将酒店换为白天鹅宾馆","hotelChange":{"newHotelName":"白天鹅宾馆"},"replacements":null,"swaps":null}

timeSlot 可选值：breakfast, morning, lunch, afternoon, dinner, evening`;
    
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是行程修改意图分析专家。严格按要求返回JSON，不要返回其他内容。注意：你只负责分析意图并返回结构化指令，不要自己执行修改。' },
      ...chatHistory.slice(-3).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: prompt }
    ];

    try {
      return await deepseekClient.chatWithJson<UserIntent>(messages);
    } catch {
      return { hasModification: false, response: '抱歉，请再说一遍？' };
    }
  }

  private buildItinerarySummary(nodes: TravelNode[]): string {
    const groups = new Map<number, TravelNode[]>();
    nodes.forEach(n => { if (!groups.has(n.dayIndex)) groups.set(n.dayIndex, []); groups.get(n.dayIndex)!.push(n); });
    
    const lines: string[] = [];
    
    // 酒店信息单独列出
    const hotelNames = [...new Set(nodes.filter(n => n.type === 'hotel').map(n => n.name))];
    if (hotelNames.length > 0) {
      lines.push(`住宿：${hotelNames.join('、')}`);
    }
    
    // 每天只列出景点和餐厅，减少噪音让 LLM 更容易识别
    for (const [day, ns] of Array.from(groups.entries())) {
      const meaningful = ns.sort((a,b)=>a.order-b.order)
        .filter(n => n.type === 'attraction' || n.type === 'restaurant')
        .map(n => `${n.timeSlot}:${n.name}`);
      lines.push(`第${day}天：${meaningful.join(', ')}`);
    }
    
    return lines.join('\n');
  }


  private calculateDistanceToNext(nodes: TravelNode[]): void {
    const groups = new Map<number, TravelNode[]>();
    nodes.forEach(n => { if (!groups.has(n.dayIndex)) groups.set(n.dayIndex, []); groups.get(n.dayIndex)!.push(n); });
    for (const dayNodes of groups.values()) {
      dayNodes.sort((a, b) => a.order - b.order);
      for (let i = 0; i < dayNodes.length - 1; i++) {
        if (dayNodes[i].location && dayNodes[i + 1].location) {
          const distance = amapClient.calculateDistance(dayNodes[i].location!, dayNodes[i + 1].location!);
          
          // 如果距离小于0.1km（100米），视为同一位置，不显示距离和交通
          if (distance < 0.1) {
            dayNodes[i].distanceToNext = 0;
            // 清除下一个节点的交通信息（同一位置不需要交通）
            dayNodes[i + 1].transportMode = undefined;
            dayNodes[i + 1].transportDuration = undefined;
          } else {
            dayNodes[i].distanceToNext = distance;
            // 如果下一个节点没有交通信息，根据距离填充
            if (!dayNodes[i + 1].transportMode) {
              dayNodes[i + 1].transportMode = this.inferTransportMode(distance);
              dayNodes[i + 1].transportDuration = this.estimateTravelTime(distance);
            }
          }
        }
      }
    }
  }

  private estimateTravelTime(dist: number): number {
    // 根据距离和交通方式估算时间
    // < 1km: 步行，约 12 分钟/公里
    // 1-3km: 公交/骑行，约 5 分钟/公里
    // 3-8km: 地铁，约 3 分钟/公里
    // > 8km: 打车，约 2.5 分钟/公里
    if (dist < 1) return Math.max(5, Math.ceil(dist * 12));
    if (dist < 3) return Math.ceil(dist * 5);
    if (dist < 8) return Math.ceil(dist * 3);
    return Math.ceil(dist * 2.5);
  }

  private addMinutes(time: string, mins: number): string {
    const [h, m] = time.split(':').map(Number);
    const total = h * 60 + m + mins;
    return `${Math.floor(total/60).toString().padStart(2,'0')}:${(total%60).toString().padStart(2,'0')}`;
  }

  private getSlotLabel(type: string): string {
    const labels: Record<string, string> = { breakfast:'早餐', morning:'上午', lunch:'午餐', afternoon:'下午', dinner:'晚餐', evening:'晚上' };
    return labels[type] || type;
  }

  private inferTransportMode(dist: number): string {
    if (dist < 1) return 'walk'; if (dist < 3) return 'bus'; if (dist < 8) return 'subway'; return 'taxi';
  }

  private createNode(day: number, order: number, timeSlot: string, time: string, name: string, 
    type: 'hotel' | 'transport' | 'attraction' | 'restaurant', address: string, activity: string, location?: string,
    transportMode?: string, transportDuration?: number): TravelNode {
    return { id: uuidv4(), itineraryId: '', name, type, address, description: '', activity, timeSlot,
      estimatedDuration: 30, scheduledTime: time, dayIndex: day, order, verified: type !== 'transport', isLit: false, location,
      transportMode, transportDuration };
  }

  /**
   * 验证路线合理性（与 itineraryService 保持一致）
   */
  private validateRouteReasonability(nodes: TravelNode[]): { 
    valid: boolean; 
    issues: string[];
  } {
    const issues: string[] = [];
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }

    // 只检查硬性超标，不做软约束警告
    const DISTANCE_LIMITS = {
      fromHotelMax: 30,
      toHotelMax: 30,
      betweenNodesMax: 20,   // 中间节点（含餐厅）统一 20km 硬限制
      dailyTotalMax: 60,
    };

    for (const [day, dayNodes] of nodesByDay) {
      dayNodes.sort((a, b) => a.order - b.order);
      let totalDistance = 0;

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
            issues.push(`第${day}天：从"${currentNode.name}"到"${nextNode?.name}"距离${distance.toFixed(1)}km（限制${maxAllowed}km）`);
          }
        }
      }

      if (totalDistance > DISTANCE_LIMITS.dailyTotalMax) {
        issues.push(`第${day}天：总移动距离${totalDistance.toFixed(1)}km超过${DISTANCE_LIMITS.dailyTotalMax}km`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * 修复距离问题（与 itineraryService 保持一致）
   */
  private async fixDistanceIssues(nodes: TravelNode[], destination: string, totalDays: number): Promise<TravelNode[]> {
    const hotelNode = nodes.find(n => n.type === 'hotel' || n.timeSlot === 'hotel');
    if (!hotelNode?.location) return nodes;

    const hotelLocation = hotelNode.location;
    const MAX_DISTANCE = 20;
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }

    for (let dayIndex = 1; dayIndex <= totalDays; dayIndex++) {
      const dayNodes = nodesByDay.get(dayIndex);
      if (!dayNodes) continue;
      dayNodes.sort((a, b) => a.order - b.order);

      for (let i = 0; i < dayNodes.length; i++) {
        const currentNode = dayNodes[i];
        if (['arrival', 'hotel', 'departure'].includes(currentNode.timeSlot || '')) continue;
        if (currentNode.type === 'transport' || !currentNode.location) continue;

        let prevLocation = hotelLocation;
        for (let j = i - 1; j >= 0; j--) {
          if (dayNodes[j].location) {
            prevLocation = dayNodes[j].location!;
            break;
          }
        }

        const dist = amapClient.calculateDistance(prevLocation, currentNode.location);
        if (dist > MAX_DISTANCE) {
          // 搜索附近替代 POI
          const searchType = currentNode.type === 'restaurant' ? '050000' : '110000|140000';
          try {
            const pois = await amapClient.searchAround(prevLocation, 15000, {
              types: searchType,
              pageSize: 10,
              sortRule: 'distance',
            });

            const replacement = pois.find(p => p.location && p.name !== currentNode.name);
            if (replacement) {
              console.log(`[Chat] Replacing "${currentNode.name}" with "${replacement.name}" (closer)`);
              const nodeIndex = nodes.findIndex(n => n.id === currentNode.id);
              if (nodeIndex !== -1) {
                const oldName = nodes[nodeIndex].name;
                nodes[nodeIndex].name = replacement.name;
                nodes[nodeIndex].address = replacement.address || nodes[nodeIndex].address;
                nodes[nodeIndex].location = replacement.location;
                // 同步更新 activity 字段，保持标题和内容一致
                if (nodes[nodeIndex].activity) {
                  nodes[nodeIndex].activity = nodes[nodeIndex].activity.replace(oldName, replacement.name);
                }
              }
            }
          } catch (e) {
            console.warn(`[Chat] Failed to find replacement for ${currentNode.name}:`, e);
          }
        }
      }
    }

    return nodes;
  }

  /**
   * 计算所有景点的地理中心
   */
  private calculateAttractionCenter(nodes: TravelNode[]): AttractionCenter | null {
    const attractionNodes = nodes.filter(n => 
      n.type === 'attraction' && 
      n.location && 
      !['arrival', 'departure', 'hotel'].includes(n.timeSlot || '')
    );

    if (attractionNodes.length === 0) return null;

    let sumLng = 0, sumLat = 0;
    const locations: Array<{ lng: number; lat: number }> = [];

    for (const node of attractionNodes) {
      const [lng, lat] = node.location!.split(',').map(Number);
      sumLng += lng;
      sumLat += lat;
      locations.push({ lng, lat });
    }

    const centerLng = sumLng / attractionNodes.length;
    const centerLat = sumLat / attractionNodes.length;

    // 计算平均距离
    let totalDist = 0;
    for (const loc of locations) {
      const dLng = (loc.lng - centerLng) * 111 * Math.cos((centerLat * Math.PI) / 180);
      const dLat = (loc.lat - centerLat) * 111;
      totalDist += Math.sqrt(dLng * dLng + dLat * dLat);
    }

    return {
      lng: centerLng,
      lat: centerLat,
      avgDistance: totalDist / locations.length,
    };
  }

  /**
   * 优化酒店选择 - 在行程生成后，选择离景点更近的酒店
   * 
   * 策略：
   * 1. 计算所有景点的地理中心
   * 2. 搜索该中心附近的酒店
   * 3. 如果找到比当前酒店更近的酒店，进行替换
   */
  async optimizeHotelSelection(
    nodes: TravelNode[],
    destination: string,
    availableHotels: EnrichedPOI[]
  ): Promise<TravelNode[]> {
    console.log('[HotelOptimizer] Starting hotel optimization...');

    // 1. 找到当前酒店
    const currentHotelNode = nodes.find(n => n.type === 'hotel' || n.timeSlot === 'hotel');
    if (!currentHotelNode?.location) {
      console.log('[HotelOptimizer] No current hotel found, skipping optimization');
      return nodes;
    }

    // 2. 计算景点中心
    const center = this.calculateAttractionCenter(nodes);
    if (!center) {
      console.log('[HotelOptimizer] No attractions found, skipping optimization');
      return nodes;
    }

    const centerLocation = `${center.lng},${center.lat}`;
    console.log(`[HotelOptimizer] Attraction center: ${centerLocation}, avg distance: ${center.avgDistance.toFixed(1)}km`);

    // 3. 计算当前酒店到景点中心的距离
    const currentHotelDistance = amapClient.calculateDistance(currentHotelNode.location, centerLocation);
    console.log(`[HotelOptimizer] Current hotel "${currentHotelNode.name}" distance to center: ${currentHotelDistance.toFixed(1)}km`);

    // 4. 只从连锁酒店中找更近的
    const chainHotels = this.filterChainHotelsOnly(availableHotels);
    let bestHotel: EnrichedPOI | null = null;
    let bestDistance = currentHotelDistance;

    for (const hotel of chainHotels) {
      if (!hotel.location || hotel.name === currentHotelNode.name) continue;
      
      const distance = amapClient.calculateDistance(hotel.location, centerLocation);
      if (distance < bestDistance - 1) { // 至少近 1km 才考虑替换
        bestDistance = distance;
        bestHotel = hotel;
      }
    }

    // 5. 如果可用连锁酒店中没有更好的，搜索景点中心附近的连锁酒店
    if (!bestHotel) {
      console.log('[HotelOptimizer] No better chain hotel in available list, searching around attraction center...');
      try {
        const searchRadius = Math.max(5000, Math.min(center.avgDistance * 1000, 15000));
        // 用连锁品牌关键词搜索
        const brandKeywords = this.PREFERRED_HOTEL_BRANDS.slice(0, 8).join('|');
        const nearbyHotels = await amapClient.searchAround(centerLocation, searchRadius, {
          types: '100000',
          keywords: brandKeywords,
          pageSize: 20,
          sortRule: 'distance',
        });

        for (const hotel of nearbyHotels) {
          if (!hotel.location || hotel.name === currentHotelNode.name) continue;
          // 必须是连锁品牌
          if (!this.isPreferredBrandHotel(hotel.name)) continue;
          if (this.isLowEndHotel(hotel.name)) continue;
          
          const distance = amapClient.calculateDistance(hotel.location, centerLocation);
          if (distance < bestDistance - 1) {
            bestDistance = distance;
            bestHotel = {
              ...hotel,
              type: 'hotel',
              description: hotel.name,
              rating: hotel.rating ? parseFloat(hotel.rating) : undefined,
            } as EnrichedPOI;
          }
        }
      } catch (e) {
        console.warn('[HotelOptimizer] Failed to search nearby hotels:', e);
      }
    }

    // 6. 如果找到更好的酒店，替换所有酒店节点
    if (bestHotel) {
      const improvement = currentHotelDistance - bestDistance;
      console.log(`[HotelOptimizer] Found better chain hotel "${bestHotel.name}" (${bestDistance.toFixed(1)}km from center, ${improvement.toFixed(1)}km closer)`);

      // 替换所有酒店节点
      for (const node of nodes) {
        if (node.type === 'hotel' || node.timeSlot === 'hotel') {
          const oldName = node.name;
          node.name = bestHotel.name;
          node.address = bestHotel.address || node.address;
          node.location = bestHotel.location;
          node.description = bestHotel.description || node.description;
          // 同步更新 activity 字段
          if (node.activity) {
            node.activity = node.activity.replace(oldName, bestHotel.name);
          }
        }
      }

      // 重新计算距离
      this.calculateDistanceToNext(nodes);
      console.log('[HotelOptimizer] Hotel replaced and distances recalculated');
    } else {
      console.log('[HotelOptimizer] Current hotel is already optimal');
    }

    return nodes;
  }

  /**
   * 验证每天行程框架的完整性
   * 检查每天是否有完整的活动安排，考虑第一天和最后一天的特殊性
   */
  private validateDailyFramework(
    nodes: TravelNode[],
    totalDays: number,
    arrivalTime: string,
    departureTime: string
  ): { valid: boolean; issues: string[]; missingSlots: Array<{ dayIndex: number; slot: string }> } {
    const issues: string[] = [];
    const missingSlots: Array<{ dayIndex: number; slot: string }> = [];
    
    const arrivalHour = parseInt(arrivalTime.split(':')[0], 10);
    const departureHour = parseInt(departureTime.split(':')[0], 10);
    
    // 按天分组
    const nodesByDay = new Map<number, TravelNode[]>();
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
      
      // 根据 generateDayFramework 的逻辑确定应有的时段
      let requiredSlots: string[] = [];
      
      if (isFirstDay) {
        // 第一天：抵达后1小时才能开始活动
        const availableFromHour = arrivalHour + 1;
        if (availableFromHour <= 9) requiredSlots.push('morning');
        if (availableFromHour <= 11) requiredSlots.push('lunch');
        if (availableFromHour <= 13) requiredSlots.push('afternoon');
        if (availableFromHour <= 17) requiredSlots.push('dinner');
        if (availableFromHour <= 19) requiredSlots.push('evening');
      } else if (isLastDay) {
        // 最后一天：需要提前2小时出发
        requiredSlots.push('breakfast');
        if (departureHour >= 13) requiredSlots.push('morning'); // 9:30 + 2h buffer + 1.5h activity
        if (departureHour >= 15) requiredSlots.push('lunch');
        if (departureHour >= 18) requiredSlots.push('afternoon');
      } else {
        // 中间天：完整的一天
        requiredSlots = ['breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening'];
      }
      
      // 检查缺失的时段
      for (const slot of requiredSlots) {
        if (!slots.has(slot)) {
          issues.push(`第${day}天缺少${this.getSlotLabel(slot)}`);
          missingSlots.push({ dayIndex: day, slot });
        }
      }
      
      // 检查活动节点数量
      const activityNodes = dayNodes.filter(n => 
        n.type === 'attraction' || n.type === 'restaurant'
      );
      
      // 第一天如果很晚到达，可能没有活动是正常的
      const minActivities = isFirstDay && arrivalHour >= 20 ? 0 : 1;
      if (activityNodes.length < minActivities) {
        issues.push(`第${day}天活动安排不足`);
      }
    }
    
    return { valid: issues.length === 0, issues, missingSlots };
  }

  /**
   * 修复缺失的行程环节
   */
  private async fixMissingSlots(
    nodes: TravelNode[],
    missingSlots: Array<{ dayIndex: number; slot: string }>,
    destination: string,
    hotelAssignments: DailyHotelAssignment[],
    clusterResult: ClusterResult,
    scoredAttractions: ScoredPOI[],
    scoredRestaurants: ScoredPOI[],
    usedPOIs: Set<string>
  ): Promise<TravelNode[]> {
    if (missingSlots.length === 0) return nodes;
    
    console.log(`[Pipeline] Fixing ${missingSlots.length} missing slots...`);
    
    for (const { dayIndex, slot } of missingSlots) {
      const hotelAssignment = hotelAssignments.find(a => a.dayIndex === dayIndex);
      if (!hotelAssignment) {
        console.warn(`[Pipeline] No hotel assignment for day ${dayIndex}`);
        continue;
      }
      
      const hotel = hotelAssignment.hotel;
      const clusterId = hotelAssignment.clusterId;
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      
      // 获取当天可用的 POI（优先区域内，没有则用全部）
      let dayAttractions = cluster 
        ? scoredAttractions.filter(s => cluster.attractions.some(a => a.name === s.poi.name))
        : scoredAttractions;
      let dayRestaurants = cluster
        ? scoredRestaurants.filter(s => cluster.restaurants.some(r => r.name === s.poi.name))
        : scoredRestaurants;
      
      // 如果区域内没有足够的 POI，使用全部
      if (dayAttractions.length === 0) {
        console.log(`[Pipeline] No attractions in cluster for day ${dayIndex}, using all`);
        dayAttractions = scoredAttractions;
      }
      if (dayRestaurants.length === 0) {
        console.log(`[Pipeline] No restaurants in cluster for day ${dayIndex}, using all`);
        dayRestaurants = scoredRestaurants;
      }
      
      // 根据时段类型选择 POI
      const slotConfig = this.getSlotConfig(slot);
      if (!slotConfig) {
        console.log(`[Pipeline] No config for slot "${slot}", skipping`);
        continue;
      }
      
      const candidates = slotConfig.poiType === 'restaurant' ? dayRestaurants : dayAttractions;
      console.log(`[Pipeline] Day ${dayIndex} ${slot}: ${candidates.length} candidates available`);
      
      // 只选择未使用的 POI，按角色匹配度 + 多样性选择
      let availableCandidates = candidates.filter(c => !usedPOIs.has(c.poi.name));
      
      // 景点最低质量门槛
      if (slotConfig.poiType === 'attraction') {
        availableCandidates = availableCandidates.filter(c => c.score >= 0.2);
      }
      
      // 餐厅候选池耗尽时，实时搜索附近餐厅补充
      if (availableCandidates.length === 0 && slotConfig.poiType === 'restaurant') {
        // 用当天已有节点的位置或酒店位置作为搜索中心
        const dayExistingNodes = nodes.filter(n => n.dayIndex === dayIndex && n.location);
        const searchCenter = dayExistingNodes.length > 0 
          ? dayExistingNodes[dayExistingNodes.length - 1].location!
          : hotel.location!;
        
        console.log(`[Pipeline] Restaurant pool exhausted for Day ${dayIndex} ${slot}, searching nearby...`);
        const nearbyPOIs = await this.searchNearbyRestaurants(searchCenter, usedPOIs);
        if (nearbyPOIs.length > 0) {
          availableCandidates = nearbyPOIs.map(poi => ({ 
            poi, score: this.calculatePOIScore(poi, 'restaurant') 
          }));
          console.log(`[Pipeline] Found ${availableCandidates.length} nearby restaurants for fix`);
        }
      }
      
      // 获取该时段的角色偏好
      const slotRoleConfig = this.getSlotRoleConfig(slot);
      const preferredRoles = slotRoleConfig?.preferredRoles || [];
      const slotWeight = slotRoleConfig?.roleWeight || 1.0;
      
      // 统计当天已有的景点角色
      const dayNodes = nodes.filter(n => n.dayIndex === dayIndex && n.type === 'attraction');
      const dayRoles: Record<string, number> = {};
      for (const n of dayNodes) {
        const matched = scoredAttractions.find(s => s.poi.name === n.name);
        if (matched?.poi.tourismRole) {
          dayRoles[matched.poi.tourismRole] = (dayRoles[matched.poi.tourismRole] || 0) + 1;
        }
      }
      
      // 选择角色匹配度最高的候选
      let bestCandidate = availableCandidates[0] || null;
      let bestFixScore = -Infinity;
      for (const c of availableCandidates) {
        const role = c.poi.tourismRole || 'FILLER';
        let roleBonus = 0;
        const roleIdx = preferredRoles.indexOf(role as TourismRole);
        if (roleIdx === 0) roleBonus = 0.5;
        else if (roleIdx > 0) roleBonus = 0.3 - roleIdx * 0.05;
        else if (role === 'FILLER') roleBonus = -0.3;
        
        // 角色重复惩罚
        const roleCount = dayRoles[role] || 0;
        const rolePenalty = role === 'FILLER' ? roleCount * 0.2 : roleCount * 0.3;
        
        const fixScore = c.score * slotWeight + roleBonus - rolePenalty;
        if (fixScore > bestFixScore) {
          bestFixScore = fixScore;
          bestCandidate = c;
        }
      }
      const availablePOI = bestCandidate;
      
      if (availablePOI) {
        usedPOIs.add(availablePOI.poi.name);
        
        // 创建新节点
        const newNode: TravelNode = {
          id: uuidv4(),
          itineraryId: '',
          name: availablePOI.poi.name,
          type: slotConfig.poiType,
          address: availablePOI.poi.address,
          description: availablePOI.poi.description || '',
          activity: `${this.getSlotLabel(slot)}：${availablePOI.poi.name}`,
          timeSlot: slot,
          estimatedDuration: slotConfig.duration,
          scheduledTime: slotConfig.time,
          dayIndex,
          order: 0, // 会在 reorderNodes 中重新分配
          verified: true,
          isLit: false,
          location: availablePOI.poi.location,
        };
        
        nodes.push(newNode);
        console.log(`[Pipeline] Added "${newNode.name}" for Day ${dayIndex} ${slot}`);
      } else {
        console.warn(`[Pipeline] No available POI for Day ${dayIndex} ${slot}, all ${candidates.length} candidates already used`);
      }
    }
    
    // 重新排序所有节点
    this.reorderNodes(nodes);
    
    return nodes;
  }

  /**
   * 获取时段配置
   */
  private getSlotConfig(slot: string): { time: string; duration: number; poiType: 'restaurant' | 'attraction' } | null {
    const configs: Record<string, { time: string; duration: number; poiType: 'restaurant' | 'attraction' }> = {
      breakfast: { time: '08:00', duration: 60, poiType: 'restaurant' },
      morning: { time: '09:30', duration: 120, poiType: 'attraction' },
      lunch: { time: '12:00', duration: 90, poiType: 'restaurant' },
      afternoon: { time: '14:00', duration: 180, poiType: 'attraction' },
      dinner: { time: '18:00', duration: 90, poiType: 'restaurant' },
      evening: { time: '20:00', duration: 90, poiType: 'attraction' },
    };
    return configs[slot] || null;
  }

  /**
   * 获取时段的角色偏好配置（用于 fixMissingSlots）
   */
  private getSlotRoleConfig(slot: string): { preferredRoles: TourismRole[]; roleWeight: number } | null {
    const configs: Record<string, { preferredRoles: TourismRole[]; roleWeight: number }> = {
      morning: { 
        preferredRoles: ['CORE_ATTRACTION', 'MAJOR_AREA', 'NATURE_RELAX'], 
        roleWeight: 2.5 
      },
      afternoon: { 
        preferredRoles: ['MAJOR_AREA', 'NATURE_RELAX', 'CORE_ATTRACTION', 'CULTURAL_SITE'], 
        roleWeight: 1.5 
      },
      evening: { 
        preferredRoles: ['NIGHT_EXPERIENCE', 'SHOPPING_AREA', 'VIEWPOINT'], 
        roleWeight: 0.5 
      },
    };
    return configs[slot] || null;
  }

  /**
   * 判断一个 POI 名称是否明显不是旅游景点（过滤公司、学校、机构等）
   * 注意：只过滤明显的非景点，宗祠/庙宇等可能有旅游价值的不在此过滤
   */
  private isValidAttractionName(name: string): boolean {
    // 排除公司/企业/机构类
    const companyPattern = /有限公司|集团公司|股份|工作室|事务所|咨询公司|代理|经营部|经销|批发|零售/;
    // 排除教育/培训类（包括大学、学院、职业技术学院等）
    const educationPattern = /教育科技|培训中心|培训学校|辅导|补习|托管中心|早教|驾校|职业技术学院|职业学院|技术学院|技工学校|技师学院|中学|小学|幼儿园|实训/;
    // 排除医疗/政府/办公/基础设施类
    const officePattern = /诊所|卫生站|社区服务中心|居委会|派出所|物业管理|停车场|加油站|充电站|变电站|污水处理|垃圾|环卫|回收站/;
    // 排除纯商业/生活服务类
    const servicePattern = /美容院|美发|理发店|足浴|洗车|维修|装修|搬家|快递|物流|中介/;

    return !companyPattern.test(name) && !educationPattern.test(name) 
      && !officePattern.test(name) && !servicePattern.test(name);
  }

  /**
   * Step 5: 验证锚点覆盖（硬约束）
   * 锚点未出现在最终行程中 = 行程不合法
   */
  private validateAnchorCoverage(anchors: AnchorPOI[], nodes: TravelNode[]): AnchorValidation {
    const nodeNames = new Set(nodes.map(n => n.name));
    const missingAnchors: AnchorPOI[] = [];
    const coveredDomains: ExperienceDomain[] = [];
    const missingDomains: ExperienceDomain[] = [];
    
    for (const anchor of anchors) {
      if (nodeNames.has(anchor.poi.name)) {
        coveredDomains.push(anchor.domain);
      } else {
        missingAnchors.push(anchor);
        missingDomains.push(anchor.domain);
      }
    }
    
    return {
      valid: missingAnchors.length === 0,
      missingAnchors,
      coveredDomains,
      missingDomains,
    };
  }

  /**
   * Step 4: 生成体验域配额（硬约束）
   * 
   * 这不是推荐，而是约束。
   * must_have 域必须在行程中被覆盖，否则行程不合法。
   * "覆盖" = 至少有 1 个该域的景点出现在某天的行程中。
   */
  private generateDomainQuotas(cityProfile: CityProfile, days: number): DomainQuota[] {
    const quotas: DomainQuota[] = [];
    
    for (const domain of cityProfile.mustHave) {
      const isNatureDomain = domain === 'NATURAL_LANDSCAPE' || domain === 'WATER_SCENERY';
      
      if (days <= 2) {
        // 极短行程：每个 must_have 至少出现 1 次（0.5 天 = 至少 1 个景点）
        quotas.push({ domain, minDays: 0.5 });
      } else if (days <= 4) {
        // 短行程：每个 must_have 至少占 1 天
        quotas.push({ domain, minDays: 1 });
      } else {
        // 长行程：自然类至少 1.5 天（鼓励深度体验），其他至少 1 天
        quotas.push({ domain, minDays: isNatureDomain ? 1.5 : 1 });
      }
    }
    
    return quotas;
  }

  /**
   * Step 6: 验证体验域配额
   * 检查最终行程中每个域的天占比是否满足配额
   */
  private validateDomainQuotas(
    quotas: DomainQuota[],
    anchors: AnchorPOI[],
    nodes: TravelNode[],
    scoredAttractions: ScoredPOI[]
  ): { valid: boolean; issues: string[]; missingDomainDetails: Array<{ domain: ExperienceDomain; deficit: number }> } {
    const issues: string[] = [];
    const missingDomainDetails: Array<{ domain: ExperienceDomain; deficit: number }> = [];
    
    // 统计每天的主导体验域
    const dayDomains = new Map<number, Map<ExperienceDomain, number>>();
    
    for (const node of nodes) {
      if (node.type !== 'attraction') continue;
      
      const matched = scoredAttractions.find(s => s.poi.name === node.name);
      const domain = matched?.poi.experienceDomain;
      if (!domain) continue;
      
      if (!dayDomains.has(node.dayIndex)) {
        dayDomains.set(node.dayIndex, new Map());
      }
      const domainMap = dayDomains.get(node.dayIndex)!;
      domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
    }
    
    // 计算每个域占了多少天（一天中该域景点数 >= 1 就算占了这天）
    const domainDayCounts = new Map<ExperienceDomain, number>();
    
    for (const [_day, domainMap] of dayDomains) {
      for (const [domain, count] of domainMap) {
        if (count >= 1) {
          domainDayCounts.set(domain, (domainDayCounts.get(domain) || 0) + 1);
        }
      }
    }
    
    // 检查配额
    for (const quota of quotas) {
      const actualDays = domainDayCounts.get(quota.domain) || 0;
      if (actualDays < quota.minDays) {
        issues.push(`${quota.domain}: 需要至少 ${quota.minDays} 天，实际 ${actualDays} 天`);
        missingDomainDetails.push({ domain: quota.domain, deficit: quota.minDays - actualDays });
      }
    }
    
    return { valid: issues.length === 0, issues, missingDomainDetails };
  }

  /**
   * 找到插入位置的 order
   */
  private findInsertOrder(dayNodes: TravelNode[], slot: string): number {
    const slotOrder = ['arrival', 'checkout', 'hotel', 'breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening', 'hotel', 'departure'];
    const targetIndex = slotOrder.indexOf(slot);
    
    for (const node of dayNodes) {
      const nodeIndex = slotOrder.indexOf(node.timeSlot || '');
      if (nodeIndex > targetIndex) {
        return node.order;
      }
    }
    
    return dayNodes.length > 0 ? Math.max(...dayNodes.map(n => n.order)) + 1 : 1;
  }

  /**
   * 重新排序所有节点
   */
  private reorderNodes(nodes: TravelNode[]): void {
    // 按天分组并排序
    const nodesByDay = new Map<number, TravelNode[]>();
    for (const node of nodes) {
      const dayNodes = nodesByDay.get(node.dayIndex) || [];
      dayNodes.push(node);
      nodesByDay.set(node.dayIndex, dayNodes);
    }
    
    const totalDays = Math.max(...nodes.map(n => n.dayIndex), 1);
    
    for (const [day, dayNodes] of nodesByDay.entries()) {
      const isLastDay = day === totalDays;
      
      // 分离：回酒店节点 vs 其他节点
      // 回酒店节点必须是当天最后一个（最后一天除外，最后一天以 departure 结尾）
      const hotelReturnNode = !isLastDay 
        ? dayNodes.find(n => n.timeSlot === 'hotel' && n.type === 'hotel')
        : null;
      const otherNodes = hotelReturnNode 
        ? dayNodes.filter(n => n !== hotelReturnNode)
        : dayNodes;
      
      // 按时间排序（主要依据），时间相同时按时段类型排序
      otherNodes.sort((a, b) => {
        const timeA = a.scheduledTime || '99:99';
        const timeB = b.scheduledTime || '99:99';
        if (timeA !== timeB) return timeA.localeCompare(timeB);
        
        // 时间相同时，按时段类型排序
        const slotOrder = ['arrival', 'checkout', 'checkin', 'breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening', 'hotel', 'departure'];
        const aIndex = slotOrder.indexOf(a.timeSlot || '');
        const bIndex = slotOrder.indexOf(b.timeSlot || '');
        return aIndex - bIndex;
      });
      
      // 回酒店节点放最后，并调整时间为最后一个活动结束之后
      const finalOrder = [...otherNodes];
      if (hotelReturnNode) {
        const lastActivity = otherNodes[otherNodes.length - 1];
        if (lastActivity?.scheduledTime) {
          const lastDuration = lastActivity.estimatedDuration || 60;
          hotelReturnNode.scheduledTime = this.addMinutes(lastActivity.scheduledTime, lastDuration);
        }
        finalOrder.push(hotelReturnNode);
      }
      
      // 重新分配 order
      finalOrder.forEach((node, index) => {
        node.order = index + 1;
      });
    }
  }
}

export const itineraryPipeline = new ItineraryPipeline();
