/**
 * 路径优化器 - 使用贪心近邻 + 2-opt 算法优化行程顺序
 * 
 * 核心思路：
 * - LLM 已经选好了每天的节点（景点、餐厅等）
 * - 本优化器负责：优化同类型节点的访问顺序，减少总距离和折返
 * 
 * 评分函数：
 * score = -距离 - 折返惩罚
 */

import { amapClient } from '../clients/amapClient';
import { TravelNode } from './storageService';

// 优化配置
export interface OptimizeConfig {
  maxIterations?: number;       // 2-opt 最大迭代次数
  backtrackPenalty?: number;    // 折返惩罚系数
}

const DEFAULT_CONFIG: Required<OptimizeConfig> = {
  maxIterations: 50,
  backtrackPenalty: 1.5,
};

export class RouteOptimizer {
  private config: Required<OptimizeConfig>;
  private distanceCache: Map<string, number> = new Map();

  constructor(config?: OptimizeConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 优化单日行程中景点的访问顺序
   * 保持餐厅在固定时段，只优化景点顺序
   * 特别考虑晚上活动到酒店的距离
   */
  optimizeDayRoute(
    nodes: TravelNode[],
    hotelLocation?: string
  ): TravelNode[] {
    if (nodes.length < 3) {
      return nodes;
    }

    // 分离固定节点和可优化节点
    const fixedSlots = ['arrival', 'breakfast', 'lunch', 'dinner', 'hotel', 'departure'];
    const fixedNodes: { node: TravelNode; index: number }[] = [];
    const optimizableNodes: TravelNode[] = [];

    nodes.forEach((node, index) => {
      if (fixedSlots.includes(node.timeSlot || '') || node.type === 'hotel' || node.type === 'transport') {
        fixedNodes.push({ node, index });
      } else {
        optimizableNodes.push(node);
      }
    });

    // 如果可优化节点少于2个，无需优化
    if (optimizableNodes.length < 2) {
      return nodes;
    }

    // 按时段分组可优化节点
    const morningNodes = optimizableNodes.filter(n => n.timeSlot === 'morning');
    const afternoonNodes = optimizableNodes.filter(n => n.timeSlot === 'afternoon');
    const eveningNodes = optimizableNodes.filter(n => n.timeSlot === 'evening');

    // 对每个时段内的节点进行路径优化
    const optimizedMorning = this.optimizeSegment(morningNodes, hotelLocation);
    const optimizedAfternoon = this.optimizeSegment(afternoonNodes);
    
    // 晚上活动特殊处理：优先选择离酒店近的
    let optimizedEvening = this.optimizeSegment(eveningNodes);
    if (hotelLocation && optimizedEvening.length > 0) {
      optimizedEvening = this.optimizeEveningForReturn(optimizedEvening, hotelLocation);
    }

    // 重建节点列表
    const result: TravelNode[] = [];
    let morningIdx = 0, afternoonIdx = 0, eveningIdx = 0;

    for (const node of nodes) {
      if (fixedSlots.includes(node.timeSlot || '') || node.type === 'hotel' || node.type === 'transport') {
        result.push(node);
      } else if (node.timeSlot === 'morning' && morningIdx < optimizedMorning.length) {
        result.push(optimizedMorning[morningIdx++]);
      } else if (node.timeSlot === 'afternoon' && afternoonIdx < optimizedAfternoon.length) {
        result.push(optimizedAfternoon[afternoonIdx++]);
      } else if (node.timeSlot === 'evening' && eveningIdx < optimizedEvening.length) {
        result.push(optimizedEvening[eveningIdx++]);
      } else {
        result.push(node);
      }
    }

    // 重新计算 order
    result.forEach((node, idx) => {
      node.order = idx + 1;
    });

    return result;
  }

  /**
   * 优化晚上活动顺序，确保最后一个离酒店最近
   */
  private optimizeEveningForReturn(
    eveningNodes: TravelNode[],
    hotelLocation: string
  ): TravelNode[] {
    if (eveningNodes.length <= 1) return eveningNodes;

    // 计算每个节点到酒店的距离
    const nodesWithDistance = eveningNodes.map(node => ({
      node,
      distanceToHotel: node.location 
        ? this.getDistance(node.location, hotelLocation)
        : Infinity
    }));

    // 按到酒店距离排序，最近的放最后
    nodesWithDistance.sort((a, b) => b.distanceToHotel - a.distanceToHotel);

    return nodesWithDistance.map(n => n.node);
  }

  /**
   * 优化一个时段内的节点顺序（贪心近邻 + 2-opt）
   */
  private optimizeSegment(
    nodes: TravelNode[],
    startLocation?: string
  ): TravelNode[] {
    if (nodes.length < 2) {
      return nodes;
    }

    // 1. 贪心近邻构建初始路径
    const ordered = this.greedyNearestNeighbor(nodes, startLocation);

    // 2. 2-opt 局部优化
    const optimized = this.twoOpt(ordered);

    return optimized;
  }

  /**
   * 贪心近邻算法：每次选择距离当前位置最近的未访问节点
   */
  private greedyNearestNeighbor(
    nodes: TravelNode[],
    startLocation?: string
  ): TravelNode[] {
    if (nodes.length <= 1) return [...nodes];

    const result: TravelNode[] = [];
    const remaining = [...nodes];
    let currentLocation = startLocation;

    // 如果没有起点，从第一个有坐标的节点开始
    if (!currentLocation) {
      const firstWithLocation = remaining.find(n => n.location);
      if (firstWithLocation) {
        result.push(firstWithLocation);
        remaining.splice(remaining.indexOf(firstWithLocation), 1);
        currentLocation = firstWithLocation.location;
      }
    }

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const node = remaining[i];
        if (node.location && currentLocation) {
          const dist = this.getDistance(currentLocation, node.location);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = i;
          }
        }
      }

