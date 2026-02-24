import { amapClient } from '../clients/amapClient';
import { EnrichedPOI } from './poiService';

/**
 * POI 聚类区域
 */
export interface POICluster {
  id: string;
  name: string;
  centroid: { lng: number; lat: number };
  pois: EnrichedPOI[];
  attractions: EnrichedPOI[];
  restaurants: EnrichedPOI[];
  hotels: EnrichedPOI[];
  avgInternalDistance: number;
  radius: number;
}

/**
 * 聚类结果
 */
export interface ClusterResult {
  clusters: POICluster[];
  distanceMatrix: number[][];
  dailyClusterAssignment: string[];
}

// ============================================================
// Union-Find（并查集）用于旅行时间图的连通分量发现
// ============================================================
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // 路径压缩
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
  }

  getGroups(): Map<number, number[]> {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }
    return groups;
  }
}

/**
 * POI 聚类服务
 * 
 * 使用 Travel-Time Graph Clustering 替代 KMeans：
 * - 两个 POI 属于同一天，不是看直线距离，而是看从 A 出发访问 B 再回酒店是否合理
 * - 构建可达性图：edge if travel_distance < threshold
 * - 用 Union-Find 做连通分量，得到"可一日游区域"
 * - 远离主城区的景点（如西樵山）会自动成为独立区域
 */
export class ClusterService {

  // 旅行时间阈值：直线距离 15km ≈ 实际路程 20-25km ≈ 40min 车程
  // 两个景点直线距离在此范围内，认为可以在同一天游览
  private static readonly TRAVEL_DISTANCE_THRESHOLD = 15; // km

  /**
   * 对 POI 进行旅行时间图聚类
   */
  clusterPOIs(
    attractions: EnrichedPOI[],
    restaurants: EnrichedPOI[],
    hotels: EnrichedPOI[],
    days: number,
    _maxClusterRadius: number = 8
  ): ClusterResult {
    const validAttractions = attractions.filter(a => a.location);
    const validRestaurants = restaurants.filter(r => r.location);
    const validHotels = hotels.filter(h => h.location);

    const allPOIs = [...validAttractions, ...validRestaurants, ...validHotels];

    if (allPOIs.length < 2) {
      return this.createSingleCluster(validAttractions, validRestaurants, validHotels, days);
    }

    console.log(`[Cluster] Travel-time graph clustering: ${allPOIs.length} POIs (${validAttractions.length} attr, ${validRestaurants.length} rest, ${validHotels.length} hotel), ${days} days`);

    // Step 1: 构建旅行时间可达性图 + Union-Find
    const clusters = this.travelTimeGraphClustering(allPOIs);

    console.log(`[Cluster] Found ${clusters.length} travel-time zones`);
    clusters.forEach(c => {
      console.log(`  ${c.name}: ${c.attractions.length} attr, ${c.restaurants.length} rest, ${c.hotels.length} hotel, radius=${c.radius}km`);
    });

    // Step 2: 如果区域太多，合并距离近的小区域
    const mergedClusters = this.mergeSmallClusters(clusters, days);

    console.log(`[Cluster] After merge: ${mergedClusters.length} zones`);

    // Step 2.5: 如果只有1个区域但行程 ≥4 天，拆分为多个子区域
    // 一个区域最多连续 2-3 天，≥4 天必须有至少 2 个区域
    let finalClusters = mergedClusters;
    if (finalClusters.length === 1 && days >= 4) {
      const targetZones = Math.min(Math.ceil(days / 3), 3); // 4-6天拆2个，7-9天拆3个
      console.log(`[Cluster] Single zone for ${days}-day trip, splitting into ${targetZones} sub-zones`);
      const subClusters = this.splitLargeCluster(finalClusters[0], targetZones);
      if (subClusters.length > 1) {
        finalClusters = subClusters;
      }
    }

    // Step 3: 计算距离矩阵
    const distanceMatrix = this.calculateClusterDistanceMatrix(finalClusters);

    // Step 4: 为每天分配区域
    const dailyClusterAssignment = this.assignClustersToDay(
      finalClusters,
      distanceMatrix,
      days
    );

    return {
      clusters: finalClusters,
      distanceMatrix,
      dailyClusterAssignment,
    };
  }

