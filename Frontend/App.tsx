import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import GeneratePage from './pages/GeneratePage';
import LoginPage from './pages/LoginPage';
import PaymentPage from './pages/PaymentPage';
import { useAuth } from './providers/AuthProvider';
import { PageLayout } from './components/PageLayout';
import { useOnlineStatus } from './hooks/useOnlineStatus';

const AuthLoading: React.FC = () => {
  const isOnline = useOnlineStatus();
  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-6 pb-8 pt-6 sm:max-w-xl">
        <section className="rounded-[32px] border-2 border-border-light-purple bg-white p-6 text-sm font-bold text-on-surface-variant shadow-sm">
          Preparing LINE login...
        </section>
      </main>
    </PageLayout>
  );
};

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isReady, isAuthenticated } = useAuth();
  if (!isReady) return <AuthLoading />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

const PublicOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isReady, isAuthenticated } = useAuth();
  if (!isReady) return <AuthLoading />;
  if (isAuthenticated) return <Navigate to="/generate" replace />;
  return <>{children}</>;
};

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/generate" replace />} />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/generate"
        element={
          <RequireAuth>
            <GeneratePage />
          </RequireAuth>
        }
      />
      <Route path="/payment" element={<PaymentPage />} />
      <Route path="*" element={<Navigate to="/generate" replace />} />
    </Routes>
  );
};

export default App;
