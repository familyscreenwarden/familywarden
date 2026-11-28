import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SignIn } from './pages/SignIn';
import { DashboardPage } from './pages/Dashboard';
import { KidsIndex, KidPage, NewKidPage } from './pages/Kids';
import { KidPhonePage } from './pages/KidPhone';
import { KidPhotosPage } from './pages/KidPhotos';
import { KidTextsPage } from './pages/KidTexts';
import { DevicesPage } from './pages/Devices';
import { RequestsPage } from './pages/Requests';
import { ChatPage } from './pages/Chat';
import { ReportsPage } from './pages/Reports';
import { SafeBrowsingPage } from './pages/SafeBrowsing';
import { BillingPage } from './pages/Billing';
import { SettingsPage } from './pages/Settings';
import { HelpPage } from './pages/Help';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/kids" element={<KidsIndex />} />
        <Route path="/kids/new" element={<NewKidPage />} />
        <Route path="/kids/:id" element={<KidPage />} />
        <Route path="/kids/:id/phone" element={<KidPhonePage />} />
        <Route path="/kids/:id/texts" element={<KidTextsPage />} />
        <Route path="/kids/:id/photos" element={<KidPhotosPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/safe-browsing" element={<SafeBrowsingPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
