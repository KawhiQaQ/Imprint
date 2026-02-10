import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database';
import { fileStorage } from '../storage/fileStorage';
import type Database from 'better-sqlite3';

// Type definitions based on design document
export interface Trip {
  id: string;
  userId: string;
  visionText: string;
  destination: string;
  status: 'planning' | 'traveling' | 'completed';
  isSavedToShelf: boolean;
  searchConditions?: SearchConditions;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchConditions {
  geographicFeatures: string[];
  climatePreference: string;
  foodPreferences: string[];
  activityTypes: string[];
  budgetLevel?: string;
  travelStyle?: string;
  startDate?: string; // 出发日期 YYYY-MM-DD
  totalDays?: number; // 旅行天数
  arrivalTime?: string; // 抵达时间 HH:MM
  departureTime?: string; // 离开时间 HH:MM（最后一天前往机场/火车站的时间）
}

export interface TravelNode {
  id: string;
  itineraryId: string;
  name: string;
  type: 'attraction' | 'restaurant' | 'hotel' | 'transport';
  address: string;
  description: string;
  estimatedDuration: number;
  scheduledTime: string;
  dayIndex: number;
  order: number;
  verified: boolean;
  verificationInfo?: string;
  isLit: boolean;
  timeSlot?: string; // 时段：arrival, breakfast, morning, lunch, afternoon, dinner, evening, hotel
  activity?: string; // 活动描述：如"游玩西湖景区"、"品尝杭帮菜"
  isStartingPoint?: boolean; // 是否是大型景区的起点位置
  scenicAreaName?: string; // 如果是起点，对应的景区名称
  // 扩展信息
  priceInfo?: string; // 价格信息：餐厅人均、酒店房价、景点门票价格
  ticketInfo?: string; // 门票/预约信息：如"需提前预约"、"免费"、"门票80元"
  tips?: string; // 小贴士：如"建议早去避开人流"、"周一闭馆"
  // 交通信息（到达此节点的交通方式）
  transportMode?: string; // 交通方式：walk, bus, subway, taxi, drive
  transportDuration?: number; // 交通时长（分钟）
  transportNote?: string; // 交通说明：如"步行约10分钟"、"地铁2号线3站"
  // 节点状态相关
  nodeStatus?: 'normal' | 'changed' | 'unrealized' | 'changed_original'; // 节点状态
  statusReason?: string; // 状态原因（变更理由或未实现原因）
  parentNodeId?: string; // 父节点ID（变更后的新节点指向原节点）
}

export interface Itinerary {
  id: string;
  tripId: string;
  destination: string;
  totalDays: number;
  startDate?: string; // 出发日期 YYYY-MM-DD
  nodes: TravelNode[];
  userPreferences: string[];
  lastUpdated: Date;
}

export interface PhotoMaterial {
  id: string;
  materialId: string;
  url: string;
  uploadTime: Date;
  visionAnalysis?: string;
}

export interface DiaryFragment {
  id: string;
  tripId: string;
  nodeId: string;
  content: string;
  timeRange: string;
  moodEmoji?: string;
  weather?: string;
  textNotes?: string[];
  generatedAt: Date;
  isEdited: boolean;
}


// Database row types for mapping
interface TripRow {
  id: string;
  user_id: string;
  vision_text: string;
  destination: string;
  status: string;
  is_saved_to_shelf: number;
  search_conditions: string | null;
  created_at: string;
  updated_at: string;
}

interface ItineraryRow {
  id: string;
  trip_id: string;
  destination: string;
  total_days: number;
  start_date: string | null;
  user_preferences: string | null;
  last_updated: string;
}

interface TravelNodeRow {
  id: string;
  itinerary_id: string;
  name: string;
  type: string;
  address: string;
  description: string;
  estimated_duration: number;
  scheduled_time: string;
  day_index: number;
  node_order: number;
  verified: number;
  verification_info: string | null;
  is_lit: number;
  time_slot: string | null;
  activity: string | null;
  is_starting_point: number | null;
  scenic_area_name: string | null;
  price_info: string | null;
  ticket_info: string | null;
  tips: string | null;
  transport_mode: string | null;
  transport_duration: number | null;
  transport_note: string | null;
  node_status: string | null;
  status_reason: string | null;
  parent_node_id: string | null;
}

interface DiaryFragmentRow {
  id: string;
  trip_id: string;
  node_id: string;
  content: string;
  time_range: string;
  mood_emoji: string | null;
  weather: string | null;
  text_notes: string | null;
  generated_at: string;
  is_edited: number;
}

export class StorageService {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  // ==================== User Operations ====================