  /**
   * 旅行时间图聚类核心算法
   * 1. 以景点为主节点构建可达性图
   * 2. Union-Find 发现连通分量
   * 3. 将餐厅和酒店分配到最近的景点区域
   */
  private travelTimeGraphClustering(allPOIs: EnrichedPOI[]): POICluster[] {
    // 分离景点（主节点）和其他 POI
    const attractionPOIs = allPOIs.filter(p => p.type === 'attraction');
    const restaurantPOIs = allPOIs.filter(p => p.type === 'restaurant');
    const hotelPOIs = allPOIs.filter(p => p.type === 'hotel');

    // 如果景点太少，回退到全量聚类
    if (attractionPOIs.length < 2) {
      return this.fallbackSingleCluster(allPOIs);
    }

    // 构建景点间的可达性图 + Union-Find
    const uf = new UnionFind(attractionPOIs.length);
    const threshold = ClusterService.TRAVEL_DISTANCE_THRESHOLD;

    for (let i = 0; i < attractionPOIs.length; i++) {
      for (let j = i + 1; j < attractionPOIs.length; j++) {
        const dist = amapClient.calculateDistance(
          attractionPOIs[i].location!,
          attractionPOIs[j].location!
        );
        if (dist <= threshold) {
          uf.union(i, j);
        }
      }
    }

    // 获取连通分量
    const groups = uf.getGroups();

    // 构建 POICluster
    const clusters: POICluster[] = [];
    let clusterIndex = 0;

    for (const [, memberIndices] of groups) {
      clusterIndex++;
      const clusterAttractions = memberIndices.map(i => attractionPOIs[i]);

      // 计算质心
      const centroid = this.calculateCentroid(clusterAttractions);

      // 将餐厅分配到最近的区域（距离质心 <= threshold * 1.2）
      const clusterRestaurants = restaurantPOIs.filter(r => {
        const dist = amapClient.calculateDistance(r.location!, `${centroid.lng},${centroid.lat}`);
        return dist <= threshold * 1.2;
      });

      // 将酒店分配到最近的区域（距离质心 <= threshold * 1.5，酒店可以稍远）
      const clusterHotels = hotelPOIs.filter(h => {
        const dist = amapClient.calculateDistance(h.location!, `${centroid.lng},${centroid.lat}`);
        return dist <= threshold * 1.5;
      });

      const allClusterPOIs = [...clusterAttractions, ...clusterRestaurants, ...clusterHotels];

      clusters.push({
        id: `zone-${clusterIndex}`,
        name: this.generateClusterName(clusterAttractions, clusterIndex - 1),
        centroid,
        pois: allClusterPOIs,
        attractions: clusterAttractions,
        restaurants: clusterRestaurants,
        hotels: clusterHotels,
        avgInternalDistance: this.calculateAvgInternalDistance(clusterAttractions),
        radius: this.calculateClusterRadius(clusterAttractions, centroid),
      });
    }

    // 按景点数量降序排序
    clusters.sort((a, b) => b.attractions.length - a.attractions.length);

    // 重新编号
    clusters.forEach((c, i) => { c.id = `zone-${i + 1}`; });

    return clusters;
  }

