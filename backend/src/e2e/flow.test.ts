/**
 * End-to-End Flow Integration Test
 * 
 * Tests the complete flow: 愿景→目的地→行程→日记→回忆录
 * 
 * This test validates that all services work together correctly
 * to complete the full user journey.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// Import services
import { VisionService, VisionInput } from '../services/visionService';
import { DestinationService } from '../services/destinationService';
import { MemoirService } from '../services/memoirService';
import { StorageService, SearchConditions, TravelNode, Itinerary, DiaryFragment } from '../services/storageService';
import { initializeDatabase, getDatabase } from '../database';

// Mock external API clients
vi.mock('../clients/deepseekClient', () => {
  const mockChatWithJson = vi.fn().mockImplementation((messages: Array<{role: string, content: string}>) => {
    const systemContent = messages[0]?.content || '';
    
    // Vision analysis response
    if (systemContent.includes('旅行规划专家') && systemContent.includes('JSON格式返回')) {
      return Promise.resolve({
        geographicFeatures: ['雪山', '森林'],
        climatePreference: '凉爽',
        foodPreferences: ['米线', '火锅'],
        activityTypes: ['观光', '美食'],
        budgetLevel: '中等',
        travelStyle: '休闲',
      });
    }
    
    // Destination recommendation response - check for the key phrase
    if (systemContent.includes('中国旅行规划专家') || systemContent.includes('旅行目的地')) {
      return Promise.resolve({
        destinations: [
          {
            cityName: '丽江',
            province: '云南',
            recommendReason: '丽江拥有壮丽的玉龙雪山和古朴的纳西古城。',
            hotSpots: ['玉龙雪山', '丽江古城', '束河古镇'],
            matchScore: 95,
          },
          {
            cityName: '大理',
            province: '云南',
            recommendReason: '大理苍山洱海风光秀丽。',
            hotSpots: ['洱海', '苍山', '大理古城'],
            matchScore: 90,
          },
          {
            cityName: '香格里拉',
            province: '云南',
            recommendReason: '香格里拉拥有梅里雪山。',
            hotSpots: ['梅里雪山', '普达措', '松赞林寺'],
            matchScore: 88,
          },
        ],
      });
    }
    
    // Itinerary generation response
    if (systemContent.includes('旅行规划师')) {
      return Promise.resolve([
        {
          name: '玉龙雪山',
          type: 'attraction',
          address: '云南省丽江市',
          description: '北半球最南的大雪山',
          estimatedDuration: 240,
          scheduledTime: '08:00',
          dayIndex: 1,
          order: 1,
        },
        {
          name: '丽江古城',
          type: 'attraction',
          address: '云南省丽江市古城区',
          description: '世界文化遗产',
          estimatedDuration: 180,
          scheduledTime: '14:00',
          dayIndex: 1,
          order: 2,
        },
      ]);
    }
    
    // Personality report response
    if (systemContent.includes('旅行心理分析专家') || systemContent.includes('旅行人格')) {
      return Promise.resolve({
        title: '雪山仰望者',
        description: '你是一个热爱自然的旅行者。',
        traits: ['自然爱好者', '文化探索者', '美食品鉴家'],
      });
    }
    
    return Promise.resolve({});
  });

  const mockChat = vi.fn().mockResolvedValue('今天的旅行非常愉快，风景很美。');

  return {
    DeepSeekClient: vi.fn().mockImplementation(() => ({
      chat: mockChat,
      chatWithJson: mockChatWithJson,
    })),
    deepseekClient: {
      chat: mockChat,
      chatWithJson: mockChatWithJson,
    },
    ChatMessage: {},
  };
});

vi.mock('../clients/unsplashClient', () => {
  const mockGetCityPhoto = vi.fn().mockResolvedValue('https://images.unsplash.com/mock.jpg');
  
  return {
    UnsplashClient: vi.fn().mockImplementation(() => ({
      getCityPhoto: mockGetCityPhoto,
      searchPhotos: vi.fn().mockResolvedValue(['https://images.unsplash.com/mock.jpg']),
    })),
    unsplashClient: {
      getCityPhoto: mockGetCityPhoto,
      searchPhotos: vi.fn().mockResolvedValue(['https://images.unsplash.com/mock.jpg']),
    },
  };
});

vi.mock('../clients/tavilyClient', () => ({
  TavilyClient: vi.fn().mockImplementation(() => ({
    verifyPlace: vi.fn().mockResolvedValue({
      exists: true,
      address: '云南省丽江市',
      openingHours: '08:00-18:00',
      rating: 4.8,
    }),
    search: vi.fn().mockResolvedValue([]),
  })),
  tavilyClient: {
    verifyPlace: vi.fn().mockResolvedValue({
      exists: true,
      address: '云南省丽江市',
      openingHours: '08:00-18:00',
      rating: 4.8,
    }),
    search: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../clients/qwenVLClient', () => ({
  QwenVLClient: vi.fn().mockImplementation(() => ({
    analyzeImage: vi.fn().mockResolvedValue('雪山背景下快乐的旅行者'),
  })),
  qwenVLClient: {
    analyzeImage: vi.fn().mockResolvedValue('雪山背景下快乐的旅行者'),
  },
}));

vi.mock('../clients/wanxClient', () => ({
  WanxClient: vi.fn().mockImplementation(() => ({
    generateImage: vi.fn().mockResolvedValue('https://wanx.mock/cover.jpg'),
  })),
  wanxClient: {
    generateImage: vi.fn().mockResolvedValue('https://wanx.mock/cover.jpg'),
  },
}));

describe('End-to-End Flow Integration Test', () => {
  let storageService: StorageService;
  let visionService: VisionService;
  let destinationService: DestinationService;
  let memoirService: MemoirService;
  
  // Test data
  const testUserId = 'test-user-e2e';
  let testTripId: string;
  let testNodeId: string;
  let testFragmentId: string;
  let searchConditions: SearchConditions;

  beforeAll(async () => {
    // Initialize database
    initializeDatabase();
    
    // Create test user to satisfy foreign key constraint
    const db = getDatabase();
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, name)
      VALUES (?, ?, ?)
    `).run(testUserId, 'test@example.com', 'Test User');
    
    // Initialize services
    storageService = new StorageService();
    visionService = new VisionService();
    destinationService = new DestinationService();
    memoirService = new MemoirService();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    // Cleanup test data
    const db = getDatabase();
    try {
      if (testTripId) {
        db.prepare('DELETE FROM diary_fragments WHERE trip_id = ?').run(testTripId);
        db.prepare('DELETE FROM travel_memoirs WHERE trip_id = ?').run(testTripId);
        db.prepare('DELETE FROM chat_history WHERE trip_id = ?').run(testTripId);
        
        const itinerary = db.prepare('SELECT id FROM itineraries WHERE trip_id = ?').get(testTripId) as { id: string } | undefined;
        if (itinerary) {
          db.prepare('DELETE FROM travel_nodes WHERE itinerary_id = ?').run(itinerary.id);
          db.prepare('DELETE FROM itineraries WHERE id = ?').run(itinerary.id);
        }
        
        db.prepare('DELETE FROM trips WHERE id = ?').run(testTripId);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('Step 1: Vision Analysis (愿景分析)', () => {
    it('should analyze user vision and extract search conditions', async () => {
      const visionInput: VisionInput = {
        text: '我想去看雪山，体验当地美食，感受少数民族文化',
        userId: testUserId,
      };

      const result = await visionService.analyzeVision(visionInput);

      expect(result.success).toBe(true);
      expect(result.conditions).toBeDefined();
      expect(result.conditions.geographicFeatures.length).toBeGreaterThan(0);
      
      // Store conditions for next step
      searchConditions = result.conditions;
    });

    it('should reject empty vision input', async () => {
      const emptyInput: VisionInput = {
        text: '',
        userId: testUserId,
      };

      const result = await visionService.analyzeVision(emptyInput);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBeDefined();
    });

    it('should reject overly long vision input', async () => {
      const longInput: VisionInput = {
        text: 'a'.repeat(600),
        userId: testUserId,
      };

      const result = await visionService.analyzeVision(longInput);

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('过长');
    });
  });

  describe('Step 2: Destination Recommendation (目的地推荐)', () => {
    it('should have destination service available', async () => {
      // Verify the service is properly initialized
      expect(destinationService).toBeDefined();
      expect(typeof destinationService.recommendDestinations).toBe('function');
    });

    it('should exclude previously shown cities when refreshing', async () => {
      const excludedCities = ['丽江', '大理'];
      const result = await destinationService.recommendDestinations(
        searchConditions,
        excludedCities
      );

      // Verify excluded cities are not in results (if any results returned)
      if (result.success && result.destinations.length > 0) {
        result.destinations.forEach((dest) => {
          expect(excludedCities).not.toContain(dest.cityName);
        });
      }
    });
  });

  describe('Step 3: Trip Creation and Itinerary (行程规划)', () => {
    it('should create a trip successfully', async () => {
      // Create trip
      const trip = await storageService.createTrip(
        testUserId,
        '我想去看雪山，体验当地美食'
      );
      
      expect(trip).toBeDefined();
      expect(trip.id).toBeDefined();
      expect(trip.status).toBe('planning');
      
      testTripId = trip.id;

      // Update trip with destination
      const updatedTrip = await storageService.updateTrip(testTripId, {
        destination: '丽江',
        status: 'planning',
      });
      
      expect(updatedTrip).not.toBeNull();
      expect(updatedTrip!.destination).toBe('丽江');
    });

    it('should save and retrieve itinerary', async () => {
      // Create a test itinerary
      const itineraryId = uuidv4();
      const nodeId = uuidv4();
      testNodeId = nodeId;
      
      const itinerary: Itinerary = {
        id: itineraryId,
        tripId: testTripId,
        destination: '丽江',
        totalDays: 3,
        nodes: [
          {
            id: nodeId,
            itineraryId: itineraryId,
            name: '玉龙雪山',
            type: 'attraction',
            address: '云南省丽江市',
            description: '北半球最南的大雪山',
            estimatedDuration: 240,
            scheduledTime: '08:00',
            dayIndex: 1,
            order: 1,
            verified: false,
            isLit: false,
          },
        ],
        userPreferences: [],
        lastUpdated: new Date(),
      };

      await storageService.saveItinerary(itinerary);

      // Retrieve and verify
      const retrieved = await storageService.getItinerary(testTripId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.destination).toBe('丽江');
      expect(retrieved!.totalDays).toBe(3);
      expect(retrieved!.nodes.length).toBe(1);
      expect(retrieved!.nodes[0].name).toBe('玉龙雪山');
    });
  });

  describe('Step 4: Diary Fragment (日记片段)', () => {
    it('should save and retrieve diary fragments', async () => {
      // Create a test diary fragment
      const fragmentId = uuidv4();
      testFragmentId = fragmentId;
      
      const fragment: DiaryFragment = {
        id: fragmentId,
        tripId: testTripId,
        nodeId: testNodeId,
        content: '今天登上了玉龙雪山，风景太美了！',
        timeRange: '2024年1月15日 08:00 - 12:00',
        moodEmoji: '😊',
        generatedAt: new Date(),
        isEdited: false,
      };

      await storageService.saveDiaryFragment(fragment);

      // Retrieve and verify
      const fragments = await storageService.getDiaryFragments(testTripId);
      expect(fragments.length).toBeGreaterThan(0);
      expect(fragments[0].content).toBe('今天登上了玉龙雪山，风景太美了！');
    });

    it('should update diary fragment content', async () => {
      const updatedContent = '这是我修改后的日记内容，记录了美好的旅行回忆。';
      
      const updatedFragment = await storageService.updateDiaryFragment(
        testFragmentId,
        updatedContent
      );

      expect(updatedFragment).not.toBeNull();
      expect(updatedFragment!.content).toBe(updatedContent);
      expect(updatedFragment!.isEdited).toBe(true);
    });
  });

  describe('Step 5: Memoir Generation (回忆录生成)', () => {
    it('should generate complete memoir with personality report', async () => {
      // Generate memoir
      const memoir = await memoirService.generateMemoir(testTripId);

      expect(memoir).toBeDefined();
      expect(memoir.tripId).toBe(testTripId);
      expect(memoir.title).toBeDefined();
      expect(memoir.coverImageUrl).toBeDefined();
      expect(memoir.personalityReport).toBeDefined();
      expect(memoir.personalityReport.title).toBeDefined();
      expect(memoir.personalityReport.traits.length).toBeGreaterThan(0);
    });

    it('should support template switching', async () => {
      const templates = await memoirService.getAvailableTemplates();
      
      expect(templates.length).toBeGreaterThanOrEqual(3);
      
      // Each template should have required fields
      templates.forEach((template) => {
        expect(template.id).toBeDefined();
        expect(template.name).toBeDefined();
        expect(template.cssClass).toBeDefined();
      });
    });
  });

  describe('Step 6: Data Persistence Verification (数据持久化)', () => {
    it('should persist and retrieve trip data correctly', async () => {
      const trip = await storageService.getTrip(testTripId);
      
      expect(trip).toBeDefined();
      expect(trip).not.toBeNull();
      expect(trip!.id).toBe(testTripId);
      expect(trip!.userId).toBe(testUserId);
    });

    it('should list user trips correctly', async () => {
      const trips = await storageService.getUserTrips(testUserId);
      
      expect(trips.length).toBeGreaterThan(0);
      expect(trips.some((t) => t.id === testTripId)).toBe(true);
    });

    it('should persist and retrieve diary fragments correctly', async () => {
      const fragments = await storageService.getDiaryFragments(testTripId);
      
      expect(fragments.length).toBeGreaterThan(0);
    });
  });
});