  /**
   * Ensures a user exists in the database, creating one if necessary
   */
  async ensureUserExists(userId: string): Promise<void> {
    const checkStmt = this.db.prepare('SELECT id FROM users WHERE id = ?');
    const existing = checkStmt.get(userId);
    
    if (!existing) {
      const insertStmt = this.db.prepare(`
        INSERT INTO users (id, created_at) VALUES (?, ?)
      `);
      insertStmt.run(userId, new Date().toISOString());
    }
  }

  // ==================== Trip CRUD Operations ====================

  async createTrip(userId: string, visionText: string): Promise<Trip> {
    // Ensure user exists before creating trip (foreign key constraint)
    await this.ensureUserExists(userId);
    const id = uuidv4();
    const now = new Date();
    const nowStr = now.toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO trips (id, user_id, vision_text, destination, status, is_saved_to_shelf, created_at, updated_at)
      VALUES (?, ?, ?, '', 'planning', 0, ?, ?)
    `);

    stmt.run(id, userId, visionText, nowStr, nowStr);

    return {
      id,
      userId,
      visionText,
      destination: '',
      status: 'planning',
      isSavedToShelf: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getTrip(tripId: string): Promise<Trip | null> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, vision_text, destination, status, is_saved_to_shelf, search_conditions, created_at, updated_at
      FROM trips WHERE id = ?
    `);

    const row = stmt.get(tripId) as TripRow | undefined;
    if (!row) return null;

    return this.mapRowToTrip(row);
  }

  async updateTrip(tripId: string, updates: Partial<Trip>): Promise<Trip | null> {
    const existing = await this.getTrip(tripId);
    if (!existing) return null;

    const now = new Date();
    const updateFields: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [now.toISOString()];

    if (updates.destination !== undefined) {
      updateFields.push('destination = ?');
      values.push(updates.destination);
    }
    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.visionText !== undefined) {
      updateFields.push('vision_text = ?');
      values.push(updates.visionText);
    }
    if (updates.searchConditions !== undefined) {
      updateFields.push('search_conditions = ?');
      values.push(JSON.stringify(updates.searchConditions));
    }
    if (updates.isSavedToShelf !== undefined) {
      updateFields.push('is_saved_to_shelf = ?');
      values.push(updates.isSavedToShelf ? '1' : '0');
    }

    values.push(tripId);

