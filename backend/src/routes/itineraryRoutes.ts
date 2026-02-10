import { Router, Request, Response, NextFunction } from 'express';
import { itineraryService, ChatHistoryMessage } from '../services/itineraryService';
import { storageService, TravelNode } from '../services/storageService';

const router = Router();

interface ChatRequest {
  message: string;
  chatHistory?: ChatHistoryMessage[];
}

interface GenerateRequest {
  conditions: {
    geographicFeatures?: string[];
    climatePreference?: string;
    foodPreferences?: string[];
    activityTypes?: string[];
    budgetLevel?: string;
    travelStyle?: string;
    startDate?: string;
    totalDays?: number;
    arrivalTime?: string;
    departureTime?: string;
  };
  days: number;
}

/**
 * Validates tripId parameter
 */
function validateTripId(req: Request, res: Response, next: NextFunction): void {
  const { tripId } = req.params;

  if (!tripId || typeof tripId !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的tripId参数',
    });
    return;
  }

  next();
}

/**
 * Validates nodeId parameter
 */
function validateNodeId(req: Request, res: Response, next: NextFunction): void {
  const { nodeId } = req.params;

  if (!nodeId || typeof nodeId !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的nodeId参数',
    });
    return;
  }

  next();
}


/**
 * GET /api/trips/:tripId/itinerary
 * Gets the itinerary for a trip
 * Requirements: 3.2
 */
router.get('/:tripId/itinerary', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    const itinerary = await itineraryService.getItinerary(tripId);
    
    console.log('GET itinerary - tripId:', tripId);
    console.log('GET itinerary - found:', !!itinerary);
    console.log('GET itinerary - nodes count:', itinerary?.nodes?.length);

    if (!itinerary) {
      res.status(404).json({
        success: false,
        error: '未找到该旅程的行程安排',
      });
      return;
    }

    res.json({
      success: true,
      itinerary,
    });
  } catch (error) {
    console.error('Get itinerary error:', error);
    res.status(500).json({
      success: false,
      error: '获取行程失败，请稍后重试',
    });
  }
});

/**
 * POST /api/trips/:tripId/itinerary/generate
 * Generates a new itinerary for a trip
 * Requirements: 3.2, 3.6
 */
router.post('/:tripId/itinerary/generate', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;
    const { conditions, days } = req.body as GenerateRequest;

    if (!conditions) {
      res.status(400).json({
        success: false,
        error: '请求缺少必要的conditions字段',
      });
      return;
    }

    if (!days || typeof days !== 'number' || days < 1) {
      res.status(400).json({
        success: false,
        error: '请提供有效的旅行天数',
      });
      return;
    }

    // Get trip to get destination
    const trip = await storageService.getTrip(tripId);
    if (!trip) {
      res.status(404).json({
        success: false,
        error: '未找到该旅程',
      });
      return;
    }

    if (!trip.destination) {
      res.status(400).json({
        success: false,
        error: '请先选择目的地',
      });
      return;
    }

    const itinerary = await itineraryService.generateItinerary(
      tripId,
      trip.destination,
      {
        geographicFeatures: conditions.geographicFeatures || [],
        climatePreference: conditions.climatePreference || '',
        foodPreferences: conditions.foodPreferences || [],
        activityTypes: conditions.activityTypes || [],
        budgetLevel: conditions.budgetLevel,
        travelStyle: conditions.travelStyle,
        startDate: conditions.startDate,
        totalDays: conditions.totalDays,
        arrivalTime: conditions.arrivalTime,
        departureTime: conditions.departureTime,
      },
      days
    );

    console.log('Generate result:', {
      id: itinerary?.id,
      nodesCount: itinerary?.nodes?.length,
      firstNode: itinerary?.nodes?.[0]?.name,
      totalDays: itinerary?.totalDays,
      startDate: itinerary?.startDate,
    });

    res.json({
      success: true,
      itinerary,
    });
  } catch (error) {
    console.error('Generate itinerary error:', error);
    res.status(500).json({
      success: false,
      error: '生成行程失败，请稍后重试',
    });
  }
});


/**
 * POST /api/trips/:tripId/itinerary/chat
 * Updates itinerary through natural language conversation
 * Requirements: 3.2, 3.3
 */