  /**
   * 合并过小的区域
   * 如果区域只有1-2个景点且距离某个大区域较近，合并进去
   * 但如果是远离主城区的独立景点（如西樵山），保持独立
   */
  private mergeSmallClusters(clusters: POICluster[], days: number): POICluster[] {
    if (clusters.length <= 1) return clusters;

    // 最大允许的区域数 = min(days, clusters.length)
    // 但至少保留2个区域（如果原本就有多个）
    const maxZones = Math.min(days, clusters.length);

    // 如果区域数已经合理，不需要合并
    if (clusters.length <= maxZones) return clusters;

    // 按景点数量排序，大区域优先
    const sorted = [...clusters].sort((a, b) => b.attractions.length - a.attractions.length);

    // 贪心合并：将最小的区域合并到最近的大区域
    const merged = [...sorted];

    while (merged.length > maxZones) {
      // 找到最小的区域
      const smallestIdx = merged.length - 1;
      const smallest = merged[smallestIdx];

      // 找到距离最近的其他区域
      let nearestIdx = 0;
      let nearestDist = Infinity;

      for (let i = 0; i < merged.length - 1; i++) {
        const dist = this.euclideanDistance(smallest.centroid, merged[i].centroid);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }

      // 如果最近的区域也很远（> 2x threshold），说明这是个独立远郊区域，不合并
      if (nearestDist > ClusterService.TRAVEL_DISTANCE_THRESHOLD * 2) {
        console.log(`[Cluster] Keeping isolated zone "${smallest.name}" (${nearestDist.toFixed(1)}km from nearest)`);
        break;
      }

      // 合并
      console.log(`[Cluster] Merging "${smallest.name}" into "${merged[nearestIdx].name}" (dist=${nearestDist.toFixed(1)}km)`);
      const target = merged[nearestIdx];
      target.attractions.push(...smallest.attractions);
      target.restaurants.push(...smallest.restaurants);
      target.hotels.push(...smallest.hotels);
      target.pois.push(...smallest.pois);
      target.centroid = this.calculateCentroid(target.attractions);
      target.radius = this.calculateClusterRadius(target.attractions, target.centroid);
      target.avgInternalDistance = this.calculateAvgInternalDistance(target.attractions);

      merged.splice(smallestIdx, 1);
    }

    // 重新编号
    merged.forEach((c, i) => { c.id = `zone-${i + 1}`; });

    return merged;
  }

  /**
   * 为每天分配区域
   * 核心思路：
   * 1. 根据景点数量按比例分配天数
   * 2. 长途旅行确保远郊区域至少分配1天
   * 3. 按地理顺序排列，减少跨区域移动
   */
  private assignClustersToDay(
    clusters: POICluster[],
    distanceMatrix: number[][],
    days: number
  ): string[] {
    if (clusters.length === 0) return [];
    if (clusters.length === 1) {
      // 短行程（≤3天）单区域没问题
      if (days <= 3) {
        return Array(days).fill(clusters[0].id);
      }
      // ≥4天单区域：不合理，不应该走到这里（clusterPOIs 应该已经拆分了）
      // 兜底：均分天数
      console.warn(`[Cluster] Single cluster for ${days}-day trip, should have been split earlier`);
      return Array(days).fill(clusters[0].id);
    }

    const ATTRACTIONS_PER_DAY = 3.5;

    const clusterWeights = clusters.map((cluster, index) => ({
      index,
      cluster,
      attractionCount: cluster.attractions.length,
      suggestedDays: Math.max(
        1, // 每个区域至少1天
        Math.min(
          3, // 单个区域最多3天，哪怕景点没玩完也该换区了
          Math.ceil(cluster.attractions.length / ATTRACTIONS_PER_DAY)
        )
      ),
    }));

    // 按景点数量降序
    clusterWeights.sort((a, b) => b.attractionCount - a.attractionCount);

    console.log('[Cluster] Zone weights for day assignment:');
    clusterWeights.forEach(cw => {
      console.log(`  ${cw.cluster.name}: ${cw.attractionCount} attractions, suggested ${cw.suggestedDays} days`);
    });

    // 分配天数
    const totalSuggested = clusterWeights.reduce((sum, cw) => sum + cw.suggestedDays, 0);
    const clusterDays = new Map<number, number>();
    let remainingDays = days;

    // 按比例分配，但每个区域至少1天
    for (const cw of clusterWeights) {
      if (remainingDays <= 0) break;

      let allocated = Math.max(1, Math.round((cw.suggestedDays / totalSuggested) * days));
      allocated = Math.min(allocated, remainingDays);

      clusterDays.set(cw.index, allocated);
      remainingDays -= allocated;
    }

    // 剩余天数轮流分配给各区域（每个区域不超过3天上限）
    if (remainingDays > 0) {
      // 按景点数量降序轮流分配
      let idx = 0;
      while (remainingDays > 0) {
        const cw = clusterWeights[idx % clusterWeights.length];
        const current = clusterDays.get(cw.index) || 0;
        if (current < 3) { // 单区域上限3天
          clusterDays.set(cw.index, current + 1);
          remainingDays--;
        }
        idx++;
        // 防止死循环：如果所有区域都满了，强制分给第一个
        if (idx > clusterWeights.length * 3) {
          const topIdx = clusterWeights[0].index;
          clusterDays.set(topIdx, (clusterDays.get(topIdx) || 0) + remainingDays);
          remainingDays = 0;
        }
      }
    }

    console.log('[Cluster] Final day allocation:');
    clusterDays.forEach((allocDays, index) => {
      console.log(`  ${clusters[index].name}: ${allocDays} days`);
    });

    // 按地理顺序排列（贪心：从最大区域出发，每次选最近的）
    const orderedClusters: Array<{ index: number; days: number }> = [];
    const usedIndices = new Set<number>();

    let currentIndex = clusterWeights[0].index;

    while (orderedClusters.length < clusterDays.size) {
      const daysForCluster = clusterDays.get(currentIndex);
      if (daysForCluster && daysForCluster > 0 && !usedIndices.has(currentIndex)) {
        orderedClusters.push({ index: currentIndex, days: daysForCluster });
        usedIndices.add(currentIndex);
      }

      let nearestIndex = -1;
      let minDist = Infinity;

      clusterDays.forEach((_, idx) => {
        if (!usedIndices.has(idx) && distanceMatrix[currentIndex] && distanceMatrix[currentIndex][idx] !== undefined) {
          const dist = distanceMatrix[currentIndex][idx];
          if (dist < minDist) {
            minDist = dist;
            nearestIndex = idx;
          }
        }
      });

      if (nearestIndex === -1) break;
      currentIndex = nearestIndex;
    }

    // 生成每日分配
    const assignment: string[] = [];
    for (const { index, days: clusterDayCount } of orderedClusters) {
      for (let i = 0; i < clusterDayCount; i++) {
        assignment.push(clusters[index].id);
      }
    }

    while (assignment.length < days) {
      assignment.push(assignment[assignment.length - 1] || clusters[0].id);
    }

    console.log(`[Cluster] Daily assignment: ${assignment.join(' -> ')}`);
    return assignment.slice(0, days);
  }

