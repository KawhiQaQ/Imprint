// Vision Types
export interface VisionInput {
  text: string;
  userId: string;
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

export interface VisionAnalysisResult {
  success: boolean;
  conditions: SearchConditions;
  rawAnalysis: string;
  errorMessage?: string;
}

// Destination Types
export interface DestinationCard {
  id: string;
  cityName: string;
  province: string;
  coverImageUrl: string;
  recommendReason: string;
  hotSpots: string[];
  matchScore: number;
}

export interface DestinationRecommendation {
  success: boolean;
  destinations: DestinationCard[];
  excludedCities: string[];
  errorMessage?: string;
}

// City Search Types
export interface CitySearchResult {
  cityName: string;
  province: string;
  description: string;
}

// Trip Types
export type TripStatus = 'planning' | 'traveling' | 'completed';

export interface Trip {
  id: string;
  userId: string;
  visionText: string;
  destination: string;
  status: TripStatus;
  isSavedToShelf: boolean; // 是否已保存到书架
  coverImageUrl?: string; // 封面图片URL
  searchConditions?: SearchConditions;
  createdAt: Date;
  updatedAt: Date;
}

// Itinerary Types
export type NodeType = 'attraction' | 'restaurant' | 'hotel' | 'transport';

// 节点状态类型
export type NodeStatus = 'normal' | 'changed' | 'unrealized' | 'changed_original';

export interface TravelNode {
  id: string;
  name: string;
  type: NodeType;
  address: string;
  description: string;
  estimatedDuration: number;
  scheduledTime: string;
  dayIndex: number;
  order: number;
  verified: boolean;
  verificationInfo?: string;
  isLit?: boolean;
  timeSlot?: string; // 时段：arrival, breakfast, morning, lunch, afternoon, dinner, evening, hotel
  activity?: string; // 活动描述：如"游玩西湖景区"、"品尝杭帮菜"
  isStartingPoint?: boolean; // 是否是大型景区的起点位置（如鼓浪屿的某个码头/旅馆）
  scenicAreaName?: string; // 如果是起点，对应的景区名称（如"鼓浪屿"）
  // 扩展信息
  priceInfo?: string; // 价格信息：餐厅人均、酒店房价、景点门票价格
  ticketInfo?: string; // 门票/预约信息：如"需提前预约"、"免费"、"门票80元"
  tips?: string; // 小贴士：如"建议早去避开人流"、"周一闭馆"
  // 交通信息（到达此节点的交通方式）
  transportMode?: string; // 交通方式：walk, bus, subway, taxi, drive
  transportDuration?: number; // 交通时长（分钟）
  transportNote?: string; // 交通说明：如"步行约10分钟"、"地铁2号线3站"
  // 节点状态相关
  nodeStatus?: NodeStatus; // 节点状态：normal-正常, changed-变更后的新节点, unrealized-未实现, changed_original-已变更的原节点
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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// Diary Types
export interface PhotoMaterial {
  id: string;
  url: string;
  uploadTime: Date;
  visionAnalysis?: string;
  isAiGenerated?: boolean;
}

export interface VoiceRecording {
  id: string;
  audioUrl: string;
  uploadTime: Date;
  transcription?: string;
}

export interface NodeMaterial {
  nodeId: string;
  photos: PhotoMaterial[];
  voiceRecordings: VoiceRecording[];
  moodEmoji?: string;
}

export interface DiaryFragment {
  id: string;
  nodeId: string;
  nodeName: string;
  content: string;
  photos: PhotoMaterial[];
  timeRange: string;
  moodEmoji?: string;
  weather?: string;
  textNotes?: string[];
  generatedAt: Date;
  isEdited: boolean;
  nodeStatus?: NodeStatus; // 节点状态
  statusReason?: string; // 状态原因
}

// Memoir Types
export interface TripStatistics {
  totalDays: number;
  totalNodes: number;
  totalPhotos: number;
  topMoods: string[];
  highlightMoments: string[];
}

export interface PersonalityReport {
  title: string;
  description: string;
  traits: string[];
  statistics: TripStatistics;
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
  openingText: string;
  closingText: string;
  fragments: DiaryFragment[];
  personalityReport: PersonalityReport;
  templateId: string;
  generatedAt: Date;
  shareUrl?: string;
}
