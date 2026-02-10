import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database';
import { deepseekClient } from '../clients/deepseekClient';
import { wanxClient } from '../clients/wanxClient';
import { storageService, DiaryFragment, Itinerary, PhotoMaterial } from './storageService';
import { diaryService } from './diaryService';
import { fileStorage } from '../storage/fileStorage';
import type Database from 'better-sqlite3';
import axios from 'axios';

// Type definitions based on design document
export interface EnrichedDiaryFragment extends DiaryFragment {
  nodeName: string;
  photos: Pick<PhotoMaterial, 'id' | 'url' | 'uploadTime' | 'visionAnalysis'>[];
}

export interface PersonalityReport {
  title: string;
  description: string;
  traits: string[];
  statistics: TripStatistics;
}

export interface TripStatistics {
  totalDays: number;
  totalNodes: number;
  totalPhotos: number;
  topMoods: string[];
  highlightMoments: string[];
}

export interface MemoirTemplate {
  id: string;
  name: string;
  cssClass: string;
  previewUrl: string;
}

export interface TravelMemoir {
  id: string;
  tripId: string;
  title: string;
  coverImageUrl: string;
  endImageUrl: string;
  openingText: string;      // 开头总起文字
  closingText: string;      // 结尾总结文字
  fragments: EnrichedDiaryFragment[];
  personalityReport: PersonalityReport;
  templateId: string;
  generatedAt: Date;
  shareUrl?: string;
}

// Database row type
interface MemoirRow {
  id: string;
  trip_id: string;
  title: string;
  cover_image_url: string;
  end_image_url: string;
  opening_text: string | null;
  closing_text: string | null;
  template_id: string;
  personality_report: string;
  generated_at: string;
  share_url: string | null;
}

// Available templates
const AVAILABLE_TEMPLATES: MemoirTemplate[] = [
  {
    id: 'ocean-breeze',
    name: '海洋微风',
    cssClass: 'template-ocean-breeze',
    previewUrl: '/templates/ocean-breeze-preview.png',
  },
  {
    id: 'japanese-fresh',
    name: '日系小清新',
    cssClass: 'template-japanese-fresh',
    previewUrl: '/templates/japanese-fresh-preview.png',
  },
  {
    id: 'vintage-kraft',
    name: '复古牛皮纸',
    cssClass: 'template-vintage-kraft',
    previewUrl: '/templates/vintage-kraft-preview.png',
  },
  {
    id: 'minimal-mono',
    name: '极简黑白',
    cssClass: 'template-minimal-mono',
    previewUrl: '/templates/minimal-mono-preview.png',
  },
  {
    id: 'forest-green',
    name: '森林物语',
    cssClass: 'template-forest-green',
    previewUrl: '/templates/forest-green-preview.png',
  },
  {
    id: 'sunset-warm',
    name: '日落暖阳',
    cssClass: 'template-sunset-warm',
    previewUrl: '/templates/sunset-warm-preview.png',
  },
  {
    id: 'lavender-dream',
    name: '薰衣草梦',
    cssClass: 'template-lavender-dream',
    previewUrl: '/templates/lavender-dream-preview.png',
  },
  {
    id: 'cherry-blossom',
    name: '樱花漫舞',
    cssClass: 'template-cherry-blossom',
    previewUrl: '/templates/cherry-blossom-preview.png',
  },
];

// Default images for fallback
const DEFAULT_COVER_IMAGE = '/images/default-cover.jpg';
const DEFAULT_END_IMAGE = '/images/default-end.jpg';

// AI 图像风格定义
type ImageStyle = 'shinkai' | 'film' | 'ukiyoe';

interface ImageStyleConfig {
  name: string;
  description: string;
  promptPrefix: string;
  promptSuffix: string;
  wanxStyle: string;
}