  /**
   * 将一个大 cluster 按地理位置拆分为 targetCount 个子区域
   * 使用简单的二分法：沿最长轴（经度或纬度）排序后均分
   */
  private splitLargeCluster(cluster: POICluster, targetCount: number): POICluster[] {
    const attractions = cluster.attractions.filter(a => a.location);
    if (attractions.length < targetCount * 2) {
      // 景点太少，无法有效拆分
      console.log(`[Cluster] Cannot split "${cluster.name}": only ${attractions.length} attractions for ${targetCount} sub-zones`);
      return [cluster];
    }

    // 计算经纬度范围，沿最长轴排序
    const coords = attractions.map(a => {
      const [lng, lat] = a.location!.split(',').map(Number);
      return { poi: a, lng, lat };
    });

    const lngRange = Math.max(...coords.map(c => c.lng)) - Math.min(...coords.map(c => c.lng));
    const latRange = Math.max(...coords.map(c => c.lat)) - Math.min(...coords.map(c => c.lat));
    const sortByLng = lngRange >= latRange;

    coords.sort((a, b) => sortByLng ? a.lng - b.lng : a.lat - b.lat);

    // 均分景点到子区域
    const chunkSize = Math.ceil(coords.length / targetCount);
    const subClusters: POICluster[] = [];

    for (let i = 0; i < targetCount; i++) {
      const chunk = coords.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) continue;

      const subAttractions = chunk.map(c => c.poi);
      const centroid = this.calculateCentroid(subAttractions);

      // 将餐厅分配到最近的子区域
      const subRestaurants = cluster.restaurants.filter(r => {
        if (!r.location) return false;
        const dist = amapClient.calculateDistance(r.location, `${centroid.lng},${centroid.lat}`);
        return dist <= ClusterService.TRAVEL_DISTANCE_THRESHOLD;
      });

      // 将酒店分配到最近的子区域
      const subHotels = cluster.hotels.filter(h => {
        if (!h.location) return false;
        const dist = amapClient.calculateDistance(h.location, `${centroid.lng},${centroid.lat}`);
        return dist <= ClusterService.TRAVEL_DISTANCE_THRESHOLD * 1.2;
      });

      const allPOIs = [...subAttractions, ...subRestaurants, ...subHotels];

      subClusters.push({
        id: `zone-${i + 1}`,
        name: this.generateClusterName(subAttractions, i),
        centroid,
        pois: allPOIs,
        attractions: subAttractions,
        restaurants: subRestaurants,
        hotels: subHotels,
        avgInternalDistance: this.calculateAvgInternalDistance(subAttractions),
        radius: this.calculateClusterRadius(subAttractions, centroid),
      });
    }

