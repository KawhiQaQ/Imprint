import { Router, Request, Response, NextFunction } from 'express';
import { storageService } from '../services/storageService';

const router = Router();

/**
 * Validates userId parameter
 */
function validateUserId(req: Request, res: Response, next: NextFunction): void {
  const { userId } = req.params;

  if (!userId || typeof userId !== 'string') {
    res.status(400).json({
      success: false,
      error: '请求缺少有效的userId参数',
    });
    return;
  }

  next();
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
 * GET /api/users/:userId/trips
 * Gets all trips for a user
 * Requirements: 8.3, 8.4
 */
router.get('/users/:userId/trips', validateUserId, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const trips = await storageService.getUserTrips(userId);

    res.json(trips);
  } catch (error) {
    console.error('Get user trips error:', error);
    res.status(500).json({
      success: false,
      error: '获取旅程列表失败，请稍后重试',
    });
  }
});

/**
 * GET /api/trips/:tripId
 * Gets a single trip by ID
 * Requirements: 8.3
 */
router.get('/trips/:tripId', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    const trip = await storageService.getTrip(tripId);

    if (!trip) {
      res.status(404).json({
        success: false,
        error: '未找到该旅程',
      });
      return;
    }

    res.json(trip);
  } catch (error) {
    console.error('Get trip error:', error);
    res.status(500).json({
      success: false,
      error: '获取旅程失败，请稍后重试',
    });
  }
});

/**
 * DELETE /api/trips/:tripId
 * Deletes a trip and all associated data
 */
router.delete('/trips/:tripId', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    const trip = await storageService.getTrip(tripId);

    if (!trip) {
      res.status(404).json({
        success: false,
        error: '未找到该旅程',
      });
      return;
    }

    await storageService.deleteTrip(tripId);

    res.json({
      success: true,
      message: '旅程已删除',
    });
  } catch (error) {
    console.error('Delete trip error:', error);
    res.status(500).json({
      success: false,
      error: '删除旅程失败，请稍后重试',
    });
  }
});

/**
 * POST /api/trips/batch-delete
 * Batch delete multiple trips
 */
router.post('/trips/batch-delete', async (req: Request, res: Response) => {
  try {
    const { tripIds } = req.body;

    if (!Array.isArray(tripIds) || tripIds.length === 0) {
      res.status(400).json({
        success: false,
        error: '请提供要删除的旅程ID列表',
      });
      return;
    }

    let deletedCount = 0;
    for (const tripId of tripIds) {
      try {
        await storageService.deleteTrip(tripId);
        deletedCount++;
      } catch (err) {
        console.error(`Failed to delete trip ${tripId}:`, err);
      }
    }

    res.json({
      success: true,
      deletedCount,
      message: `成功删除 ${deletedCount} 个旅程`,
    });
  } catch (error) {
    console.error('Batch delete trips error:', error);
    res.status(500).json({
      success: false,
      error: '批量删除失败，请稍后重试',
    });
  }
});

/**
 * POST /api/trips/:tripId/save-to-shelf
 * Save a trip to the bookshelf (mark as saved)
 */
router.post('/trips/:tripId/save-to-shelf', validateTripId, async (req: Request, res: Response) => {
  try {
    const { tripId } = req.params;

    const trip = await storageService.getTrip(tripId);

    if (!trip) {
      res.status(404).json({
        success: false,
        error: '未找到该旅程',
      });
      return;
    }

    // Update trip to mark as saved and change status to traveling
    const updatedTrip = await storageService.updateTrip(tripId, {
      isSavedToShelf: true,
      status: 'traveling',
    });

    res.json({
      success: true,
      trip: updatedTrip,
      message: '迹录已保存到书架',
    });
  } catch (error) {
    console.error('Save to shelf error:', error);
    res.status(500).json({
      success: false,
      error: '保存失败，请稍后重试',
    });
  }
});

export default router;
