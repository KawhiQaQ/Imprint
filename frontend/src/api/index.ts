import apiClient from './client';
import { API_BASE_URL } from './client';
import type {
  VisionAnalysisResult,
  DestinationRecommendation,
  SearchConditions,
  Trip,
  Itinerary,
  TravelNode,
  DiaryFragment,
  PhotoMaterial,
  VoiceRecording,
  TravelMemoir,
  MemoirTemplate,
  CitySearchResult,
  DestinationCard,
} from '../types';

// Vision API
export const visionApi = {
  analyze: (text: string) =>
    apiClient.post<VisionAnalysisResult>('/vision/analyze', { text }),
};

// Destination API
export const destinationApi = {
  recommend: (conditions: SearchConditions, excludedCities?: string[]) =>
    apiClient.post<DestinationRecommendation>('/destinations/recommend', {
      conditions,
      excludedCities,
    }),
  select: (userId: string, visionText: string, destination: string, conditions: SearchConditions) =>
    apiClient.post<{ trip: Trip; itinerary: Itinerary }>('/destinations/select', {
      userId,
      visionText,
      destination,
      conditions,
    }),
  searchCities: (query: string) =>
    apiClient.get<{ success: boolean; cities: CitySearchResult[] }>('/destinations/search', {
      params: { q: query },
    }),
  directSelect: (
    userId: string,
    cityName: string,
    options?: {
      startDate?: string;
      totalDays?: number;
      arrivalTime?: string;
      departureTime?: string;
    }
  ) =>
    apiClient.post<{ trip: Trip; itinerary: Itinerary; cityDetails: DestinationCard }>(
      '/destinations/direct-select',
      {
        userId,
        cityName,
        ...options,
      }
    ),
};

// Itinerary API
export const itineraryApi = {
  get: (tripId: string) =>
    apiClient.get<Itinerary>(`/trips/${tripId}/itinerary`),
  generate: (tripId: string, conditions: SearchConditions, days: number) =>
    apiClient.post<{ itinerary: Itinerary }>(`/trips/${tripId}/itinerary/generate`, {
      conditions,
      days,
    }),
  chat: (tripId: string, message: string, chatHistory?: Array<{ role: string; content: string }>) =>
    apiClient.post<{ itinerary: Itinerary; response: string }>(
      `/trips/${tripId}/itinerary/chat`,
      { message, chatHistory: chatHistory || [] }
    ),
  updateNode: (tripId: string, nodeId: string, updates: Partial<TravelNode>) =>
    apiClient.put<TravelNode>(`/trips/${tripId}/itinerary/nodes/${nodeId}`, updates),
  verifyNode: (tripId: string, nodeId: string) =>
    apiClient.post<TravelNode>(`/trips/${tripId}/itinerary/nodes/${nodeId}/verify`),
};

// Diary API
export const diaryApi = {
  uploadPhoto: (tripId: string, nodeId: string, file: File) => {
    const formData = new FormData();
    formData.append('photo', file);
    return apiClient.post<{ photo: PhotoMaterial }>(
      `/trips/${tripId}/nodes/${nodeId}/photos`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    );
  },
  uploadVoice: (tripId: string, nodeId: string, file: Blob) => {
    const formData = new FormData();
    formData.append('voice', file);
    return apiClient.post<{ voice: VoiceRecording }>(
      `/trips/${tripId}/nodes/${nodeId}/voice`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    );
  },
  saveTextNote: (tripId: string, nodeId: string, text: string) =>
    apiClient.post<{ success: boolean }>(`/trips/${tripId}/nodes/${nodeId}/text`, { text }),
  lightNode: (tripId: string, nodeId: string, textNotes?: string[], weather?: string, timeRange?: string, mood?: string) =>
    apiClient.post<{ fragment: DiaryFragment }>(`/trips/${tripId}/nodes/${nodeId}/light`, { textNotes, weather, timeRange, moodEmoji: mood }),
  regenerateNode: (tripId: string, nodeId: string, textNotes?: string[], weather?: string, timeRange?: string, mood?: string) =>
    apiClient.post<{ fragment: DiaryFragment }>(`/trips/${tripId}/nodes/${nodeId}/regenerate`, { textNotes, weather, timeRange, moodEmoji: mood }),
  updateFragment: (fragmentId: string, content: string, moodEmoji?: string) =>
    apiClient.put<{ fragment: DiaryFragment }>(`/diary-fragments/${fragmentId}`, { content, moodEmoji }),
  getFragments: (tripId: string) =>
    apiClient.get<DiaryFragment[]>(`/trips/${tripId}/diary-fragments`),
  // 变更行程
  changeItinerary: (tripId: string, nodeId: string, newDestination: string, changeReason: string) =>
    apiClient.post<{ originalNode: TravelNode; newNode: TravelNode; newNodeDescription: string }>(
      `/trips/${tripId}/nodes/${nodeId}/change`,
      { newDestination, changeReason }
    ),
  // 标记未实现
  markUnrealized: (tripId: string, nodeId: string, reason: string, moodEmoji?: string, weather?: string) =>
    apiClient.post<{ node: TravelNode; fragment: DiaryFragment }>(
      `/trips/${tripId}/nodes/${nodeId}/unrealized`,
      { reason, moodEmoji, weather }
    ),
  // 点亮变更节点
  lightChangedNode: (tripId: string, nodeId: string, textNotes?: string[], weather?: string, timeRange?: string, mood?: string) =>
    apiClient.post<{ fragment: DiaryFragment }>(
      `/trips/${tripId}/nodes/${nodeId}/light-changed`,
      { textNotes, weather, timeRange, moodEmoji: mood }
    ),
  // 生成AI图像（用于没有照片的日记）
  generateAiImage: (tripId: string, nodeId: string, diaryContent: string, weather?: string, moodEmoji?: string) =>
    apiClient.post<{ imageUrl: string; isAiGenerated: boolean }>(
      `/trips/${tripId}/nodes/${nodeId}/generate-ai-image`,
      { diaryContent, weather, moodEmoji }
    ),
};

// Memoir API
export const memoirApi = {
  complete: (tripId: string) =>
    apiClient.post<TravelMemoir>(`/trips/${tripId}/complete`),
  get: (tripId: string) =>
    apiClient.get<TravelMemoir>(`/trips/${tripId}/memoir`),
  changeTemplate: (tripId: string, templateId: string) =>
    apiClient.put<{ html: string }>(`/trips/${tripId}/memoir/template`, { templateId }),
  getTemplates: () =>
    apiClient.get<MemoirTemplate[]>('/memoir-templates'),
  generateShareUrl: (tripId: string) =>
    apiClient.post<{ shareUrl: string }>(`/trips/${tripId}/memoir/share`),
  getDownloadUrl: (tripId: string) =>
    `${API_BASE_URL}/trips/${tripId}/memoir/download`,
};

// Trip API
export const tripApi = {
  getUserTrips: (userId: string) =>
    apiClient.get<Trip[]>(`/users/${userId}/trips`),
  getTrip: (tripId: string) =>
    apiClient.get<Trip>(`/trips/${tripId}`),
  deleteTrip: (tripId: string) =>
    apiClient.delete<{ success: boolean }>(`/trips/${tripId}`),
  deleteTrips: (tripIds: string[]) =>
    apiClient.post<{ success: boolean; deletedCount: number }>('/trips/batch-delete', { tripIds }),
  saveToShelf: (tripId: string) =>
    apiClient.post<Trip>(`/trips/${tripId}/save-to-shelf`),
};

export { apiClient };
