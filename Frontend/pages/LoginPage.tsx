import React from 'react';
import { Navigate } from 'react-router-dom';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

const LoginPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { isReady, isAuthenticated, error, login } = useAuth();

  if (isReady && isAuthenticated) {
    return <Navigate to="/generate" replace />;
  }

  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-8 pt-6 sm:max-w-xl">
        <section className="rounded-[2.5rem] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Line Login</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Sign in to start</h2>
          <p className="mt-2 text-sm text-slate-600">
            Connect your LINE account to sync your profile and unlock sticker generation.
          </p>

          <div className="mt-6 flex flex-col gap-3">
            <button
              type="button"
              onClick={login}
              disabled={!isReady}
              className="focus-ring min-h-12 rounded-2xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isReady ? 'Login with LINE' : 'Preparing LINE login...'}
            </button>
            <p className="text-xs text-slate-500">
              This will open LINE authentication. You will return to the Generate page after login.
            </p>
          </div>
        </section>

        {error && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">
            {error}
          </div>
        )}
      </main>
    </PageLayout>
  );
};

export default LoginPage;
