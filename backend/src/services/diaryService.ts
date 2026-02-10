import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database';
import { fileStorage } from '../storage/fileStorage';
import { qwenVLClient } from '../clients/qwenVLClient';
import { deepseekClient } from '../clients/deepseekClient';
import { wanxClient } from '../clients/wanxClient';
import type Database from 'better-sqlite3';
import type { TravelNode, DiaryFragment } from './storageService';
import axios from 'axios';

// Re-export PhotoMaterial from storageService for consistency
export type { PhotoMaterial as DiaryPhotoMaterial } from './storageService';

// Type definitions for diary materials
export interface PhotoMaterialData {
  id: string;
  materialId: string;
  url: string;
  uploadTime: Date;
  visionAnalysis?: string;
}

export interface VoiceRecording {
  id: string;
  materialId: string;
  audioUrl: string;
  uploadTime: Date;
  transcription?: string;
}

export interface NodeMaterial {
  id: string;
  nodeId: string;
  moodEmoji?: string;
  photos: PhotoMaterialData[];
  voiceRecordings: VoiceRecording[];
  textNotes?: string[];
}

// Database row types
interface NodeMaterialRow {
  id: string;
  node_id: string;
  mood_emoji: string | null;
}

interface PhotoMaterialRow {
  id: string;
  material_id: string;
  url: string;
  upload_time: string;
  vision_analysis: string | null;
}

interface VoiceRecordingRow {
  id: string;
  material_id: string;
  audio_url: string;
  upload_time: string;
  transcription: string | null;
}

// ==================== AI 图像风格定义 ====================
type DiaryImageStyle = 'watercolor' | 'shinkai' | 'ghibli' | 'film' | 'inkwash';

interface DiaryImageStyleConfig {
  name: string;
  description: string;
  promptPrefix: string;
  promptSuffix: string;
  wanxStyle: string;
}

const DIARY_IMAGE_STYLES: Record<DiaryImageStyle, DiaryImageStyleConfig> = {
  // 风格 A：日式水彩（原有风格）
  watercolor: {
    name: '日式水彩',
    description: '柔和的水彩画风格，色调温暖，有手绘质感',
    promptPrefix: 'Japanese watercolor illustration style, soft pastel colors, dreamy atmosphere',
    promptSuffix: 'hand-painted texture, gentle color gradients, peaceful mood, artistic brushstrokes, delicate details',
    wanxStyle: '<watercolor>',
  },
  // 风格 B：新海诚式光影
  shinkai: {
    name: '新海诚光影',
    description: '极其细腻的光影，强调云层、光线，带有强烈的怀旧感',
    promptPrefix: 'Anime style background, Makoto Shinkai style, cinematic lighting, lens flare',
    promptSuffix: 'highly detailed clouds, nostalgic atmosphere, beautiful sky, golden hour lighting, atmospheric perspective, vibrant colors',
    wanxStyle: '<anime>',
  },
  // 风格 C：吉卜力风格
  ghibli: {
    name: '吉卜力田园',
    description: '宫崎骏动画风格，温馨的田园风光，充满生机',
    promptPrefix: 'Studio Ghibli style, anime background art, lush greenery, whimsical atmosphere',
    promptSuffix: 'pastoral scenery, fluffy clouds, warm sunlight, cozy feeling, hand-drawn animation style, vibrant nature',
    wanxStyle: '<anime>',
  },
  // 风格 D：胶片摄影
  film: {
    name: '复古胶片',
    description: '模拟胶片摄影的颗粒感，色彩温暖复古',
    promptPrefix: 'Analog film photography style, Kodak Portra 400, soft focus, dreamy atmosphere',
    promptSuffix: 'light leak effect, film grain texture, warm vintage colors, bokeh background, nostalgic mood, artistic composition',
    wanxStyle: '<photography>',
  },
  // 风格 E：水墨淡彩
  inkwash: {
    name: '水墨淡彩',
    description: '中国传统水墨画与淡彩结合，意境悠远',
    promptPrefix: 'Chinese ink wash painting style, traditional sumi-e with light color wash',
    promptSuffix: 'minimalist composition, elegant brushwork, misty atmosphere, zen aesthetic, subtle color accents, poetic mood',
    wanxStyle: '<watercolor>',
  },
};

