import { Routes, Route } from 'react-router-dom';
import {
  HomePage,
  DestinationPage,
  PlanningPage,
  TravelingPage,
  MemoirPage,
  HistoryPage,
} from './pages';

function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/destinations" element={<DestinationPage />} />
        <Route path="/planning/:tripId" element={<PlanningPage />} />
        <Route path="/traveling/:tripId" element={<TravelingPage />} />
        <Route path="/memoir/:tripId" element={<MemoirPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
    </div>
  );
}

export default App;