      const nearest = remaining.splice(nearestIdx, 1)[0];
      result.push(nearest);
      if (nearest.location) {
        currentLocation = nearest.location;
      }
    }

    return result;
  }

  /**
   * 2-opt 局部搜索：通过交换边来减少总距离
   */
  private twoOpt(nodes: TravelNode[]): TravelNode[] {
    if (nodes.length < 3) return nodes;

    let improved = true;
    let iterations = 0;
    let best = [...nodes];
    let bestDistance = this.calculateTotalDistance(best);

    while (improved && iterations < this.config.maxIterations) {
      improved = false;
      iterations++;

      for (let i = 0; i < best.length - 1; i++) {
        for (let j = i + 2; j < best.length; j++) {
          // 尝试反转 i+1 到 j 之间的路径
          const newRoute = this.twoOptSwap(best, i, j);
          const newDistance = this.calculateTotalDistance(newRoute);

          if (newDistance < bestDistance) {
            best = newRoute;
            bestDistance = newDistance;
            improved = true;
          }
        }
      }
    }

    if (iterations > 1) {
      console.log(`2-opt: ${iterations} iterations, distance improved to ${bestDistance.toFixed(2)}km`);
    }

    return best;
  }

  /**
   * 2-opt 交换：反转 i+1 到 j 之间的路径
   */
  private twoOptSwap(route: TravelNode[], i: number, j: number): TravelNode[] {
    const newRoute = route.slice(0, i + 1);
    
    // 反转 i+1 到 j 的部分
    for (let k = j; k > i; k--) {
      newRoute.push(route[k]);
    }
    
    // 添加 j+1 之后的部分
    for (let k = j + 1; k < route.length; k++) {
      newRoute.push(route[k]);
    }

    return newRoute;
  }

  /**
   * 计算路径总距离
   */
  private calculateTotalDistance(nodes: TravelNode[]): number {
    let total = 0;

    for (let i = 0; i < nodes.length - 1; i++) {
      const from = nodes[i].location;
      const to = nodes[i + 1].location;
      if (from && to) {
        total += this.getDistance(from, to);
      }
    }

    return total;
  }

  /**
   * 检测并修复折返问题
   * 折返：A -> B -> C，其中 B 在 A 和 C 的反方向
   */
  detectAndFixBacktrack(nodes: TravelNode[]): TravelNode[] {
    if (nodes.length < 3) return nodes;

    const result = [...nodes];
    let hasBacktrack = true;
    let iterations = 0;

    while (hasBacktrack && iterations < 10) {
      hasBacktrack = false;
      iterations++;

      for (let i = 0; i < result.length - 2; i++) {
        const a = result[i];
        const b = result[i + 1];
        const c = result[i + 2];

        if (!a.location || !b.location || !c.location) continue;

        // 检查是否折返：AB + BC > AC * 1.5
        const ab = this.getDistance(a.location, b.location);
        const bc = this.getDistance(b.location, c.location);
        const ac = this.getDistance(a.location, c.location);

        if (ab + bc > ac * this.config.backtrackPenalty) {
          // 尝试交换 b 和 c
          const newAb = this.getDistance(a.location, c.location);
          const newBc = this.getDistance(c.location, b.location);

          if (newAb + newBc < ab + bc) {
            // 交换
            [result[i + 1], result[i + 2]] = [result[i + 2], result[i + 1]];
            hasBacktrack = true;
            console.log(`Fixed backtrack: swapped ${b.name} and ${c.name}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * 优化整个行程（多天）
   */
  optimizeFullItinerary(
    nodes: TravelNode[],
    hotelLocation?: string
  ): TravelNode[] {
    // 按天分组
    const dayGroups = new Map<number, TravelNode[]>();
    
    for (const node of nodes) {
      const day = node.dayIndex;
      if (!dayGroups.has(day)) {
        dayGroups.set(day, []);
      }
      dayGroups.get(day)!.push(node);
    }

    // 优化每天的路线
    const result: TravelNode[] = [];
    const sortedDays = Array.from(dayGroups.keys()).sort((a, b) => a - b);

    for (const day of sortedDays) {
      const dayNodes = dayGroups.get(day)!;
      const optimized = this.optimizeDayRoute(dayNodes, hotelLocation);
      result.push(...optimized);
    }

    // 重新编号
    result.forEach((node, idx) => {
      node.order = idx + 1;
    });

    return result;
  }

  /**
   * 获取两点间距离（使用缓存）
   */
  private getDistance(from: string, to: string): number {
    const key = `${from}-${to}`;
    if (this.distanceCache.has(key)) {
      return this.distanceCache.get(key)!;
    }

    const distance = amapClient.calculateDistance(from, to);
    this.distanceCache.set(key, distance);
    this.distanceCache.set(`${to}-${from}`, distance);
    return distance;
  }

  /**
   * 清除距离缓存
   */
  clearCache(): void {
    this.distanceCache.clear();
  }
}

export const routeOptimizer = new RouteOptimizer();