    const stmt = this.db.prepare(`
      UPDATE trips SET ${updateFields.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);

    return this.getTrip(tripId);
  }

  async getUserTrips(userId: string): Promise<Trip[]> {
    const stmt = this.db.prepare(`
      SELECT id, user_id, vision_text, destination, status, is_saved_to_shelf, search_conditions, created_at, updated_at
      FROM trips WHERE user_id = ? ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId) as TripRow[];
    return rows.map((row) => this.mapRowToTrip(row));
  }

  async deleteTrip(tripId: string): Promise<void> {
    const transaction = this.db.transaction(() => {
      // Delete diary fragments first (has foreign key to travel_nodes)
      const deleteFragments = this.db.prepare('DELETE FROM diary_fragments WHERE trip_id = ?');
      deleteFragments.run(tripId);

      // Get itinerary to delete nodes
      const itineraryStmt = this.db.prepare('SELECT id FROM itineraries WHERE trip_id = ?');
      const itinerary = itineraryStmt.get(tripId) as { id: string } | undefined;

      if (itinerary) {
        // Get all node IDs for this itinerary
        const nodeIdsStmt = this.db.prepare('SELECT id FROM travel_nodes WHERE itinerary_id = ?');
        const nodeIds = nodeIdsStmt.all(itinerary.id) as { id: string }[];

        // Delete materials for each node
        for (const node of nodeIds) {
          // Get material IDs for this node
          const materialStmt = this.db.prepare('SELECT id FROM node_materials WHERE node_id = ?');
          const materials = materialStmt.all(node.id) as { id: string }[];

          for (const material of materials) {
            // Delete photos
            const deletePhotos = this.db.prepare('DELETE FROM photo_materials WHERE material_id = ?');
            deletePhotos.run(material.id);

            // Delete voice recordings
            const deleteVoice = this.db.prepare('DELETE FROM voice_recordings WHERE material_id = ?');
            deleteVoice.run(material.id);
          }

          // Delete node materials
          const deleteNodeMaterials = this.db.prepare('DELETE FROM node_materials WHERE node_id = ?');
          deleteNodeMaterials.run(node.id);
        }

        // Delete travel nodes
        const deleteNodes = this.db.prepare('DELETE FROM travel_nodes WHERE itinerary_id = ?');
        deleteNodes.run(itinerary.id);

        // Delete itinerary
        const deleteItinerary = this.db.prepare('DELETE FROM itineraries WHERE id = ?');
        deleteItinerary.run(itinerary.id);
      }

      // Delete memoirs
      const deleteMemoirs = this.db.prepare('DELETE FROM travel_memoirs WHERE trip_id = ?');
      deleteMemoirs.run(tripId);

      // Delete chat history
      const deleteChatHistory = this.db.prepare('DELETE FROM chat_history WHERE trip_id = ?');
      deleteChatHistory.run(tripId);

      // Delete trip
      const deleteTrip = this.db.prepare('DELETE FROM trips WHERE id = ?');
      deleteTrip.run(tripId);
    });

    transaction();
  }

  private mapRowToTrip(row: TripRow): Trip {
    return {
      id: row.id,
      userId: row.user_id,
      visionText: row.vision_text,
      destination: row.destination || '',
      status: row.status as Trip['status'],
      isSavedToShelf: row.is_saved_to_shelf === 1,
      searchConditions: row.search_conditions ? JSON.parse(row.search_conditions) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }


  // ==================== Itinerary Operations ====================

  async saveItinerary(itinerary: Itinerary): Promise<void> {
    const now = new Date().toISOString();

    console.log('saveItinerary - saving with startDate:', itinerary.startDate);

    // Use transaction for atomic operation
    const transaction = this.db.transaction(() => {
      // Upsert itinerary
      const upsertItinerary = this.db.prepare(`
        INSERT INTO itineraries (id, trip_id, destination, total_days, start_date, user_preferences, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          destination = excluded.destination,
          total_days = excluded.total_days,
          start_date = excluded.start_date,
          user_preferences = excluded.user_preferences,
          last_updated = excluded.last_updated
      `);

      upsertItinerary.run(
        itinerary.id,
        itinerary.tripId,
        itinerary.destination,
        itinerary.totalDays,
        itinerary.startDate || null,
        JSON.stringify(itinerary.userPreferences),
        now
      );

      // Delete existing nodes for this itinerary
      const deleteNodes = this.db.prepare(`
        DELETE FROM travel_nodes WHERE itinerary_id = ?
      `);
      deleteNodes.run(itinerary.id);

      // Insert all nodes
      const insertNode = this.db.prepare(`
        INSERT INTO travel_nodes (
          id, itinerary_id, name, type, address, description,
          estimated_duration, scheduled_time, day_index, node_order,
          verified, verification_info, is_lit, time_slot, activity,
          is_starting_point, scenic_area_name, price_info, ticket_info, tips,
          transport_mode, transport_duration, transport_note,
          node_status, status_reason, parent_node_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of itinerary.nodes) {
        insertNode.run(
          node.id,
          itinerary.id,
          node.name,
          node.type,
          node.address,
          node.description,
          node.estimatedDuration,
          node.scheduledTime,
          node.dayIndex,
          node.order,
          node.verified ? 1 : 0,
          node.verificationInfo || null,
          node.isLit ? 1 : 0,
          node.timeSlot || null,
          node.activity || null,
          node.isStartingPoint ? 1 : 0,
          node.scenicAreaName || null,
          node.priceInfo || null,
          node.ticketInfo || null,
          node.tips || null,
          node.transportMode || null,
          node.transportDuration || null,
          node.transportNote || null,
          node.nodeStatus || 'normal',
          node.statusReason || null,
          node.parentNodeId || null
        );
      }
    });

    transaction();
  }

  async getItinerary(tripId: string): Promise<Itinerary | null> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, destination, total_days, start_date, user_preferences, last_updated
      FROM itineraries WHERE trip_id = ?
    `);

    const row = stmt.get(tripId) as ItineraryRow | undefined;
    if (!row) {
      console.log('getItinerary - no itinerary found for tripId:', tripId);
      return null;
    }

    console.log('getItinerary - found itinerary:', { id: row.id, tripId: row.trip_id, totalDays: row.total_days, startDate: row.start_date });

    // Get all nodes for this itinerary
    const nodesStmt = this.db.prepare(`
      SELECT id, itinerary_id, name, type, address, description,
             estimated_duration, scheduled_time, day_index, node_order,
             verified, verification_info, is_lit, time_slot, activity,
             is_starting_point, scenic_area_name, price_info, ticket_info, tips,
             transport_mode, transport_duration, transport_note,
             node_status, status_reason, parent_node_id
      FROM travel_nodes WHERE itinerary_id = ?
      ORDER BY day_index, node_order
    `);

    const nodeRows = nodesStmt.all(row.id) as TravelNodeRow[];
    console.log('getItinerary - found nodes count:', nodeRows.length);

    return {
      id: row.id,
      tripId: row.trip_id,
      destination: row.destination,
      totalDays: row.total_days,
      startDate: row.start_date || undefined,
      userPreferences: row.user_preferences ? JSON.parse(row.user_preferences) : [],
      lastUpdated: new Date(row.last_updated),
      nodes: nodeRows.map((n) => this.mapRowToTravelNode(n)),
    };
  }

  private mapRowToTravelNode(row: TravelNodeRow): TravelNode {
    return {
      id: row.id,
      itineraryId: row.itinerary_id,
      name: row.name,
      type: row.type as TravelNode['type'],
      address: row.address,
      description: row.description,
      estimatedDuration: row.estimated_duration,
      scheduledTime: row.scheduled_time,
      dayIndex: row.day_index,
      order: row.node_order,
      verified: row.verified === 1,
      verificationInfo: row.verification_info || undefined,
      isLit: row.is_lit === 1,
      timeSlot: row.time_slot || undefined,
      activity: row.activity || undefined,
      isStartingPoint: row.is_starting_point === 1,
      scenicAreaName: row.scenic_area_name || undefined,
      priceInfo: row.price_info || undefined,
      ticketInfo: row.ticket_info || undefined,
      tips: row.tips || undefined,
      transportMode: row.transport_mode || undefined,
      transportDuration: row.transport_duration || undefined,
      transportNote: row.transport_note || undefined,
      nodeStatus: (row.node_status as TravelNode['nodeStatus']) || 'normal',
      statusReason: row.status_reason || undefined,
      parentNodeId: row.parent_node_id || undefined,
    };
  }


  // ==================== DiaryFragment Operations ====================

  async saveDiaryFragment(fragment: DiaryFragment): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO diary_fragments (id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        time_range = excluded.time_range,
        mood_emoji = excluded.mood_emoji,
        weather = excluded.weather,
        text_notes = excluded.text_notes,
        is_edited = excluded.is_edited
    `);

    stmt.run(
      fragment.id,
      fragment.tripId,
      fragment.nodeId,
      fragment.content,
      fragment.timeRange,
      fragment.moodEmoji || null,
      fragment.weather || null,
      fragment.textNotes ? JSON.stringify(fragment.textNotes) : null,
      fragment.generatedAt.toISOString(),
      fragment.isEdited ? 1 : 0
    );
  }

  async getDiaryFragments(tripId: string): Promise<DiaryFragment[]> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited
      FROM diary_fragments WHERE trip_id = ?
      ORDER BY generated_at ASC
    `);

    const rows = stmt.all(tripId) as DiaryFragmentRow[];
    return rows.map((row) => this.mapRowToDiaryFragment(row));
  }

  async getDiaryFragment(fragmentId: string): Promise<DiaryFragment | null> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited
      FROM diary_fragments WHERE id = ?
    `);

    const row = stmt.get(fragmentId) as DiaryFragmentRow | undefined;
    if (!row) return null;

    return this.mapRowToDiaryFragment(row);
  }

  async updateDiaryFragment(fragmentId: string, content: string): Promise<DiaryFragment | null> {
    const stmt = this.db.prepare(`
      UPDATE diary_fragments SET content = ?, is_edited = 1 WHERE id = ?
    `);

    const result = stmt.run(content, fragmentId);
    if (result.changes === 0) return null;

    return this.getDiaryFragment(fragmentId);
  }

  private mapRowToDiaryFragment(row: DiaryFragmentRow): DiaryFragment {
    return {
      id: row.id,
      tripId: row.trip_id,
      nodeId: row.node_id,
      content: row.content,
      timeRange: row.time_range,
      moodEmoji: row.mood_emoji || undefined,
      weather: row.weather || undefined,
      textNotes: row.text_notes ? JSON.parse(row.text_notes) : undefined,
      generatedAt: new Date(row.generated_at),
      isEdited: row.is_edited === 1,
    };
  }

  // ==================== File Storage Operations ====================

  async saveFile(file: Buffer, type: 'photo' | 'audio', extension?: string): Promise<string> {
    const ext = extension || (type === 'photo' ? 'jpg' : 'wav');
    return fileStorage.saveFile(file, type, ext);
  }

  async getFile(relativePath: string): Promise<Buffer> {
    return fileStorage.getFile(relativePath);
  }

  async deleteFile(relativePath: string): Promise<void> {
    return fileStorage.deleteFile(relativePath);
  }
}

// Export singleton instance
export const storageService = new StorageService();