const IMAGE_STYLES: Record<ImageStyle, ImageStyleConfig> = {
  // 风格 A：新海诚式光影
  shinkai: {
    name: '新海诚式光影',
    description: '极其细腻的光影，强调云层、夕阳、反光，带有强烈的怀旧感',
    promptPrefix: 'Anime style background, Makoto Shinkai style, cinematic lighting, lens flare',
    promptSuffix: 'highly detailed clouds, nostalgic atmosphere, wide angle, beautiful sky, golden hour lighting, atmospheric perspective, 8k quality',
    wanxStyle: '<anime>',
  },
  // 风格 B：胶片摄影 + 印象派
  film: {
    name: '胶片印象派',
    description: '模拟 Kodak Portra 400 胶片的颗粒感，色彩温暖复古，边缘略微模糊',
    promptPrefix: 'Analog film photography style, Kodak Portra 400, soft focus, dreamy atmosphere',
    promptSuffix: 'light leak effect, film grain texture, emotional storytelling, warm vintage colors, bokeh background, nostalgic mood, artistic composition',
    wanxStyle: '<photography>',
  },
  // 风格 C：浮世绘现代版
  ukiyoe: {
    name: '现代浮世绘',
    description: '线条清晰，色彩平涂但高级，低饱和度，契合日式极简风格',
    promptPrefix: 'Modern Ukiyo-e style, woodblock print texture, flat vector illustration',
    promptSuffix: 'minimalist composition, muted colors, sage green and beige palette, clean lines, Japanese aesthetic, zen atmosphere, elegant simplicity',
    wanxStyle: '<watercolor>',
  },
};

export class MemoirService {
  private db: Database.Database;

  constructor() {
    this.db = getDatabase();
  }


  // ==================== Core Memoir Generation Methods ====================

  /**
   * Generate a complete travel memoir for a trip
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  async generateMemoir(tripId: string): Promise<TravelMemoir> {
    // Get trip information
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      throw new Error(`Trip not found: ${tripId}`);
    }

    // Get all diary fragments for the trip
    const fragments = await storageService.getDiaryFragments(tripId);
    if (fragments.length === 0) {
      throw new Error('No diary fragments found for this trip');
    }

    // Enrich fragments with node name and photos
    const enrichedFragments = await this.enrichFragmentsWithPhotos(fragments, trip.destination);

    // Get itinerary for statistics
    const itinerary = await storageService.getItinerary(tripId);

    // Generate personality report
    const personalityReport = await this.generatePersonalityReport(fragments, itinerary);

    // Generate opening and closing texts
    const [openingText, closingText] = await Promise.all([
      this.generateOpeningText(fragments, trip.destination, itinerary),
      this.generateClosingText(fragments, trip.destination, personalityReport),
    ]);

    // Generate cover and end images
    const [coverImageUrl, endImageUrl] = await Promise.all([
      this.generateCoverImage(fragments, trip.destination),
      this.generateEndImage(personalityReport, trip.destination),
    ]);

    // Create memoir title
    const title = this.generateMemoirTitle(trip.destination, personalityReport.title);

    // Create memoir record
    const memoirId = uuidv4();
    const now = new Date();
    const defaultTemplateId = 'japanese-fresh';

    const memoir: TravelMemoir = {
      id: memoirId,
      tripId,
      title,
      coverImageUrl,
      endImageUrl,
      openingText,
      closingText,
      fragments: enrichedFragments,
      personalityReport,
      templateId: defaultTemplateId,
      generatedAt: now,
    };

    // Save to database
    await this.saveMemoir(memoir);

    // Update trip status to completed
    await storageService.updateTrip(tripId, { status: 'completed' });

    return memoir;
  }

  /**
   * Enrich diary fragments with node name and photos
   */
  private async enrichFragmentsWithPhotos(
      fragments: DiaryFragment[],
      destination: string
    ): Promise<EnrichedDiaryFragment[]> {
      return Promise.all(
        fragments.map(async (fragment) => {
          const node = await diaryService.getTravelNode(fragment.nodeId);
          const materials = await diaryService.getNodeMaterials(fragment.nodeId);
          const nodeName = node?.name || '未知地点';

          const photos = materials?.photos.map((p) => ({
            id: p.id,
            url: p.url,
            uploadTime: p.uploadTime,
            visionAnalysis: p.visionAnalysis,
          })) || [];

          return {
            ...fragment,
            nodeName,
            photos,
          };
        })
      );
    }

