import { Router } from 'express';
import visionRoutes from './visionRoutes';
import destinationRoutes from './destinationRoutes';
import itineraryRoutes from './itineraryRoutes';
import diaryRoutes from './diaryRoutes';
import memoirRoutes from './memoirRoutes';
import tripRoutes from './tripRoutes';

const router = Router();

// Vision analysis routes
router.use('/vision', visionRoutes);

// Destination recommendation routes
router.use('/destinations', destinationRoutes);

// Itinerary/Trip routes
router.use('/trips', itineraryRoutes);

// Trip routes (includes users/:userId/trips and trips/:tripId)
router.use('/', tripRoutes);

// Diary routes (includes trips/:tripId/nodes/:nodeId/* and diary-fragments/*)
router.use('/', diaryRoutes);

// Memoir routes (includes trips/:tripId/complete, trips/:tripId/memoir, memoir-templates)
router.use('/', memoirRoutes);

export default router;