    console.log(`[Cluster] Split "${cluster.name}" into ${subClusters.length} sub-zones:`);
    subClusters.forEach(sc => {
      console.log(`  ${sc.name}: ${sc.attractions.length} attr, ${sc.restaurants.length} rest, ${sc.hotels.length} hotel, radius=${sc.radius}km`);
    });

    return subClusters;
  }



  // ============================================================
  // 工具方法
  // ============================================================

  private calculateCentroid(pois: EnrichedPOI[]): { lng: number; lat: number } {
    let sumLng = 0, sumLat = 0, count = 0;
    for (const poi of pois) {
      if (poi.location) {
        const [lng, lat] = poi.location.split(',').map(Number);
        sumLng += lng;
        sumLat += lat;
        count++;
      }
    }
    return count > 0
      ? { lng: sumLng / count, lat: sumLat / count }
      : { lng: 0, lat: 0 };
  }

  private euclideanDistance(
    p1: { lng: number; lat: number },
    p2: { lng: number; lat: number }
  ): number {
    const dLng = (p1.lng - p2.lng) * 111 * Math.cos((p1.lat * Math.PI) / 180);
    const dLat = (p1.lat - p2.lat) * 111;
    return Math.sqrt(dLng * dLng + dLat * dLat);
  }

  private calculateClusterDistanceMatrix(clusters: POICluster[]): number[][] {
    const n = clusters.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = this.euclideanDistance(clusters[i].centroid, clusters[j].centroid);
        matrix[i][j] = dist;
        matrix[j][i] = dist;
      }
    }
    return matrix;
  }

  private calculateClusterRadius(
    pois: EnrichedPOI[],
    centroid: { lng: number; lat: number }
  ): number {
    if (pois.length === 0) return 0;
    let maxDist = 0;
    for (const poi of pois) {
      if (!poi.location) continue;
      const [lng, lat] = poi.location.split(',').map(Number);
      const dist = this.euclideanDistance({ lng, lat }, centroid);
      if (dist > maxDist) maxDist = dist;
    }
    return Math.round(maxDist * 10) / 10;
  }

  private calculateAvgInternalDistance(pois: EnrichedPOI[]): number {
    if (pois.length < 2) return 0;
    let totalDist = 0;
    let count = 0;
    for (let i = 0; i < pois.length; i++) {
      for (let j = i + 1; j < pois.length; j++) {
        if (pois[i].location && pois[j].location) {
          totalDist += amapClient.calculateDistance(pois[i].location!, pois[j].location!);
          count++;
        }
      }
    }
    return count > 0 ? Math.round((totalDist / count) * 10) / 10 : 0;
  }

  private generateClusterName(pois: EnrichedPOI[], index: number): string {
    if (pois.length === 0) return `区域${index + 1}`;

    // 尝试从地址中提取区名
    const districts = new Map<string, number>();
    for (const poi of pois) {
      if (poi.address) {
        const districtMatch = poi.address.match(/(.+?区)/);
        if (districtMatch) {
          const district = districtMatch[1];
          districts.set(district, (districts.get(district) || 0) + 1);
        }
      }
    }

    let maxCount = 0;
    let mainDistrict = '';
    districts.forEach((count, district) => {
      if (count > maxCount) {
        maxCount = count;
        mainDistrict = district;
      }
    });

    if (mainDistrict) return `${mainDistrict}区域`;

    // 如果只有1-2个景点，用景点名
    if (pois.length <= 2) {
      return pois.map(p => p.name).join('+');
    }

    return `${pois[0].name}周边`;
  }

  private fallbackSingleCluster(allPOIs: EnrichedPOI[]): POICluster[] {
    const centroid = this.calculateCentroid(allPOIs);
    return [{
      id: 'zone-1',
      name: '主城区',
      centroid,
      pois: allPOIs,
      attractions: allPOIs.filter(p => p.type === 'attraction'),
      restaurants: allPOIs.filter(p => p.type === 'restaurant'),
      hotels: allPOIs.filter(p => p.type === 'hotel'),
      avgInternalDistance: this.calculateAvgInternalDistance(allPOIs),
      radius: this.calculateClusterRadius(allPOIs, centroid),
    }];
  }

  private createSingleCluster(
    attractions: EnrichedPOI[],
    restaurants: EnrichedPOI[],
    hotels: EnrichedPOI[],
    days: number
  ): ClusterResult {
    const allPois = [...attractions, ...restaurants, ...hotels];
    const centroid = this.calculateCentroid(allPois);

    const cluster: POICluster = {
      id: 'zone-1',
      name: '主城区',
      centroid,
      pois: allPois,
      attractions,
      restaurants,
      hotels,
      avgInternalDistance: this.calculateAvgInternalDistance(allPois),
      radius: this.calculateClusterRadius(allPois, centroid),
    };

    return {
      clusters: [cluster],
      distanceMatrix: [[0]],
      dailyClusterAssignment: Array(days).fill('zone-1'),
    };
  }

  // ============================================================
  // 公共查询方法（保持接口兼容）
  // ============================================================

  getClusterPOIsForDay(
    clusterResult: ClusterResult,
    dayIndex: number
  ): { attractions: EnrichedPOI[]; restaurants: EnrichedPOI[]; hotels: EnrichedPOI[] } {
    const clusterId = clusterResult.dailyClusterAssignment[dayIndex - 1];
    const cluster = clusterResult.clusters.find(c => c.id === clusterId);

    if (!cluster) {
      return {
        attractions: clusterResult.clusters.flatMap(c => c.attractions),
        restaurants: clusterResult.clusters.flatMap(c => c.restaurants),
        hotels: clusterResult.clusters.flatMap(c => c.hotels),
      };
    }

    return {
      attractions: cluster.attractions,
      restaurants: cluster.restaurants,
      hotels: cluster.hotels,
    };
  }

  formatClustersForLLM(clusterResult: ClusterResult, days: number): string {
    const lines: string[] = [];

    lines.push('【区域划分说明（基于旅行时间可达性）】');
    lines.push(`根据景点间的实际旅行时间，已划分为 ${clusterResult.clusters.length} 个可一日游区域：`);
    lines.push('');

    clusterResult.clusters.forEach((cluster, i) => {
      lines.push(`区域${i + 1}：${cluster.name}`);
      lines.push(`  - 景点数量：${cluster.attractions.length}`);
      lines.push(`  - 餐厅数量：${cluster.restaurants.length}`);
      lines.push(`  - 酒店数量：${cluster.hotels.length}`);
      lines.push(`  - 区域半径：约${cluster.radius}km`);
      lines.push(`  - 主要景点：${cluster.attractions.slice(0, 3).map(a => a.name).join('、')}`);
      lines.push('');
    });

    lines.push('【每日区域分配】');
    for (let day = 1; day <= days; day++) {
      const clusterId = clusterResult.dailyClusterAssignment[day - 1];
      const cluster = clusterResult.clusters.find(c => c.id === clusterId);
      if (cluster) {
        lines.push(`第${day}天：${cluster.name}（${cluster.attractions.length}个景点可选）`);
      }
    }

    return lines.join('\n');
  }
}

export const clusterService = new ClusterService();