export class DiaryService {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }

  // ==================== Material Upload Methods ====================

  /**
   * Upload a photo for a travel node
   * Requirements: 4.1, 4.2, 4.4
   */
  async uploadPhoto(
    nodeId: string,
    file: Buffer,
    mimeType: string
  ): Promise<PhotoMaterialData> {
    // Determine file extension from mime type
    const extensionMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const extension = extensionMap[mimeType] || 'jpg';

    // Save file to storage
    const fileUrl = await fileStorage.saveFile(file, 'photo', extension);

    // Ensure node material exists
    const materialId = await this.ensureNodeMaterial(nodeId);

    // Create photo material record with automatic timestamp
    const photoId = uuidv4();
    const uploadTime = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO photo_materials (id, material_id, url, upload_time, vision_analysis)
      VALUES (?, ?, ?, ?, NULL)
    `);

    stmt.run(photoId, materialId, fileUrl, uploadTime.toISOString());

    return {
      id: photoId,
      materialId,
      url: fileUrl,
      uploadTime,
      visionAnalysis: undefined,
    };
  }

  /**
   * Upload a voice recording for a travel node
   * Requirements: 4.1, 4.2, 4.3, 4.4
   */
  async uploadVoice(
    nodeId: string,
    file: Buffer,
    mimeType?: string
  ): Promise<VoiceRecording> {
    // Determine file extension from mime type
    const extensionMap: Record<string, string> = {
      'audio/wav': 'wav',
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/webm': 'webm',
    };
    const extension = extensionMap[mimeType || ''] || 'wav';

    // Save file to storage
    const fileUrl = await fileStorage.saveFile(file, 'audio', extension);

    // Ensure node material exists
    const materialId = await this.ensureNodeMaterial(nodeId);

    // Create voice recording record with automatic timestamp
    const voiceId = uuidv4();
    const uploadTime = new Date();

    const stmt = this.db.prepare(`
      INSERT INTO voice_recordings (id, material_id, audio_url, upload_time, transcription)
      VALUES (?, ?, ?, ?, NULL)
    `);

    stmt.run(voiceId, materialId, fileUrl, uploadTime.toISOString());

    return {
      id: voiceId,
      materialId,
      audioUrl: fileUrl,
      uploadTime,
      transcription: undefined,
    };
  }

  /**
   * Transcribe voice recording to text
   * Requirements: 4.3
   */
  async transcribeVoice(recording: VoiceRecording): Promise<string> {
    // For MVP, we'll use a simple placeholder implementation
    // In production, this would call a speech-to-text API like Whisper or Aliyun ASR
    
    // Simulate transcription - in real implementation, call speech-to-text API
    const transcription = await this.callSpeechToTextAPI(recording.audioUrl);

    // Update the recording with transcription
    const stmt = this.db.prepare(`
      UPDATE voice_recordings SET transcription = ? WHERE id = ?
    `);
    stmt.run(transcription, recording.id);

    return transcription;
  }

  /**
   * Placeholder for speech-to-text API call
   * In production, integrate with Aliyun ASR or OpenAI Whisper
   */
  private async callSpeechToTextAPI(audioUrl: string): Promise<string> {
    // For MVP, return a placeholder message
    // TODO: Integrate with actual speech-to-text service
    console.log(`Transcribing audio: ${audioUrl}`);
    return '语音转写功能待集成实际API';
  }

  // ==================== Helper Methods ====================

  /**
   * Ensure a node material record exists for the given node
   */
  private async ensureNodeMaterial(nodeId: string): Promise<string> {
    // Check if material already exists
    const existingStmt = this.db.prepare(`
      SELECT id FROM node_materials WHERE node_id = ?
    `);
    const existing = existingStmt.get(nodeId) as { id: string } | undefined;

    if (existing) {
      return existing.id;
    }

    // Create new node material
    const materialId = uuidv4();
    const insertStmt = this.db.prepare(`
      INSERT INTO node_materials (id, node_id, mood_emoji)
      VALUES (?, ?, NULL)
    `);
    insertStmt.run(materialId, nodeId);

    return materialId;
  }

  /**
   * Get all materials for a node
   */
  async getNodeMaterials(nodeId: string): Promise<NodeMaterial | null> {
    const materialStmt = this.db.prepare(`
      SELECT id, node_id, mood_emoji FROM node_materials WHERE node_id = ?
    `);
    const materialRow = materialStmt.get(nodeId) as NodeMaterialRow | undefined;

    console.log('[DiaryService] getNodeMaterials 查询:', { nodeId, found: !!materialRow, materialId: materialRow?.id });

    if (!materialRow) {
      return null;
    }

    // Get photos
    const photosStmt = this.db.prepare(`
      SELECT id, material_id, url, upload_time, vision_analysis
      FROM photo_materials WHERE material_id = ?
      ORDER BY upload_time ASC
    `);
    const photoRows = photosStmt.all(materialRow.id) as PhotoMaterialRow[];

    console.log('[DiaryService] getNodeMaterials 照片查询:', { 
      materialId: materialRow.id, 
      photosCount: photoRows.length,
      photos: photoRows.map(p => ({ id: p.id, url: p.url, visionAnalysis: p.vision_analysis }))
    });

    // Get voice recordings
    const voiceStmt = this.db.prepare(`
      SELECT id, material_id, audio_url, upload_time, transcription
      FROM voice_recordings WHERE material_id = ?
      ORDER BY upload_time ASC
    `);
    const voiceRows = voiceStmt.all(materialRow.id) as VoiceRecordingRow[];

    // 修复 URL 格式，确保有 /uploads/ 前缀
    const fixUrl = (url: string) => {
      if (!url) return url;
      if (url.startsWith('/uploads/')) return url;
      if (url.startsWith('http')) return url;
      return `/uploads/${url}`;
    };

    return {
      id: materialRow.id,
      nodeId: materialRow.node_id,
      moodEmoji: materialRow.mood_emoji || undefined,
      photos: photoRows.map((row) => ({
        id: row.id,
        materialId: row.material_id,
        url: fixUrl(row.url),
        uploadTime: new Date(row.upload_time),
        visionAnalysis: row.vision_analysis || undefined,
      })),
      voiceRecordings: voiceRows.map((row) => ({
        id: row.id,
        materialId: row.material_id,
        audioUrl: fixUrl(row.audio_url),
        uploadTime: new Date(row.upload_time),
        transcription: row.transcription || undefined,
      })),
    };
  }

  /**
   * Update mood emoji for a node
   */
  async updateMoodEmoji(nodeId: string, moodEmoji: string): Promise<void> {
    const materialId = await this.ensureNodeMaterial(nodeId);
    const stmt = this.db.prepare(`
      UPDATE node_materials SET mood_emoji = ? WHERE id = ?
    `);
    stmt.run(moodEmoji, materialId);
  }


  // ==================== Photo Analysis Methods ====================

  /**
   * Analyze photo content using Qwen-VL
   * Requirements: 5.1
   */
  async analyzePhoto(photo: PhotoMaterialData): Promise<string> {
    try {
      // 检查 URL 是否是公网可访问的（OSS URL）
      const photoUrl = photo.url;
      
      // 如果是本地路径（不是 http/https 开头），无法进行 AI 分析
      if (!photoUrl.startsWith('http://') && !photoUrl.startsWith('https://')) {
        console.log('[DiaryService] Photo is stored locally, skipping AI analysis:', { photoId: photo.id, url: photoUrl });
        return '';
      }
      
      console.log('[DiaryService] Analyzing photo:', { photoId: photo.id, url: photoUrl });
      
      // 使用公网 URL 进行分析
      const analysis = await qwenVLClient.analyzeImage(
        photoUrl,
        '请详细描述这张旅行照片的内容，包括场景、人物表情、天气、氛围等细节，用于生成旅行日记。'
      );

      console.log('[DiaryService] Photo analysis result:', { photoId: photo.id, analysisLength: analysis?.length || 0, analysis: analysis?.substring(0, 100) });

      // Update the photo record with analysis
      const stmt = this.db.prepare(`
        UPDATE photo_materials SET vision_analysis = ? WHERE id = ?
      `);
      stmt.run(analysis, photo.id);

      return analysis;
    } catch (error) {
      console.error('[DiaryService] Photo analysis failed:', { photoId: photo.id, error });
      // Return empty string on failure - will use fallback generation
      return '';
    }
  }

  // ==================== Diary Generation Methods ====================

  /**
   * Get previous node info for context continuity
   */
  async getPreviousNodeContext(node: TravelNode): Promise<{ node: TravelNode; diary?: DiaryFragment } | null> {
    // Get all nodes in the same itinerary, ordered by day_index and node_order
    const stmt = this.db.prepare(`
      SELECT id, itinerary_id, name, type, address, description,
             estimated_duration, scheduled_time, day_index, node_order,
             verified, verification_info, is_lit
      FROM travel_nodes 
      WHERE itinerary_id = ?
      ORDER BY day_index ASC, node_order ASC
    `);

    const rows = stmt.all(node.itineraryId) as Array<{
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
    }>;

    // Find current node index
    const currentIndex = rows.findIndex(r => r.id === node.id);
    if (currentIndex <= 0) {
      return null; // No previous node
    }

    const prevRow = rows[currentIndex - 1];
    const prevNode: TravelNode = {
      id: prevRow.id,
      itineraryId: prevRow.itinerary_id,
      name: prevRow.name,
      type: prevRow.type as TravelNode['type'],
      address: prevRow.address,
      description: prevRow.description,
      estimatedDuration: prevRow.estimated_duration,
      scheduledTime: prevRow.scheduled_time,
      dayIndex: prevRow.day_index,
      order: prevRow.node_order,
      verified: prevRow.verified === 1,
      verificationInfo: prevRow.verification_info || undefined,
      isLit: prevRow.is_lit === 1,
    };

    // Get previous node's diary fragment if it exists
    const diaryStmt = this.db.prepare(`
      SELECT id, trip_id, node_id, content, time_range, mood_emoji, generated_at, is_edited
      FROM diary_fragments WHERE node_id = ?
    `);
    const diaryRow = diaryStmt.get(prevNode.id) as {
      id: string;
      trip_id: string;
      node_id: string;
      content: string;
      time_range: string;
      mood_emoji: string | null;
      generated_at: string;
      is_edited: number;
    } | undefined;

    let prevDiary: DiaryFragment | undefined;
    if (diaryRow) {
      prevDiary = {
        id: diaryRow.id,
        tripId: diaryRow.trip_id,
        nodeId: diaryRow.node_id,
        content: diaryRow.content,
        timeRange: diaryRow.time_range,
        moodEmoji: diaryRow.mood_emoji || undefined,
        generatedAt: new Date(diaryRow.generated_at),
        isEdited: diaryRow.is_edited === 1,
      };
    }

    return { node: prevNode, diary: prevDiary };
  }

  /**
   * Get itinerary start date for a node
   */
  async getItineraryStartDate(node: TravelNode): Promise<string | undefined> {
    const stmt = this.db.prepare(`
      SELECT start_date FROM itineraries WHERE id = ?
    `);
    const row = stmt.get(node.itineraryId) as { start_date: string | null } | undefined;
    return row?.start_date || undefined;
  }

  /**
   * Calculate actual date from startDate and dayIndex
   */
  private calculateActualDate(startDate: string, dayIndex: number): string {
    const start = new Date(startDate);
    start.setDate(start.getDate() + dayIndex - 1);
    return start.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Generate diary fragment for a travel node
   * Requirements: 5.1, 5.2, 5.3, 5.6
   */
  async generateDiaryFragment(
    node: TravelNode,
    tripId: string,
    materials: NodeMaterial,
    weather?: string,
    userTimeRange?: string
  ): Promise<DiaryFragment> {
    // Get previous node context for continuity
    const prevContext = await this.getPreviousNodeContext(node);

    // Get itinerary start date for actual date calculation
    const startDate = await this.getItineraryStartDate(node);

    // Analyze photos if not already analyzed
    const photoAnalyses: string[] = [];
    for (const photo of materials.photos) {
      if (!photo.visionAnalysis) {
        const analysis = await this.analyzePhoto(photo);
        photoAnalyses.push(analysis);
      } else {
        photoAnalyses.push(photo.visionAnalysis);
      }
    }

    // Get voice transcriptions
    const voiceTranscripts: string[] = [];
    for (const voice of materials.voiceRecordings) {
      if (!voice.transcription) {
        const transcription = await this.transcribeVoice(voice);
        voiceTranscripts.push(transcription);
      } else {
        voiceTranscripts.push(voice.transcription);
      }
    }

    // Calculate time range with actual date if startDate is available
    let timeRange: string;
    if (userTimeRange) {
      timeRange = userTimeRange;
    } else if (startDate && node.dayIndex) {
      const actualDate = this.calculateActualDate(startDate, node.dayIndex);
      const scheduledTime = node.scheduledTime || '';
      timeRange = scheduledTime ? `${actualDate} ${scheduledTime}` : actualDate;
    } else {
      timeRange = this.generateTimeRange(materials);
    }

    // Generate diary content
    let content: string;
    
    // Check if we have photo analyses (Qwen-VL success)
    const hasPhotoAnalysis = photoAnalyses.some((a) => a && a.length > 0);
    
    if (hasPhotoAnalysis) {
      // Full generation with photo analysis
      content = await this.generateDiaryWithVision(
        node,
        photoAnalyses,
        voiceTranscripts,
        timeRange,
        materials.moodEmoji,
        materials.textNotes,
        weather,
        prevContext
      );
    } else {
      // Fallback generation without photo analysis (Requirement 5.6)
      content = await this.generateDiaryWithoutVision(
        node,
        voiceTranscripts,
        timeRange,
        materials.moodEmoji,
        materials.textNotes,
        weather,
        prevContext
      );
    }

    // Create diary fragment
    const fragmentId = uuidv4();
    const now = new Date();

    const fragment: DiaryFragment = {
      id: fragmentId,
      tripId,
      nodeId: node.id,
      content,
      timeRange,
      moodEmoji: materials.moodEmoji,
      weather,
      textNotes: materials.textNotes,
      generatedAt: now,
      isEdited: false,
    };

    // Save to database (including weather and text_notes)
    const stmt = this.db.prepare(`
      INSERT INTO diary_fragments (id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      fragment.generatedAt.toISOString()
    );

    // Mark node as lit
    const updateNodeStmt = this.db.prepare(`
      UPDATE travel_nodes SET is_lit = 1 WHERE id = ?
    `);
    updateNodeStmt.run(node.id);

    return fragment;
  }

  /**
   * Regenerate diary fragment for an already lit node with new materials
   * Requirements: 5.1, 5.2, 5.3, 5.6
   */
  async regenerateDiaryFragment(
    node: TravelNode,
    tripId: string,
    materials: NodeMaterial,
    weather?: string,
    userTimeRange?: string
  ): Promise<DiaryFragment> {
    // Get previous node context for continuity
    const prevContext = await this.getPreviousNodeContext(node);

    // Get itinerary start date for actual date calculation
    const startDate = await this.getItineraryStartDate(node);

    // Analyze photos if not already analyzed
    const photoAnalyses: string[] = [];
    for (const photo of materials.photos) {
      if (!photo.visionAnalysis) {
        const analysis = await this.analyzePhoto(photo);
        photoAnalyses.push(analysis);
      } else {
        photoAnalyses.push(photo.visionAnalysis);
      }
    }

    // Get voice transcriptions
    const voiceTranscripts: string[] = [];
    for (const voice of materials.voiceRecordings) {
      if (!voice.transcription) {
        const transcription = await this.transcribeVoice(voice);
        voiceTranscripts.push(transcription);
      } else {
        voiceTranscripts.push(voice.transcription);
      }
    }

    // Calculate time range with actual date if startDate is available
    let timeRange: string;
    if (userTimeRange) {
      timeRange = userTimeRange;
    } else if (startDate && node.dayIndex) {
      const actualDate = this.calculateActualDate(startDate, node.dayIndex);
      const scheduledTime = node.scheduledTime || '';
      timeRange = scheduledTime ? `${actualDate} ${scheduledTime}` : actualDate;
    } else {
      timeRange = this.generateTimeRange(materials);
    }

    // Generate diary content
    let content: string;
    
    // Check if we have photo analyses (Qwen-VL success)
    const hasPhotoAnalysis = photoAnalyses.some((a) => a && a.length > 0);
    
    if (hasPhotoAnalysis) {
      // Full generation with photo analysis
      content = await this.generateDiaryWithVision(
        node,
        photoAnalyses,
        voiceTranscripts,
        timeRange,
        materials.moodEmoji,
        materials.textNotes,
        weather,
        prevContext
      );
    } else {
      // Fallback generation without photo analysis (Requirement 5.6)
      content = await this.generateDiaryWithoutVision(
        node,
        voiceTranscripts,
        timeRange,
        materials.moodEmoji,
        materials.textNotes,
        weather,
        prevContext
      );
    }

    // Check if fragment already exists for this node
    const existingFragmentStmt = this.db.prepare(`
      SELECT id FROM diary_fragments WHERE node_id = ?
    `);
    const existingFragment = existingFragmentStmt.get(node.id) as { id: string } | undefined;

    const now = new Date();
    let fragment: DiaryFragment;

    if (existingFragment) {
      // Update existing fragment (including weather and text_notes)
      const updateStmt = this.db.prepare(`
        UPDATE diary_fragments 
        SET content = ?, time_range = ?, mood_emoji = ?, weather = ?, text_notes = ?, generated_at = ?, is_edited = 0
        WHERE id = ?
      `);
      updateStmt.run(
        content,
        timeRange,
        materials.moodEmoji || null,
        weather || null,
        materials.textNotes ? JSON.stringify(materials.textNotes) : null,
        now.toISOString(),
        existingFragment.id
      );

      fragment = {
        id: existingFragment.id,
        tripId,
        nodeId: node.id,
        content,
        timeRange,
        moodEmoji: materials.moodEmoji,
        weather,
        textNotes: materials.textNotes,
        generatedAt: now,
        isEdited: false,
      };
    } else {
      // Create new fragment (including weather and text_notes)
      const fragmentId = uuidv4();
      const insertStmt = this.db.prepare(`
        INSERT INTO diary_fragments (id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      insertStmt.run(
        fragmentId,
        tripId,
        node.id,
        content,
        timeRange,
        materials.moodEmoji || null,
        weather || null,
        materials.textNotes ? JSON.stringify(materials.textNotes) : null,
        now.toISOString()
      );

      fragment = {
        id: fragmentId,
        tripId,
        nodeId: node.id,
        content,
        timeRange,
        moodEmoji: materials.moodEmoji,
        weather,
        textNotes: materials.textNotes,
        generatedAt: now,
        isEdited: false,
      };
    }

    return fragment;
  }

  /**
   * Generate diary content with photo analysis (full generation)
   */
  private async generateDiaryWithVision(
    node: TravelNode,
    photoAnalyses: string[],
    voiceTranscripts: string[],
    timeRange: string,
    moodEmoji?: string,
    textNotes?: string[],
    weather?: string,
    prevContext?: { node: TravelNode; diary?: DiaryFragment } | null
  ): Promise<string> {
    const prompt = this.buildDiaryPrompt(
      node,
      photoAnalyses,
      voiceTranscripts,
      timeRange,
      moodEmoji,
      true,
      textNotes,
      weather,
      prevContext
    );

    try {
      const content = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行日记的作家。请根据提供的信息，用第一人称写一段约200-300字的旅行日记片段。文字要生动、有画面感，体现当时的心情和感受。重要：直接以散文形式开始写作，不要使用任何markdown格式（如**加粗**），不要在开头写日期、星期、天气等标题行，这些信息会在界面上单独显示。特别注意：如果提供了"行程目的"，必须围绕该目的来写日记内容，不要写与行程目的相矛盾的内容。如果提供了上一站的信息，请让内容与上一站自然衔接。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return this.trimToLength(content, 150, 350);
    } catch (error) {
      console.error('Diary generation with vision failed:', error);
      return this.generateFallbackDiary(node, timeRange, moodEmoji, weather);
    }
  }

  /**
   * Generate diary content without photo analysis (fallback)
   * Requirements: 5.6
   */
  private async generateDiaryWithoutVision(
    node: TravelNode,
    voiceTranscripts: string[],
    timeRange: string,
    moodEmoji?: string,
    textNotes?: string[],
    weather?: string,
    prevContext?: { node: TravelNode; diary?: DiaryFragment } | null
  ): Promise<string> {
    const prompt = this.buildDiaryPrompt(
      node,
      [],
      voiceTranscripts,
      timeRange,
      moodEmoji,
      false,
      textNotes,
      weather,
      prevContext
    );

    try {
      const content = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行日记的作家。请根据提供的信息，用第一人称写一段约200-300字的旅行日记片段。文字要生动、有画面感，体现当时的心情和感受。重要：直接以散文形式开始写作，不要使用任何markdown格式（如**加粗**），不要在开头写日期、星期、天气等标题行，这些信息会在界面上单独显示。由于没有照片描述，请根据地点信息和语音记录来想象场景。特别注意：如果提供了"行程目的"，必须围绕该目的来写日记内容，不要写与行程目的相矛盾的内容。如果提供了上一站的信息，请让内容与上一站自然衔接。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return this.trimToLength(content, 150, 350);
    } catch (error) {
      console.error('Diary generation without vision failed:', error);
      return this.generateFallbackDiary(node, timeRange, moodEmoji, weather);
    }
  }

  /**
   * Build the prompt for diary generation
   */
  private buildDiaryPrompt(
    node: TravelNode,
    photoAnalyses: string[],
    voiceTranscripts: string[],
    timeRange: string,
    moodEmoji?: string,
    hasVision: boolean = true,
    textNotes?: string[],
    weather?: string,
    prevContext?: { node: TravelNode; diary?: DiaryFragment } | null
  ): string {
    let prompt = `请为以下旅行节点生成一段约200-300字的日记片段：

地点：${node.name}
地址：${node.address}
类型：${this.getNodeTypeLabel(node.type)}
时间：${timeRange}
`;

    if (node.description) {
      prompt += `行程目的：${node.description}\n`;
    }

    if (weather) {
      prompt += `天气：${this.getWeatherLabel(weather)}\n`;
    }

    if (moodEmoji) {
      prompt += `心情：${moodEmoji}\n`;
    }

    // Add previous node context for continuity
    if (prevContext) {
      prompt += `\n【上一站信息（用于内容衔接）】\n`;
      prompt += `上一站地点：${prevContext.node.name}\n`;
      if (prevContext.node.description) {
        prompt += `上一站目的：${prevContext.node.description}\n`;
      }
      if (prevContext.diary) {
        prompt += `上一站日记：${prevContext.diary.content}\n`;
      }
    }

    if (hasVision && photoAnalyses.length > 0) {
      const validAnalyses = photoAnalyses.filter((a) => a && a.length > 0);
      if (validAnalyses.length > 0) {
        prompt += `\n照片内容描述：\n`;
        validAnalyses.forEach((analysis, index) => {
          prompt += `${index + 1}. ${analysis}\n`;
        });
      }
    }

    if (voiceTranscripts.length > 0) {
      const validTranscripts = voiceTranscripts.filter((t) => t && t.length > 0);
      if (validTranscripts.length > 0) {
        prompt += `\n语音记录：\n`;
        validTranscripts.forEach((transcript, index) => {
          prompt += `${index + 1}. ${transcript}\n`;
        });
      }
    }

    if (textNotes && textNotes.length > 0) {
      const validNotes = textNotes.filter((n) => n && n.length > 0);
      if (validNotes.length > 0) {
        prompt += `\n文字记录：\n`;
        validNotes.forEach((note, index) => {
          prompt += `${index + 1}. ${note}\n`;
        });
      }
    }

    prompt += `\n请用第一人称写一段生动的日记，约200-300字。直接以散文形式开始写作，不要使用markdown格式，不要在开头写日期/星期/天气等标题行。体现当时的心情和感受，内容要丰富，可以描写环境细节、个人感悟、与同行者的互动等。`;

    return prompt;
  }

  /**
   * Get weather label from emoji
   */
  private getWeatherLabel(weatherEmoji: string): string {
    const weatherMap: Record<string, string> = {
      '☀️': '晴天',
      '⛅': '多云',
      '☁️': '阴天',
      '🌧️': '小雨',
      '⛈️': '雷雨',
      '🌨️': '小雪',
      '❄️': '大雪',
      '🌫️': '雾霾',
      '🌬️': '大风',
      '🌈': '彩虹',
    };
    return weatherMap[weatherEmoji] || weatherEmoji;
  }

  /**
   * Generate fallback diary when AI fails
   */
  private generateFallbackDiary(
    node: TravelNode,
    timeRange: string,
    moodEmoji?: string,
    weather?: string
  ): string {
    const moodText = moodEmoji ? `心情${moodEmoji}` : '心情不错';
    const weatherText = weather ? `天气${this.getWeatherLabel(weather)}，` : '';
    return `${timeRange}，${weatherText}我来到了${node.name}。${node.description || '这里的风景很美'}，${moodText}。这是一段值得记录的旅程。`;
  }

  /**
   * Get Chinese label for node type
   */
  private getNodeTypeLabel(type: TravelNode['type']): string {
    const labels: Record<TravelNode['type'], string> = {
      attraction: '景点',
      restaurant: '餐厅',
      hotel: '酒店',
      transport: '交通',
    };
    return labels[type] || '地点';
  }

  /**
   * Generate time range description from materials
   */
  private generateTimeRange(materials: NodeMaterial): string {
    const allTimes: Date[] = [
      ...materials.photos.map((p) => p.uploadTime),
      ...materials.voiceRecordings.map((v) => v.uploadTime),
    ];

    if (allTimes.length === 0) {
      return new Date().toLocaleString('zh-CN', {
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    allTimes.sort((a, b) => a.getTime() - b.getTime());
    const earliest = allTimes[0];
    const latest = allTimes[allTimes.length - 1];

    const formatTime = (date: Date) =>
      date.toLocaleString('zh-CN', {
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

    if (earliest.getTime() === latest.getTime()) {
      return formatTime(earliest);
    }

    // If same day, show time range
    if (earliest.toDateString() === latest.toDateString()) {
      const dateStr = earliest.toLocaleString('zh-CN', {
        month: 'long',
        day: 'numeric',
      });
      const startTime = earliest.toLocaleString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const endTime = latest.toLocaleString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${dateStr} ${startTime} - ${endTime}`;
    }

    return `${formatTime(earliest)} - ${formatTime(latest)}`;
  }

  /**
   * Trim content to target length (80-150 Chinese characters)
   * Requirements: 5.3
   */
  private trimToLength(content: string, minLength: number, maxLength: number): string {
    // Remove extra whitespace
    content = content.trim().replace(/\s+/g, ' ');

    if (content.length <= maxLength) {
      // 确保以完整标点结尾
      return this.ensureProperEnding(content);
    }

    // Find a good breaking point - prefer sentence-ending punctuation
    const truncated = content.substring(0, maxLength);
    
    // 优先找句子结束标点（句号、感叹号、问号）
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('。'),
      truncated.lastIndexOf('！'),
      truncated.lastIndexOf('？')
    );

    if (lastSentenceEnd > minLength) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    // 如果没有句子结束标点，找逗号位置，但要确保内容完整
    const lastComma = truncated.lastIndexOf('，');
    if (lastComma > minLength) {
      // 在逗号处截断，并用句号结尾表示完整
      return truncated.substring(0, lastComma) + '。';
    }

    // 最后手段：直接截断并加句号
    return truncated + '。';
  }

  /**
   * 确保内容以完整标点结尾
   */
  private ensureProperEnding(content: string): string {
    if (!content) return content;
    
    const lastChar = content[content.length - 1];
    const properEndings = ['。', '！', '？', '"', '』', '）'];
    
    if (properEndings.includes(lastChar)) {
      return content;
    }
    
    // 如果以逗号结尾，替换为句号
    if (lastChar === '，' || lastChar === ',') {
      return content.slice(0, -1) + '。';
    }
    
    // 如果以其他字符结尾，添加句号
    return content + '。';
  }

  // ==================== Fragment Update Methods ====================

  /**
   * Update diary fragment content and mood emoji
   * Requirements: 5.4, 5.5
   */
  async updateFragment(fragmentId: string, content: string, moodEmoji?: string): Promise<DiaryFragment | null> {
    let stmt;
    
    if (moodEmoji !== undefined) {
      stmt = this.db.prepare(`
        UPDATE diary_fragments SET content = ?, mood_emoji = ?, is_edited = 1 WHERE id = ?
      `);
      const result = stmt.run(content, moodEmoji, fragmentId);
      if (result.changes === 0) {
        return null;
      }
    } else {
      stmt = this.db.prepare(`
        UPDATE diary_fragments SET content = ?, is_edited = 1 WHERE id = ?
      `);
      const result = stmt.run(content, fragmentId);
      if (result.changes === 0) {
        return null;
      }
    }

    return this.getDiaryFragment(fragmentId);
  }

  /**
   * Get a single diary fragment
   */
  async getDiaryFragment(fragmentId: string): Promise<DiaryFragment | null> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited
      FROM diary_fragments WHERE id = ?
    `);

    const row = stmt.get(fragmentId) as {
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
    } | undefined;

    if (!row) {
      return null;
    }

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

  /**
   * Get all diary fragments for a trip
   */
  async getDiaryFragments(tripId: string): Promise<DiaryFragment[]> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited
      FROM diary_fragments WHERE trip_id = ?
      ORDER BY generated_at ASC
    `);

    const rows = stmt.all(tripId) as Array<{
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
    }>;

    return rows.map((row) => ({
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
    }));
  }

  /**
   * Get travel node by ID
   */
  async getTravelNode(nodeId: string): Promise<TravelNode | null> {
    const stmt = this.db.prepare(`
      SELECT id, itinerary_id, name, type, address, description,
             estimated_duration, scheduled_time, day_index, node_order,
             verified, verification_info, is_lit, time_slot, activity,
             node_status, status_reason, parent_node_id
      FROM travel_nodes WHERE id = ?
    `);

    const row = stmt.get(nodeId) as {
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
      node_status: string | null;
      status_reason: string | null;
      parent_node_id: string | null;
    } | undefined;

    if (!row) {
      return null;
    }

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
      nodeStatus: (row.node_status as TravelNode['nodeStatus']) || 'normal',
      statusReason: row.status_reason || undefined,
      parentNodeId: row.parent_node_id || undefined,
    };
  }

  /**
   * Get trip ID from node ID
   */
  async getTripIdFromNode(nodeId: string): Promise<string | null> {
    const stmt = this.db.prepare(`
      SELECT t.id as trip_id
      FROM travel_nodes tn
      JOIN itineraries i ON tn.itinerary_id = i.id
      JOIN trips t ON i.trip_id = t.id
      WHERE tn.id = ?
    `);

    const row = stmt.get(nodeId) as { trip_id: string } | undefined;
    return row?.trip_id || null;
  }

  /**
   * Change itinerary - mark original node as changed and create a new node
   * 变更行程：将原节点标记为已变更，并创建一个新的变更节点
   */
  async changeItinerary(
    nodeId: string,
    newDestination: string,
    changeReason: string,
    tripId: string
  ): Promise<{ originalNode: TravelNode; newNode: TravelNode; newNodeDescription: string }> {
    const originalNode = await this.getTravelNode(nodeId);
    if (!originalNode) {
      throw new Error('节点不存在');
    }

    // Mark original node as changed_original
    const updateStmt = this.db.prepare(`
      UPDATE travel_nodes 
      SET node_status = 'changed_original', status_reason = ?, is_lit = 1
      WHERE id = ?
    `);
    updateStmt.run(changeReason, nodeId);

    // Generate new node description using AI
    const newNodeDescription = await this.generateChangedNodeDescription(
      originalNode,
      newDestination,
      changeReason
    );

    // Create new node with changed status
    const newNodeId = uuidv4();
    const insertStmt = this.db.prepare(`
      INSERT INTO travel_nodes (
        id, itinerary_id, name, type, address, description,
        estimated_duration, scheduled_time, day_index, node_order,
        verified, verification_info, is_lit, time_slot, activity,
        node_status, status_reason, parent_node_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      newNodeId,
      originalNode.itineraryId,
      newDestination,
      originalNode.type,
      '', // Address will be filled by AI or user
      newNodeDescription,
      originalNode.estimatedDuration,
      originalNode.scheduledTime,
      originalNode.dayIndex,
      originalNode.order + 0.5, // Insert after original node
      0, // Not verified
      null,
      0, // Not lit yet
      originalNode.timeSlot || null,
      `变更：${newDestination}`,
      'changed',
      changeReason,
      nodeId
    );

    // Get the updated original node
    const updatedOriginalNode = await this.getTravelNode(nodeId);
    
    // Get the new node
    const newNode = await this.getTravelNode(newNodeId);

    return {
      originalNode: updatedOriginalNode!,
      newNode: newNode!,
      newNodeDescription,
    };
  }

  /**
   * Generate description for changed node using AI
   */
  private async generateChangedNodeDescription(
    originalNode: TravelNode,
    newDestination: string,
    changeReason: string
  ): Promise<string> {
    try {
      const prompt = `原计划是去"${originalNode.name}"（${originalNode.description || '无描述'}），
但由于"${changeReason}"，现在改为去"${newDestination}"。

请为新目的地"${newDestination}"生成一段简短的介绍（50字以内），说明这个地方的特色和推荐理由。`;

      const content = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一个旅行顾问，请为用户生成简短的目的地介绍。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.7);

      return content.trim();
    } catch (error) {
      console.error('Failed to generate changed node description:', error);
      return `变更目的地：${newDestination}`;
    }
  }

  /**
   * Mark node as unrealized and generate diary fragment
   * 标记节点为未实现，并生成相应的日记片段
   */
  async markAsUnrealized(
    nodeId: string,
    reason: string,
    tripId: string,
    moodEmoji?: string,
    weather?: string
  ): Promise<{ node: TravelNode; fragment: DiaryFragment }> {
    const node = await this.getTravelNode(nodeId);
    if (!node) {
      throw new Error('节点不存在');
    }

    // Update node status to unrealized
    const updateStmt = this.db.prepare(`
      UPDATE travel_nodes 
      SET node_status = 'unrealized', status_reason = ?, is_lit = 1
      WHERE id = ?
    `);
    updateStmt.run(reason, nodeId);

    // Get previous node context
    const prevContext = await this.getPreviousNodeContext(node);

    // Get itinerary start date
    const startDate = await this.getItineraryStartDate(node);

    // Calculate time range
    let timeRange: string;
    if (startDate && node.dayIndex) {
      const actualDate = this.calculateActualDate(startDate, node.dayIndex);
      timeRange = node.scheduledTime ? `${actualDate} ${node.scheduledTime}` : actualDate;
    } else {
      timeRange = node.scheduledTime || new Date().toLocaleString('zh-CN');
    }

    // Generate diary fragment for unrealized node
    const content = await this.generateUnrealizedDiary(
      node,
      reason,
      moodEmoji,
      weather,
      prevContext
    );

    // Create diary fragment
    const fragmentId = uuidv4();
    const now = new Date();

    const fragment: DiaryFragment = {
      id: fragmentId,
      tripId,
      nodeId: node.id,
      content,
      timeRange,
      moodEmoji,
      weather,
      generatedAt: now,
      isEdited: false,
    };

    // Save to database
    const insertStmt = this.db.prepare(`
      INSERT INTO diary_fragments (id, trip_id, node_id, content, time_range, mood_emoji, weather, generated_at, is_edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    insertStmt.run(
      fragment.id,
      fragment.tripId,
      fragment.nodeId,
      fragment.content,
      fragment.timeRange,
      fragment.moodEmoji || null,
      fragment.weather || null,
      fragment.generatedAt.toISOString()
    );

    // Get updated node
    const updatedNode = await this.getTravelNode(nodeId);

    return {
      node: updatedNode!,
      fragment,
    };
  }

  /**
   * Generate diary content for unrealized node
   */
  private async generateUnrealizedDiary(
    node: TravelNode,
    reason: string,
    moodEmoji?: string,
    weather?: string,
    prevContext?: { node: TravelNode; diary?: DiaryFragment } | null
  ): Promise<string> {
    let prompt = `请为一个"未实现"的旅行节点生成一段约150-200字的日记片段。

原计划地点：${node.name}
原计划活动：${node.activity || node.description || '游览'}
未实现原因：${reason}
`;

    if (weather) {
      prompt += `天气：${this.getWeatherLabel(weather)}\n`;
    }

    if (moodEmoji) {
      prompt += `心情：${moodEmoji}\n`;
    }

    if (prevContext) {
      prompt += `\n【上一站信息（用于内容衔接）】\n`;
      prompt += `上一站地点：${prevContext.node.name}\n`;
      if (prevContext.node.description) {
        prompt += `上一站目的：${prevContext.node.description}\n`;
      }
      if (prevContext.diary) {
        prompt += `上一站日记：${prevContext.diary.content}\n`;
      }
    }

    prompt += `\n请用第一人称写一段日记，表达对未能实现这个计划的遗憾或释然，以及当时的心情。
注意：
1. 要体现"未实现"的状态，不要写成已经去过的样子
2. 可以表达遗憾、期待下次、或者对变化的接受
3. 日记要自然、真实，体现旅行中的不确定性`;

    try {
      const content = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行日记的作家。请根据提供的信息，用第一人称写一段约150-200字关于"未实现"行程的日记片段。文字要真实、有感情，体现旅行中的遗憾或释然。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return this.trimToLength(content, 120, 250);
    } catch (error) {
      console.error('Failed to generate unrealized diary:', error);
      const weatherText = weather ? `${this.getWeatherLabel(weather)}的天气，` : '';
      return `${weatherText}原本计划去${node.name}，但因为${reason}，最终没能成行。虽然有些遗憾，但旅行本就充满变数，期待下次能够实现这个愿望。`;
    }
  }

  /**
   * Generate diary fragment for a changed node
   * 为变更后的新节点生成日记片段
   */
  async generateChangedNodeDiary(
    node: TravelNode,
    tripId: string,
    materials: NodeMaterial,
    weather?: string,
    userTimeRange?: string
  ): Promise<DiaryFragment> {
    // Get the original node (parent node)
    const originalNode = node.parentNodeId ? await this.getTravelNode(node.parentNodeId) : null;

    // Get previous node context
    const prevContext = await this.getPreviousNodeContext(node);

    // Get itinerary start date
    const startDate = await this.getItineraryStartDate(node);

    // Analyze photos if any
    const photoAnalyses: string[] = [];
    for (const photo of materials.photos) {
      if (!photo.visionAnalysis) {
        const analysis = await this.analyzePhoto(photo);
        photoAnalyses.push(analysis);
      } else {
        photoAnalyses.push(photo.visionAnalysis);
      }
    }

    // Calculate time range
    let timeRange: string;
    if (userTimeRange) {
      timeRange = userTimeRange;
    } else if (startDate && node.dayIndex) {
      const actualDate = this.calculateActualDate(startDate, node.dayIndex);
      timeRange = node.scheduledTime ? `${actualDate} ${node.scheduledTime}` : actualDate;
    } else {
      timeRange = this.generateTimeRange(materials);
    }

    // Generate diary content with change context
    const content = await this.generateChangedDiaryContent(
      node,
      originalNode,
      photoAnalyses,
      materials.moodEmoji,
      materials.textNotes,
      weather,
      prevContext
    );

    // Create diary fragment
    const fragmentId = uuidv4();
    const now = new Date();

    const fragment: DiaryFragment = {
      id: fragmentId,
      tripId,
      nodeId: node.id,
      content,
      timeRange,
      moodEmoji: materials.moodEmoji,
      weather,
      textNotes: materials.textNotes,
      generatedAt: now,
      isEdited: false,
    };

    // Save to database
    const stmt = this.db.prepare(`
      INSERT INTO diary_fragments (id, trip_id, node_id, content, time_range, mood_emoji, weather, text_notes, generated_at, is_edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      fragment.generatedAt.toISOString()
    );

    // Mark node as lit
    const updateNodeStmt = this.db.prepare(`
      UPDATE travel_nodes SET is_lit = 1 WHERE id = ?
    `);
    updateNodeStmt.run(node.id);

    return fragment;
  }

  /**
   * Generate diary content for changed node
   */
  private async generateChangedDiaryContent(
    node: TravelNode,
    originalNode: TravelNode | null,
    photoAnalyses: string[],
    moodEmoji?: string,
    textNotes?: string[],
    weather?: string,
    prevContext?: { node: TravelNode; diary?: DiaryFragment } | null
  ): Promise<string> {
    let prompt = `请为一个"变更后"的旅行节点生成一段约200-300字的日记片段。

当前地点：${node.name}
节点状态：变更后的新目的地
变更原因：${node.statusReason || '临时调整'}
`;

    if (originalNode) {
      prompt += `原计划地点：${originalNode.name}\n`;
    }

    if (weather) {
      prompt += `天气：${this.getWeatherLabel(weather)}\n`;
    }

    if (moodEmoji) {
      prompt += `心情：${moodEmoji}\n`;
    }

    if (photoAnalyses.length > 0) {
      const validAnalyses = photoAnalyses.filter(a => a && a.length > 0);
      if (validAnalyses.length > 0) {
        prompt += `\n照片内容描述：\n`;
        validAnalyses.forEach((analysis, index) => {
          prompt += `${index + 1}. ${analysis}\n`;
        });
      }
    }

    if (textNotes && textNotes.length > 0) {
      prompt += `\n文字记录：\n`;
      textNotes.forEach((note, index) => {
        prompt += `${index + 1}. ${note}\n`;
      });
    }

    if (prevContext) {
      prompt += `\n【上一站信息（用于内容衔接）】\n`;
      prompt += `上一站地点：${prevContext.node.name}\n`;
      if (prevContext.node.description) {
        prompt += `上一站目的：${prevContext.node.description}\n`;
      }
      if (prevContext.diary) {
        prompt += `上一站日记：${prevContext.diary.content}\n`;
      }
    }

    prompt += `\n请用第一人称写一段日记，体现行程变更的经历和感受。
注意：
1. 要体现"变更"的状态，可以提及原计划和变更原因
2. 重点描述变更后的新体验
3. 日记要自然、真实，体现旅行中的灵活性和惊喜`;

    try {
      const content = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行日记的作家。请根据提供的信息，用第一人称写一段约200-300字关于"行程变更"的日记片段。文字要生动、有画面感，体现变更带来的新体验。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return this.trimToLength(content, 150, 350);
    } catch (error) {
      console.error('Failed to generate changed diary:', error);
      const weatherText = weather ? `${this.getWeatherLabel(weather)}，` : '';
      const originalText = originalNode ? `原本计划去${originalNode.name}，` : '';
      return `${weatherText}${originalText}因为${node.statusReason || '临时调整'}，我来到了${node.name}。意外的变化带来了不一样的体验，旅行的魅力或许就在于这些未知的惊喜。`;
    }
  }

  // ==================== AI Image Generation Methods ====================

  /**
   * 随机选择一种图像风格
   */
  private selectRandomImageStyle(): DiaryImageStyle {
    const styles: DiaryImageStyle[] = ['watercolor', 'shinkai', 'ghibli', 'film', 'inkwash'];
    const randomIndex = Math.floor(Math.random() * styles.length);
    return styles[randomIndex];
  }

  /**
   * Generate AI image for a diary fragment without photos
   * 为没有照片的日记片段生成AI图像（随机横版或竖版，随机风格）
   */
  async generateAiImage(
    nodeId: string,
    diaryContent: string,
    nodeName: string,
    nodeDescription?: string,
    weather?: string,
    moodEmoji?: string
  ): Promise<{ url: string; orientation: 'portrait' | 'landscape' }> {
    // 随机选择横版或竖版
    const isLandscape = Math.random() > 0.5;
    const orientation = isLandscape ? 'landscape' : 'portrait';
    
    // 随机选择图像风格
    const styleKey = this.selectRandomImageStyle();
    const style = DIARY_IMAGE_STYLES[styleKey];
    
    console.log('[DiaryService] 开始为节点生成AI图像:', { nodeId, nodeName, orientation, style: style.name });

    // 构建图像生成的prompt
    const imagePrompt = await this.buildImagePrompt(
      diaryContent,
      nodeName,
      nodeDescription,
      weather,
      moodEmoji,
      orientation,
      style
    );

    console.log('[DiaryService] 图像生成Prompt:', imagePrompt);

    try {
      // 调用万相API生成图像
      // polaroid: 竖版 3:4, polaroid-landscape: 横版 4:3
      const wanxOrientation = isLandscape ? 'polaroid-landscape' : 'polaroid';
      const remoteUrl = await wanxClient.generateImage(imagePrompt, style.wanxStyle, wanxOrientation);
      
      console.log(`[DiaryService] AI${orientation}图像生成成功(临时URL):`, remoteUrl);

      // 下载图片并保存到本地永久存储
      const localUrl = await this.downloadAndSaveImage(remoteUrl, `ai-diary-${nodeId}`);
      console.log(`[DiaryService] AI图像已保存到本地:`, localUrl);

      // 保存本地URL和方向到数据库
      await this.saveAiGeneratedImage(nodeId, localUrl, orientation);

      return { url: localUrl, orientation };
    } catch (error) {
      console.error('[DiaryService] AI图像生成失败:', error);
      throw new Error('AI图像生成失败，请稍后重试');
    }
  }

  /**
   * Download image from URL and save to local storage
   * 从URL下载图片并保存到本地存储
   */
  private async downloadAndSaveImage(imageUrl: string, prefix: string): Promise<string> {
    try {
      console.log(`[DiaryService] 下载图片: ${imageUrl}`);
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      
      const buffer = Buffer.from(response.data);
      const localPath = await fileStorage.saveFile(buffer, 'photo', 'jpg');
      
      console.log(`[DiaryService] 图片已保存到本地: ${localPath}`);
      return localPath;
    } catch (error) {
      console.error(`[DiaryService] 下载图片失败:`, error);
      throw error;
    }
  }

  /**
   * Build prompt for AI image generation
   * 构建AI图像生成的prompt
   */
  private async buildImagePrompt(
    diaryContent: string,
    nodeName: string,
    nodeDescription?: string,
    weather?: string,
    moodEmoji?: string,
    orientation: 'portrait' | 'landscape' = 'portrait',
    style: DiaryImageStyleConfig = DIARY_IMAGE_STYLES.watercolor
  ): Promise<string> {
    // 使用DeepSeek来生成更好的图像描述prompt
    const weatherLabel = weather ? this.getWeatherLabel(weather) : '';
    const moodLabel = moodEmoji ? this.getMoodLabel(moodEmoji) : '';

    const isLandscape = orientation === 'landscape';
    const compositionDesc = isLandscape 
      ? '横版构图的旅行场景画面（landscape orientation, horizontal composition, wide cinematic frame）'
      : '竖版构图的旅行场景画面（portrait orientation, vertical composition, tall narrow frame）';

    const promptRequest = `请根据以下旅行日记内容，生成一段用于AI绘画的英文描述（约50-80个英文单词）。
要求：
1. 描述一个${compositionDesc}
2. 风格：${style.name}，${style.description}
3. 画面要体现地点特色和当时的氛围
4. 不要出现人物，只描绘风景和环境
5. 直接输出英文描述，不要任何解释

地点名称：${nodeName}
${nodeDescription ? `地点描述：${nodeDescription}` : ''}
${weatherLabel ? `天气：${weatherLabel}` : ''}
${moodLabel ? `氛围：${moodLabel}` : ''}

日记内容：
${diaryContent}`;

    try {
      const imageDescription = await deepseekClient.chat([
        {
          role: 'system',
          content: 'You are an expert at creating image generation prompts. Output only the English description for the image, nothing else.',
        },
        {
          role: 'user',
          content: promptRequest,
        },
      ], 0.7);

      // 根据风格和方向构建最终prompt
      const frameDesc = isLandscape 
        ? 'landscape orientation, horizontal composition, wide cinematic frame' 
        : 'portrait orientation, vertical composition, tall narrow frame';
      
      return `${style.promptPrefix}, ${frameDesc}, travel scenery, no people, ${imageDescription.trim()}, ${style.promptSuffix}`;
    } catch (error) {
      console.error('[DiaryService] 生成图像prompt失败，使用默认prompt:', error);
      // 使用默认的简单prompt
      const frameDesc = isLandscape 
        ? 'landscape orientation, horizontal composition, wide cinematic frame' 
        : 'portrait orientation, vertical composition, tall narrow frame';
      return `${style.promptPrefix}, ${frameDesc}, travel scenery of ${nodeName}, ${weatherLabel || 'pleasant weather'}, peaceful and serene, no people, ${style.promptSuffix}`;
    }
  }

  /**
   * Get mood label from emoji
   */
  private getMoodLabel(moodEmoji: string): string {
    const moodMap: Record<string, string> = {
      '😊': '开心愉悦',
      '🥰': '幸福温馨',
      '😎': '酷炫自在',
      '🤩': '惊喜兴奋',
      '😌': '平静安宁',
      '🥱': '疲惫慵懒',
      '😋': '美味享受',
      '🤔': '沉思冥想',
      '😢': '感动动容',
      '🌟': '精彩绚烂',
    };
    return moodMap[moodEmoji] || '';
  }

  /**
   * Save AI generated image URL to database
   */
  private async saveAiGeneratedImage(nodeId: string, imageUrl: string, orientation: 'portrait' | 'landscape' = 'portrait'): Promise<void> {
    // 确保node_materials存在
    const materialId = await this.ensureNodeMaterial(nodeId);

    // 使用 vision_analysis 字段存储 AI 生成标记和方向信息
    // 格式: AI_GENERATED_PORTRAIT 或 AI_GENERATED_LANDSCAPE
    const visionAnalysis = `AI_GENERATED_${orientation.toUpperCase()}`;

    // 检查是否已有AI生成的图像记录
    const existingStmt = this.db.prepare(`
      SELECT id FROM photo_materials 
      WHERE material_id = ? AND vision_analysis LIKE 'AI_GENERATED%'
    `);
    const existing = existingStmt.get(materialId) as { id: string } | undefined;

    if (existing) {
      // 更新现有记录
      const updateStmt = this.db.prepare(`
        UPDATE photo_materials SET url = ?, upload_time = ?, vision_analysis = ? WHERE id = ?
      `);
      updateStmt.run(imageUrl, new Date().toISOString(), visionAnalysis, existing.id);
    } else {
      // 创建新记录
      const photoId = uuidv4();
      const insertStmt = this.db.prepare(`
        INSERT INTO photo_materials (id, material_id, url, upload_time, vision_analysis)
        VALUES (?, ?, ?, ?, ?)
      `);
      insertStmt.run(photoId, materialId, imageUrl, new Date().toISOString(), visionAnalysis);
    }
  }

  /**
   * Get AI generated image for a node
   */
  async getAiGeneratedImage(nodeId: string): Promise<{ url: string; orientation: 'portrait' | 'landscape' } | null> {
    const materialStmt = this.db.prepare(`
      SELECT id FROM node_materials WHERE node_id = ?
    `);
    const material = materialStmt.get(nodeId) as { id: string } | undefined;

    if (!material) {
      return null;
    }

    const photoStmt = this.db.prepare(`
      SELECT url, vision_analysis FROM photo_materials 
      WHERE material_id = ? AND vision_analysis LIKE 'AI_GENERATED%'
      ORDER BY upload_time DESC
      LIMIT 1
    `);
    const photo = photoStmt.get(material.id) as { url: string; vision_analysis: string } | undefined;

    if (!photo?.url) {
      return null;
    }

    // 从 vision_analysis 解析方向
    const orientation = photo.vision_analysis.includes('LANDSCAPE') ? 'landscape' : 'portrait';
    return { url: photo.url, orientation };
  }
}

// Export singleton instance
export const diaryService = new DiaryService();