  /**
   * Generate opening text for the memoir
   * 生成回忆录开头总起文字
   */
  private async generateOpeningText(
    fragments: DiaryFragment[],
    destination: string,
    itinerary: Itinerary | null
  ): Promise<string> {
    const totalDays = itinerary?.totalDays || this.estimateDaysFromFragments(fragments);
    const nodeNames = fragments.slice(0, 5).map(f => f.nodeId).join('、');
    
    // 提取第一个日记片段的内容作为参考
    const firstFragment = fragments[0];
    const firstMood = firstFragment?.moodEmoji || '';
    
    const prompt = `请为一本${destination}旅行回忆录写一段开头总起文字。

旅行信息：
- 目的地：${destination}
- 旅行天数：${totalDays}天
- 游览地点数：${fragments.length}个
- 第一站心情：${firstMood}

要求：
1. 50-80字左右
2. 用第一人称，语气温暖、期待
3. 可以用诗意的方式引出这段旅程
4. 不要使用"亲爱的"等称呼
5. 体现出发时的心情和对旅途的期待`;

    try {
      const response = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行散文的作家，文字温暖细腻，富有诗意。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return response.trim();
    } catch (error) {
      console.error('Opening text generation failed:', error);
      return `带着期待与好奇，我踏上了前往${destination}的旅程。${totalDays}天的时光，${fragments.length}个足迹，每一步都是故事的开始。`;
    }
  }

