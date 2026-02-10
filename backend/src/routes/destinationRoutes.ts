import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { destinationService, CitySearchResult } from '../services/destinationService';
import { storageService, SearchConditions } from '../services/storageService';

const router = Router();

interface SearchCitiesRequest {
  query: string;
}

interface DirectSelectRequest {
  userId: string;
  cityName: string;
  startDate?: string;
  totalDays?: number;
  arrivalTime?: string;
  departureTime?: string;
}

interface RecommendRequest {
  conditions: SearchConditions;
  excludedCities?: string[];
}

interface SelectRequest {
  userId: string;
  visionText: string;
  destination: string;
  conditions: SearchConditions;
}

/**
 * Validates the recommend request
 */
function validateRecommendRequest(req: Request, res: Response, next: NextFunction): void {
  const { conditions } = req.body as RecommendRequest;

  if (!conditions) {
    res.status(400).json({
      success: false,
      error: '请求缺少必要的conditions字段',
    });
    return;
  }

  // Validate conditions structure
  if (typeof conditions !== 'object') {
    res.status(400).json({
      success: false,
      error: 'conditions必须是一个对象',
    });
    return;
  }

  next();
}

/**
 * Validates the select request
 */
function validateSelectRequest(req: Request, res: Response, next: NextFunction): void {
  const { userId, visionText, destination, conditions } = req.body as SelectRequest;

  if (!userId || typeof userId !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的userId字段',
    });
    return;
  }

  if (!visionText || typeof visionText !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的visionText字段',
    });
    return;
  }

  if (!destination || typeof destination !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的destination字段',
    });
    return;
  }

  if (!conditions || typeof conditions !== 'object') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的conditions字段',
    });
    return;
  }

  next();
}

/**
 * POST /api/destinations/recommend
 * Recommends destinations based on search conditions
 */
router.post('/recommend', validateRecommendRequest, async (req: Request, res: Response) => {
  try {
    const { conditions, excludedCities } = req.body as RecommendRequest;

    const result = await destinationService.recommendDestinations(
      conditions,
      excludedCities || []
    );

    if (result.success) {
      res.json({
        success: true,
        destinations: result.destinations,
        excludedCities: result.excludedCities,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.errorMessage,
      });
    }
  } catch (error) {
    console.error('Destination recommendation error:', error);
    res.status(500).json({
      success: false,
      error: '推荐服务暂时不可用，请稍后重试',
    });
  }
});

/**
 * POST /api/destinations/select
 * Selects a destination and creates a trip
 */
router.post('/select', validateSelectRequest, async (req: Request, res: Response) => {
  try {
    const { userId, visionText, destination, conditions } = req.body as SelectRequest;

    console.log('Select destination - conditions received:', {
      startDate: conditions.startDate,
      totalDays: conditions.totalDays,
      arrivalTime: conditions.arrivalTime,
      departureTime: conditions.departureTime,
    });

    // Create a new trip
    const trip = await storageService.createTrip(userId, visionText);

    // Update trip with destination and search conditions
    const updatedTrip = await storageService.updateTrip(trip.id, {
      destination,
      searchConditions: conditions,
    });

    if (!updatedTrip) {
      res.status(500).json({
        success: false,
        error: '创建旅程失败，请稍后重试',
      });
      return;
    }

    // Create initial empty itinerary with startDate and totalDays from conditions
    const itinerary = {
      id: uuidv4(),
      tripId: updatedTrip.id,
      destination,
      totalDays: conditions.totalDays || 3, // 使用用户选择的天数，默认3天
      startDate: conditions.startDate, // 使用用户选择的开始日期
      nodes: [],
      userPreferences: [],
      lastUpdated: new Date(),
    };

    await storageService.saveItinerary(itinerary);

    res.json({
      success: true,
      trip: updatedTrip,
      itinerary,
    });
  } catch (error) {
    console.error('Destination selection error:', error);
    res.status(500).json({
      success: false,
      error: '选择目的地失败，请稍后重试',
    });
  }
});

/**
 * GET /api/destinations/search
 * Search cities by name
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;

    if (!query || query.trim().length < 1) {
      res.json({
        success: true,
        cities: [],
      });
      return;
    }

    const cities = await destinationService.searchCities(query);

    res.json({
      success: true,
      cities,
    });
  } catch (error) {
    console.error('City search error:', error);
    res.status(500).json({
      success: false,
      error: '搜索城市失败，请稍后重试',
    });
  }
});

/**
 * POST /api/destinations/direct-select
 * Directly select a city without vision analysis
 */
router.post('/direct-select', async (req: Request, res: Response) => {
  try {
    const { userId, cityName, startDate, totalDays, arrivalTime, departureTime } = req.body as DirectSelectRequest;

    if (!userId || !cityName) {
      res.status(400).json({
        success: false,
        error: '请求缺少必要参数',
      });
      return;
    }

    // Get city details
    const cityDetails = await destinationService.getCityDetails(cityName);

    if (!cityDetails) {
      res.status(400).json({
        success: false,
        error: '无法获取城市信息，请确认城市名称正确',
      });
      return;
    }

    // Create a trip with direct selection
    const visionText = `直接选择目的地：${cityName}`;
    const trip = await storageService.createTrip(userId, visionText);

    // Create minimal search conditions for direct selection
    const conditions: SearchConditions = {
      geographicFeatures: [],
      climatePreference: '',
      foodPreferences: [],
      activityTypes: [],
      budgetLevel: '',
      travelStyle: '',
      startDate,
      totalDays: totalDays || 3,
      arrivalTime,
      departureTime,
    };

    // Update trip with destination
    const updatedTrip = await storageService.updateTrip(trip.id, {
      destination: cityName,
      searchConditions: conditions,
    });

    if (!updatedTrip) {
      res.status(500).json({
        success: false,
        error: '创建旅程失败，请稍后重试',
      });
      return;
    }

    // Create initial empty itinerary
    const itinerary = {
      id: uuidv4(),
      tripId: updatedTrip.id,
      destination: cityName,
      totalDays: totalDays || 3,
      startDate,
      nodes: [],
      userPreferences: [],
      lastUpdated: new Date(),
    };

    await storageService.saveItinerary(itinerary);

    res.json({
      success: true,
      trip: updatedTrip,
      itinerary,
      cityDetails,
    });
  } catch (error) {
    console.error('Direct selection error:', error);
    res.status(500).json({
      success: false,
      error: '选择目的地失败，请稍后重试',
    });
  }
});

export default router;