router.post('/:tripId/itinerary/chat', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;
    const { message, chatHistory } = req.body as ChatRequest;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: '请输入您的需求',
      });
      return;
    }

    let itinerary = await itineraryService.getItinerary(tripId);
    console.log('Chat - loaded itinerary:', {
      id: itinerary?.id,
      nodesCount: itinerary?.nodes?.length,
      totalDays: itinerary?.totalDays,
      destination: itinerary?.destination,
      firstNode: itinerary?.nodes?.[0]?.name,
    });
    
    // 如果行程不存在或节点为空，先生成行程
    if (!itinerary || !itinerary.nodes || itinerary.nodes.length === 0) {
      console.log('Itinerary is empty, generating first...');
      
      // 获取 trip 信息
      const trip = await storageService.getTrip(tripId);
      if (!trip) {
        res.status(404).json({
          success: false,
          error: '未找到该旅程',
        });
        return;
      }

      if (!trip.destination) {
        res.status(400).json({
          success: false,
          error: '请先选择目的地',
        });
        return;
      }

      // 使用默认条件生成行程
      const conditions = trip.searchConditions || {
        geographicFeatures: [],
        climatePreference: '',
        foodPreferences: [],
        activityTypes: [],
      };

      itinerary = await itineraryService.generateItinerary(
        tripId,
        trip.destination,
        conditions,
        conditions.totalDays || 3 // 使用用户选择的天数，默认3天
      );
      
      console.log('Generated itinerary:', {
        id: itinerary?.id,
        nodesCount: itinerary?.nodes?.length,
      });
    }

    const result = await itineraryService.updateWithPreference(
      itinerary,
      message.trim(),
      chatHistory || []
    );

    console.log('Chat result - itinerary id:', result.itinerary?.id);
    console.log('Chat result - nodes count:', result.itinerary?.nodes?.length);
    console.log('Chat result - totalDays:', result.itinerary?.totalDays);
    console.log('Chat result - first node:', result.itinerary?.nodes?.[0]?.name);

    // 确保返回完整的 itinerary 数据
    const responseItinerary = {
      ...result.itinerary,
      nodes: result.itinerary.nodes || [],
    };

    res.json({
      success: true,
      itinerary: responseItinerary,
      response: result.response,
    });
  } catch (error) {
    console.error('Chat update error:', error);
    res.status(500).json({
      success: false,
      error: '更新行程失败，请稍后重试',
    });
  }
});

/**
 * PUT /api/trips/:tripId/itinerary/nodes/:nodeId
 * Manually updates a specific node
 * Requirements: 3.5
 */
router.put(
  '/:tripId/itinerary/nodes/:nodeId',
  validateTripId,
  validateNodeId,
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;
      const updates = req.body as Partial<TravelNode>;

      // Validate that there are updates to apply
      if (!updates || Object.keys(updates).length === 0) {
        res.status(400).json({
          success: false,
          error: '请提供要更新的内容',
        });
        return;
      }

      // Prevent updating protected fields
      delete updates.id;
      delete updates.itineraryId;

      const updatedNode = await itineraryService.manualUpdateNode(tripId, nodeId, updates);

      if (!updatedNode) {
        res.status(404).json({
          success: false,
          error: '未找到该节点或行程',
        });
        return;
      }

      res.json({
        success: true,
        node: updatedNode,
      });
    } catch (error) {
      console.error('Update node error:', error);
      res.status(500).json({
        success: false,
        error: '更新节点失败，请稍后重试',
      });
    }
  }
);


/**
 * POST /api/trips/:tripId/itinerary/nodes/:nodeId/verify
 * Verifies a node's authenticity using Tavily
 * Requirements: 3.3
 */
router.post(
  '/:tripId/itinerary/nodes/:nodeId/verify',
  validateTripId,
  validateNodeId,
  async (req: Request, res: Response) => {
    try {
      const { tripId, nodeId } = req.params;

      const itinerary = await itineraryService.getItinerary(tripId);
      if (!itinerary) {
        res.status(404).json({
          success: false,
          error: '未找到该旅程的行程安排',
        });
        return;
      }

      const node = itinerary.nodes.find((n) => n.id === nodeId);
      if (!node) {
        res.status(404).json({
          success: false,
          error: '未找到该节点',
        });
        return;
      }

      // Verify the node
      const verifiedNode = await itineraryService.verifyNode(node, itinerary.destination);

      // Update the node in the itinerary
      const updatedNode = await itineraryService.manualUpdateNode(tripId, nodeId, {
        verified: verifiedNode.verified,
        verificationInfo: verifiedNode.verificationInfo,
      });

      res.json({
        success: true,
        node: updatedNode || verifiedNode,
      });
    } catch (error) {
      console.error('Verify node error:', error);
      res.status(500).json({
        success: false,
        error: '验证节点失败，请稍后重试',
      });
    }
  }
);

export default router;