  /**
   * Generate closing text for the memoir
   * 生成回忆录结尾总结文字
   */
  private async generateClosingText(
    fragments: DiaryFragment[],
    destination: string,
    personalityReport: PersonalityReport
  ): Promise<string> {
    // 收集所有心情
    const moods = fragments.map(f => f.moodEmoji).filter(Boolean);
    const moodSummary = moods.length > 0 ? moods.slice(0, 5).join(' ') : '';
    
    // 提取最后一个日记片段
    const lastFragment = fragments[fragments.length - 1];
    
    const prompt = `请为一本${destination}旅行回忆录写一段结尾总结文字。

旅行信息：
- 目的地：${destination}
- 旅行人格：${personalityReport.title}
- 人格特征：${personalityReport.traits.join('、')}
- 旅途心情：${moodSummary}
- 最后一站内容：${lastFragment?.content || ''}

要求：
1. 60-100字左右
2. 用第一人称，语气温暖、感慨
3. 总结这段旅程的收获和感悟
4. 可以展望未来，但不要太煽情
5. 体现旅行人格特点
6. 结尾要有力量感，给人回味`;

    try {
      const response = await deepseekClient.chat([
        {
          role: 'system',
          content: '你是一位擅长写旅行散文的作家，文字温暖细腻，善于总结感悟。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], 0.8);

      return response.trim();
    } catch (error) {
      console.error('Closing text generation failed:', error);
      return `${destination}的故事暂时画上句号，但那些风景、那些心情，已经成为我生命中闪闪发光的记忆。作为一个${personalityReport.title}，我知道，下一段旅程正在远方等待。`;
    }
  }

  /**
   * Generate personality report based on diary fragments and itinerary
   * Requirements: 6.2, 6.3
   */
  async generatePersonalityReport(
    fragments: DiaryFragment[],
    itinerary: Itinerary | null
  ): Promise<PersonalityReport> {
    // Calculate statistics
    const statistics = this.calculateTripStatistics(fragments, itinerary);

    // Build prompt for DeepSeek
    const prompt = this.buildPersonalityReportPrompt(fragments, statistics);

    try {
      const response = await deepseekClient.chatWithJson<{
        title: string;
        description: string;
        traits: string[];
      }>([
        {
          role: 'system',
          content: `你是一位旅行心理分析专家。请根据用户的旅行日记内容，分析其旅行人格特征，生成一份有趣的旅行人格报告。
          
请以JSON格式返回以下内容：
{
  "title": "旅行人格称号（如：雪山仰望者、美食探险家、城市漫步者等，4-6个字）",
  "description": "人格描述（100-150字，描述这种旅行人格的特点和魅力）",
  "traits": ["特征标签1", "特征标签2", "特征标签3"]（3-5个标签，每个2-4个字）
}`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ]);

      return {
        title: response.title,
        description: response.description,
        traits: response.traits,
        statistics,
      };
    } catch (error) {
      console.error('Personality report generation failed:', error);
      // Return fallback report
      return this.generateFallbackPersonalityReport(statistics);
    }
  }

  /**
   * Download image from URL and save to local storage
   */
  private async downloadAndSaveImage(imageUrl: string, prefix: string): Promise<string> {
    try {
      console.log(`[MemoirService] 下载图片: ${imageUrl}`);
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      
      const buffer = Buffer.from(response.data);
      const localPath = await fileStorage.saveFile(buffer, 'photo', 'jpg');
      
      console.log(`[MemoirService] 图片已保存到本地: ${localPath}`);
      return localPath;
    } catch (error) {
      console.error(`[MemoirService] 下载图片失败:`, error);
      throw error;
    }
  }

  /**
   * 随机选择一种图像风格
   */
  private selectImageStyle(): ImageStyle {
    const styles: ImageStyle[] = ['shinkai', 'film', 'ukiyoe'];
    const randomIndex = Math.floor(Math.random() * styles.length);
    return styles[randomIndex];
  }

  /**
   * 根据目的地和内容选择最适合的风格
   * 风景类 -> 新海诚
   * 美食/人文 -> 胶片
   * 古镇/传统 -> 浮世绘
   */
  private selectStyleByContent(destination: string, keywords: string): ImageStyle {
    const lowerDest = destination.toLowerCase();
    const lowerKeywords = keywords.toLowerCase();
    
    // 传统/古风目的地 -> 浮世绘
    const traditionalKeywords = ['古镇', '古城', '寺庙', '神社', '园林', '京都', '奈良', '苏州', '丽江', '大理', '西安', '敦煌'];
    if (traditionalKeywords.some(k => lowerDest.includes(k) || lowerKeywords.includes(k))) {
      return 'ukiyoe';
    }
    
    // 美食/人文 -> 胶片
    const filmKeywords = ['美食', '小吃', '餐厅', '咖啡', '市场', '街道', '人文', '生活'];
    if (filmKeywords.some(k => lowerKeywords.includes(k))) {
      return 'film';
    }
    
    // 自然风景 -> 新海诚
    const natureKeywords = ['山', '海', '湖', '雪', '云', '日出', '日落', '星空', '森林', '草原'];
    if (natureKeywords.some(k => lowerDest.includes(k) || lowerKeywords.includes(k))) {
      return 'shinkai';
    }
    
    // 默认随机
    return this.selectImageStyle();
  }

  /**
   * Generate cover image using Wanx API with artistic styles
   * Requirements: 6.4
   */
  async generateCoverImage(
    fragments: DiaryFragment[],
    destination: string
  ): Promise<string> {
    try {
      // 获取当地特色描述
      const localFeatures = this.getDestinationFeatures(destination);
      
      // 从日记中提取关键词
      const diaryContext = fragments
        .slice(0, 3)
        .map((f) => f.content)
        .join(' ');
      const keywords = this.extractKeywords(diaryContext);
      
      // 根据内容选择最适合的风格
      const styleKey = this.selectStyleByContent(destination, keywords);
      const style = IMAGE_STYLES[styleKey];
      
      // 构建艺术风格的 prompt
      const prompt = `${style.promptPrefix}, travel memoir cover illustration, ${destination}, ${localFeatures}, ${keywords}, ${style.promptSuffix}`;

      console.log('[MemoirService] 开始生成封面图');
      console.log(`[MemoirService] 选择风格: ${style.name}`);
      console.log('[MemoirService] 封面图 Prompt:', prompt);
      
      const remoteUrl = await wanxClient.generateImage(prompt, style.wanxStyle);
      
      // 下载并保存到本地
      const localPath = await this.downloadAndSaveImage(remoteUrl, 'cover');
      
      console.log('[MemoirService] 封面图生成成功:', localPath);
      return localPath;
    } catch (error) {
      console.error('[MemoirService] 封面图生成失败，使用默认图片:', error);
      return DEFAULT_COVER_IMAGE;
    }
  }

  /**
   * Generate end image using Wanx API with artistic styles
   * Requirements: 6.4
   */
  async generateEndImage(personalityReport: PersonalityReport, destination?: string): Promise<string> {
    try {
      const traits = personalityReport.traits.join(', ');
      // 获取当地特色
      const localFeatures = destination ? this.getDestinationFeatures(destination) : '';
      
      // 尾图倾向于使用更抽象/艺术的风格，随机选择
      const styleKey = this.selectImageStyle();
      const style = IMAGE_STYLES[styleKey];
      
      // 构建艺术风格的 prompt
      const prompt = `${style.promptPrefix}, travel personality illustration, ${personalityReport.title}, ${traits}, ${localFeatures ? localFeatures + ', ' : ''}journey ending scene, peaceful atmosphere, ${style.promptSuffix}`;

      console.log('[MemoirService] 开始生成尾图');
      console.log(`[MemoirService] 选择风格: ${style.name}`);
      console.log('[MemoirService] 尾图 Prompt:', prompt);
      
      const remoteUrl = await wanxClient.generateImage(prompt, style.wanxStyle);
      
      // 下载并保存到本地
      const localPath = await this.downloadAndSaveImage(remoteUrl, 'end');
      
      console.log('[MemoirService] 尾图生成成功:', localPath);
      return localPath;
    } catch (error) {
      console.error('[MemoirService] 尾图生成失败，使用默认图片:', error);
      return DEFAULT_END_IMAGE;
    }
  }

  /**
   * 获取目的地的特色描述
   */
  private getDestinationFeatures(destination: string): string {
    // 常见旅游目的地的特色映射
    const featuresMap: Record<string, string> = {
      // 国内热门城市
      '北京': '故宫红墙、天坛、长城、胡同四合院、古都风韵',
      '上海': '外滩夜景、东方明珠、石库门、现代都市、海派风情',
      '广州': '珠江夜景、骑楼老街、早茶文化、岭南风情',
      '深圳': '现代都市、海滨风光、科技感、年轻活力',
      '杭州': '西湖美景、断桥残雪、雷峰塔、江南水乡、诗意画境',
      '苏州': '园林假山、小桥流水、评弹昆曲、吴侬软语、江南韵味',
      '南京': '秦淮河畔、明城墙、梧桐大道、六朝古都、历史沧桑',
      '成都': '熊猫、宽窄巷子、锦里、川西风情、悠闲慢生活',
      '重庆': '山城夜景、洪崖洞、长江索道、火锅、魔幻立体',
      '西安': '兵马俑、古城墙、大雁塔、钟鼓楼、千年古都',
      '厦门': '鼓浪屿、南普陀、环岛路、闽南风情、海滨浪漫',
      '青岛': '红瓦绿树、碧海蓝天、栈桥、德式建筑、海滨城市',
      '大理': '苍山洱海、白族民居、风花雪月、云南风情',
      '丽江': '古城夜色、玉龙雪山、纳西文化、小桥流水',
      '三亚': '椰林沙滩、碧海蓝天、热带风情、阳光海岸',
      '桂林': '漓江山水、喀斯特地貌、象鼻山、山水甲天下',
      '张家界': '奇峰异石、云海仙境、玻璃栈道、阿凡达取景地',
      '黄山': '奇松怪石、云海日出、徽派建筑、人间仙境',
      '九寨沟': '彩池瀑布、原始森林、藏族风情、童话世界',
      '西藏': '布达拉宫、雪山圣湖、藏传佛教、高原风光',
      '拉萨': '布达拉宫、大昭寺、八廓街、藏族文化、神圣净土',
      '新疆': '天山雪峰、戈壁沙漠、葡萄美酒、丝路风情',
      '内蒙古': '草原牧场、蒙古包、骏马奔腾、辽阔天地',
      '哈尔滨': '冰雪大世界、圣索菲亚教堂、俄式风情、冰城',
      '长白山': '天池、雪山、温泉、原始森林、北国风光',
      '青海': '青海湖、茶卡盐湖、藏族风情、高原净土',
      '敦煌': '莫高窟、鸣沙山、月牙泉、丝路文化、大漠孤烟',
      '阿坝': '九寨沟、黄龙、四姑娘山、藏羌风情、高原秘境',
      // 海外热门
      '日本': '樱花、富士山、和风建筑、精致美学',
      '东京': '现代都市、樱花、浅草寺、霓虹灯光',
      '京都': '古寺神社、艺伎、枫叶、和风庭院',
      '泰国': '金碧辉煌的寺庙、热带海滩、大象、泰式风情',
      '巴厘岛': '海神庙、梯田、热带花园、印尼风情',
      '马尔代夫': '水上屋、珊瑚礁、碧海蓝天、热带天堂',
      '巴黎': '埃菲尔铁塔、塞纳河、浪漫之都、艺术气息',
      '伦敦': '大本钟、红色电话亭、英伦风情、雾都',
      '纽约': '自由女神、时代广场、摩天大楼、都市繁华',
    };

    // 精确匹配
    if (featuresMap[destination]) {
      return featuresMap[destination];
    }

    // 模糊匹配
    for (const [key, value] of Object.entries(featuresMap)) {
      if (destination.includes(key) || key.includes(destination)) {
        return value;
      }
    }

    // 默认返回通用描述
    return '自然风光、人文景观、当地特色';
  }

  // ==================== Template Methods ====================

  /**
   * Apply template to memoir and return rendered HTML
   * Requirements: 7.2
   */
  async applyTemplate(memoir: TravelMemoir, templateId: string): Promise<string> {
    const template = AVAILABLE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Update memoir template
    await this.updateMemoirTemplate(memoir.id, templateId);

    // Render HTML with template
    return this.renderMemoirHtml(memoir, template);
  }

  /**
   * Get all available templates
   * Requirements: 7.1
   */
  async getAvailableTemplates(): Promise<MemoirTemplate[]> {
    return AVAILABLE_TEMPLATES;
  }

  // ==================== Database Operations ====================

  /**
   * Save memoir to database
   */
  private async saveMemoir(memoir: TravelMemoir): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO travel_memoirs (
        id, trip_id, title, cover_image_url, end_image_url,
        opening_text, closing_text, template_id, personality_report, generated_at, share_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trip_id) DO UPDATE SET
        title = excluded.title,
        cover_image_url = excluded.cover_image_url,
        end_image_url = excluded.end_image_url,
        opening_text = excluded.opening_text,
        closing_text = excluded.closing_text,
        template_id = excluded.template_id,
        personality_report = excluded.personality_report,
        generated_at = excluded.generated_at
    `);

    stmt.run(
      memoir.id,
      memoir.tripId,
      memoir.title,
      memoir.coverImageUrl,
      memoir.endImageUrl,
      memoir.openingText,
      memoir.closingText,
      memoir.templateId,
      JSON.stringify(memoir.personalityReport),
      memoir.generatedAt.toISOString(),
      memoir.shareUrl || null
    );
  }

  /**
   * Get memoir by trip ID
   */
  async getMemoir(tripId: string): Promise<TravelMemoir | null> {
    const stmt = this.db.prepare(`
      SELECT id, trip_id, title, cover_image_url, end_image_url,
             opening_text, closing_text, template_id, personality_report, generated_at, share_url
      FROM travel_memoirs WHERE trip_id = ?
    `);

    const row = stmt.get(tripId) as MemoirRow | undefined;
    if (!row) {
      return null;
    }

    // Get fragments with photos (don't generate new AI images when reading)
    const fragments = await storageService.getDiaryFragments(tripId);
    // 获取 trip 信息以获取 destination
    const trip = await storageService.getTrip(tripId);
    const enrichedFragments = await this.enrichFragmentsWithPhotos(
      fragments, 
      trip?.destination || ''
    );

    return {
      id: row.id,
      tripId: row.trip_id,
      title: row.title,
      coverImageUrl: row.cover_image_url,
      endImageUrl: row.end_image_url,
      openingText: row.opening_text || '',
      closingText: row.closing_text || '',
      fragments: enrichedFragments,
      personalityReport: JSON.parse(row.personality_report),
      templateId: row.template_id,
      generatedAt: new Date(row.generated_at),
      shareUrl: row.share_url || undefined,
    };
  }

  /**
   * Update memoir template
   */
  private async updateMemoirTemplate(memoirId: string, templateId: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE travel_memoirs SET template_id = ? WHERE id = ?
    `);
    stmt.run(templateId, memoirId);
  }


  // ==================== Helper Methods ====================

  /**
   * Build prompt for personality report generation
   */
  private buildPersonalityReportPrompt(
    fragments: DiaryFragment[],
    statistics: TripStatistics
  ): string {
    const diaryContent = fragments
      .map((f, i) => `日记${i + 1}：${f.content}`)
      .join('\n');

    const moodSummary = statistics.topMoods.length > 0
      ? `主要心情：${statistics.topMoods.join('、')}`
      : '';

    return `请根据以下旅行日记内容分析旅行人格：

旅行统计：
- 旅行天数：${statistics.totalDays}天
- 游览地点：${statistics.totalNodes}个
- 拍摄照片：${statistics.totalPhotos}张
${moodSummary}

日记内容：
${diaryContent}

请分析这位旅行者的旅行风格和人格特征，生成一份有趣的旅行人格报告。`;
  }

  /**
   * Calculate trip statistics from fragments and itinerary
   */
  private calculateTripStatistics(
    fragments: DiaryFragment[],
    itinerary: Itinerary | null
  ): TripStatistics {
    // Count moods
    const moodCounts: Record<string, number> = {};
    fragments.forEach((f) => {
      if (f.moodEmoji) {
        moodCounts[f.moodEmoji] = (moodCounts[f.moodEmoji] || 0) + 1;
      }
    });

    // Get top moods
    const topMoods = Object.entries(moodCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([mood]) => mood);

    // Extract highlight moments (first sentence of each fragment)
    const highlightMoments = fragments
      .slice(0, 5)
      .map((f) => {
        const firstSentence = f.content.split(/[。！？]/)[0];
        return firstSentence.length > 30
          ? firstSentence.substring(0, 30) + '...'
          : firstSentence;
      });

    // Count photos from database
    const photoCount = this.countPhotosForTrip(fragments);

    return {
      totalDays: itinerary?.totalDays || this.estimateDaysFromFragments(fragments),
      totalNodes: itinerary?.nodes.length || fragments.length,
      totalPhotos: photoCount,
      topMoods,
      highlightMoments,
    };
  }

  /**
   * Count photos for a trip
   */
  private countPhotosForTrip(fragments: DiaryFragment[]): number {
    if (fragments.length === 0) return 0;

    const nodeIds = fragments.map((f) => f.nodeId);
    const placeholders = nodeIds.map(() => '?').join(',');

    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM photo_materials pm
      JOIN node_materials nm ON pm.material_id = nm.id
      WHERE nm.node_id IN (${placeholders})
    `);

    const result = stmt.get(...nodeIds) as { count: number };
    return result?.count || 0;
  }

  /**
   * Estimate days from fragment timestamps
   */
  private estimateDaysFromFragments(fragments: DiaryFragment[]): number {
    if (fragments.length === 0) return 0;

    const dates = new Set(
      fragments.map((f) => f.generatedAt.toDateString())
    );
    return dates.size;
  }

  /**
   * Generate fallback personality report
   */
  private generateFallbackPersonalityReport(statistics: TripStatistics): PersonalityReport {
    return {
      title: '旅行探索者',
      description: '你是一位热爱探索的旅行者，用心记录每一个精彩瞬间。你的旅程充满了发现与感动，每一步都是新的故事。',
      traits: ['好奇心强', '善于发现', '热爱记录'],
      statistics,
    };
  }

  /**
   * Generate memoir title
   */
  private generateMemoirTitle(destination: string, personalityTitle: string): string {
    return `${destination}之旅 · ${personalityTitle}`;
  }

  /**
   * Extract keywords from diary content
   */
  private extractKeywords(content: string): string {
    // Simple keyword extraction - in production, could use NLP
    const keywords: string[] = [];
    
    // Common travel-related keywords to look for
    const patterns = [
      /雪山|山峰|高山/g,
      /大海|海边|沙滩/g,
      /森林|树林|绿色/g,
      /古镇|老街|历史/g,
      /美食|小吃|餐厅/g,
      /日出|日落|夕阳/g,
      /星空|夜景|灯光/g,
    ];

    patterns.forEach((pattern) => {
      const matches = content.match(pattern);
      if (matches) {
        keywords.push(matches[0]);
      }
    });

    return keywords.slice(0, 3).join('、') || '美好风景';
  }


  /**
   * Render memoir as HTML with template
   * Requirements: 7.2
   */
  private renderMemoirHtml(memoir: TravelMemoir, template: MemoirTemplate): string {
    const fragmentsHtml = memoir.fragments
      .map((f) => this.renderFragmentHtml(f))
      .join('\n');

    const traitsHtml = memoir.personalityReport.traits
      .map((t) => `<span class="trait-tag">${t}</span>`)
      .join('\n');

    const statisticsHtml = `
      <div class="statistics">
        <div class="stat-item">
          <span class="stat-value">${memoir.personalityReport.statistics.totalDays}</span>
          <span class="stat-label">天</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${memoir.personalityReport.statistics.totalNodes}</span>
          <span class="stat-label">地点</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${memoir.personalityReport.statistics.totalPhotos}</span>
          <span class="stat-label">照片</span>
        </div>
      </div>
    `;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${memoir.title}</title>
  <link rel="stylesheet" href="/templates/${template.id}.css">
  <link rel="stylesheet" href="/templates/template-base.css">
</head>
<body class="${template.cssClass}">
  <div class="memoir-container">
    <!-- Cover Page -->
    <section class="cover-page">
      <img src="${memoir.coverImageUrl}" alt="封面" class="cover-image">
      <h1 class="memoir-title">${memoir.title}</h1>
      <p class="memoir-date">${this.formatDate(memoir.generatedAt)}</p>
    </section>

    <!-- Diary Fragments -->
    <section class="diary-section">
      ${fragmentsHtml}
    </section>

    <!-- Personality Report Page -->
    <section class="personality-page">
      <h2 class="personality-title">${memoir.personalityReport.title}</h2>
      <p class="personality-description">${memoir.personalityReport.description}</p>
      <div class="personality-traits">
        ${traitsHtml}
      </div>
      ${statisticsHtml}
    </section>

    <!-- End Page -->
    <section class="end-page">
      <img src="${memoir.endImageUrl}" alt="尾图" class="end-image">
      <p class="end-message">旅途的终点，是下一段旅程的起点</p>
    </section>
  </div>
</body>
</html>`;
  }

  /**
   * Render a single diary fragment as HTML
   */
  private renderFragmentHtml(fragment: DiaryFragment): string {
    const moodHtml = fragment.moodEmoji
      ? `<span class="fragment-mood">${fragment.moodEmoji}</span>`
      : '';

    return `
    <article class="diary-fragment" data-fragment-id="${fragment.id}">
      <header class="fragment-header">
        <span class="fragment-time">${fragment.timeRange}</span>
        ${moodHtml}
      </header>
      <div class="fragment-content">
        <p>${fragment.content}</p>
      </div>
    </article>`;
  }

  /**
   * Format date for display
   */
  private formatDate(date: Date): string {
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Generate share URL for memoir
   * Requirements: 6.6
   */
  async generateShareUrl(memoirId: string): Promise<string> {
    // Generate a unique share token
    const shareToken = uuidv4().replace(/-/g, '').substring(0, 12);
    const shareUrl = `/share/memoir/${shareToken}`;

    // Update memoir with share URL
    const stmt = this.db.prepare(`
      UPDATE travel_memoirs SET share_url = ? WHERE id = ?
    `);
    stmt.run(shareUrl, memoirId);

    return shareUrl;
  }
}

// Export singleton instance
export const memoirService = new MemoirService();
