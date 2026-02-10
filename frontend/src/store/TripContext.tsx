import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import type {
  Trip,
  Itinerary,
  SearchConditions,
  DestinationCard,
  DiaryFragment,
  TravelMemoir,
  ChatMessage,
} from '../types';

// State interface
interface TripState {
  // Current trip data
  currentTrip: Trip | null;
  itinerary: Itinerary | null;
  diaryFragments: DiaryFragment[];
  memoir: TravelMemoir | null;
  
  // Vision & destination selection
  visionText: string;
  searchConditions: SearchConditions | null;
  destinations: DestinationCard[];
  excludedCities: string[];
  
  // Chat history for planning
  chatHistory: ChatMessage[];
  
  // UI state
  isLoading: boolean;
  error: string | null;
}

// Action types
type TripAction =
  | { type: 'SET_VISION_TEXT'; payload: string }
  | { type: 'SET_SEARCH_CONDITIONS'; payload: SearchConditions }
  | { type: 'SET_DESTINATIONS'; payload: DestinationCard[] }
  | { type: 'ADD_EXCLUDED_CITIES'; payload: string[] }
  | { type: 'CLEAR_EXCLUDED_CITIES' }
  | { type: 'SET_CURRENT_TRIP'; payload: Trip }
  | { type: 'SET_ITINERARY'; payload: Itinerary }
  | { type: 'SET_DIARY_FRAGMENTS'; payload: DiaryFragment[] }
  | { type: 'ADD_DIARY_FRAGMENT'; payload: DiaryFragment }
  | { type: 'UPDATE_DIARY_FRAGMENT'; payload: DiaryFragment }
  | { type: 'SET_MEMOIR'; payload: TravelMemoir }
  | { type: 'ADD_CHAT_MESSAGE'; payload: ChatMessage }
  | { type: 'SET_CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'RESET_STATE' };

// Initial state
const initialState: TripState = {
  currentTrip: null,
  itinerary: null,
  diaryFragments: [],
  memoir: null,
  visionText: '',
  searchConditions: null,
  destinations: [],
  excludedCities: [],
  chatHistory: [],
  isLoading: false,
  error: null,
};

// Reducer
function tripReducer(state: TripState, action: TripAction): TripState {
  switch (action.type) {
    case 'SET_VISION_TEXT':
      return { ...state, visionText: action.payload };
    case 'SET_SEARCH_CONDITIONS':
      return { ...state, searchConditions: action.payload };
    case 'SET_DESTINATIONS':
      return { ...state, destinations: action.payload };
    case 'ADD_EXCLUDED_CITIES':
      return { ...state, excludedCities: [...state.excludedCities, ...action.payload] };
    case 'CLEAR_EXCLUDED_CITIES':
      return { ...state, excludedCities: [] };
    case 'SET_CURRENT_TRIP':
      return { ...state, currentTrip: action.payload };
    case 'SET_ITINERARY':
      return { ...state, itinerary: action.payload };
    case 'SET_DIARY_FRAGMENTS':
      return { ...state, diaryFragments: action.payload };
    case 'ADD_DIARY_FRAGMENT':
      return { ...state, diaryFragments: [...state.diaryFragments, action.payload] };
    case 'UPDATE_DIARY_FRAGMENT':
      return {
        ...state,
        diaryFragments: state.diaryFragments.map((f) =>
          f.id === action.payload.id ? action.payload : f
        ),
      };
    case 'SET_MEMOIR':
      return { ...state, memoir: action.payload };
    case 'ADD_CHAT_MESSAGE':
      return { ...state, chatHistory: [...state.chatHistory, action.payload] };
    case 'SET_CHAT_HISTORY':
      return { ...state, chatHistory: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'RESET_STATE':
      return initialState;
    default:
      return state;
  }
}

// Context
interface TripContextType {
  state: TripState;
  dispatch: React.Dispatch<TripAction>;
}

const TripContext = createContext<TripContextType | undefined>(undefined);

// Provider component
interface TripProviderProps {
  children: ReactNode;
}

export function TripProvider({ children }: TripProviderProps) {
  const [state, dispatch] = useReducer(tripReducer, initialState);

  return (
    <TripContext.Provider value={{ state, dispatch }}>
      {children}
    </TripContext.Provider>
  );
}

// Custom hook
export function useTripContext() {
  const context = useContext(TripContext);
  if (context === undefined) {
    throw new Error('useTripContext must be used within a TripProvider');
  }
  return context;
}

export type { TripState, TripAction };
