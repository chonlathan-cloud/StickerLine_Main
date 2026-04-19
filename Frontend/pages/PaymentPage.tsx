import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { createPayment, getPaymentStatus } from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

type PackageOption = {
  id: 'pkg_70' | 'pkg_100';
  title: string;
  price: string;
  coins: number;
  highlight?: string;
};

const PACKAGES: PackageOption[] = [
  { id: 'pkg_70', title: 'Starter Pack', price: '70 THB', coins: 7 },
  { id: 'pkg_100', title: 'Best Value', price: '100 THB', coins: 12, highlight: 'Bonus +2 coins' },
];

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile, isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [selectedPackage, setSelectedPackage] = useState<PackageOption | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [chargeId, setChargeId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const shouldRedirect = isReady && !isAuthenticated;

  useEffect(() => {
    if (!chargeId || status !== 'pending') return;

    const interval = window.setInterval(async () => {
      try {
        const result = await getPaymentStatus(chargeId);
        if (result.status === 'success') {
          setStatus('success');
          await refreshProfile();
        }
      } catch (err: any) {
        setError(err?.response?.data?.detail || err?.message || 'Failed to check payment status.');
      }
    }, 5000);

    return () => window.clearInterval(interval);
  }, [chargeId, status, refreshProfile]);

  const handleSelectPackage = async (pkg: PackageOption) => {
    if (!profile?.userId) return;
    setSelectedPackage(pkg);
    setStatus('pending');
    setError(null);

    try {
      const result = await createPayment(profile.userId, pkg.id);
      setChargeId(result.charge_id);
      setQrUrl(result.qr_image_url);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'Failed to create payment.');
    }
  };

  const handleManualCheck = async () => {
    if (!chargeId) return;
    try {
      const result = await getPaymentStatus(chargeId);
      if (result.status === 'success') {
        setStatus('success');
        await refreshProfile();
      }
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to check payment status.');
    }
  };

  const handleCloseModal = () => {
    setSelectedPackage(null);
    setQrUrl(null);
    setChargeId(null);
    setStatus('idle');
    setError(null);
  };

  const handleSuccessReturn = () => {
    navigate('/generate');
  };

  if (shouldRedirect) {
    return <Navigate to="/login" replace />;
  }

  const modalTitle = useMemo(() => {
    if (status === 'success') return 'Payment Success';
    if (status === 'failed') return 'Payment Failed';
    return 'Scan to Pay';
  }, [status]);

  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-8 pt-6 sm:max-w-xl">
        <section className="rounded-[2.5rem] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Top Up</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Choose a package</h2>
          <p className="mt-2 text-sm text-slate-600">
            Select a package to generate the PromptPay QR code.
          </p>

          <div className="mt-6 grid gap-3">
            {PACKAGES.map((pkg) => (
              <button
                key={pkg.id}
                type="button"
                onClick={() => handleSelectPackage(pkg)}
                className="focus-ring flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-emerald-300 hover:shadow-sm"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">{pkg.title}</p>
                  <p className="text-xs text-slate-500">{pkg.coins} coins</p>
                  {pkg.highlight && (
                    <p className="mt-1 text-xs font-semibold text-emerald-600">{pkg.highlight}</p>
                  )}
                </div>
                <span className="text-lg font-semibold text-slate-900">{pkg.price}</span>
              </button>
            ))}
          </div>
        </section>

        {error && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">
            {error}
          </div>
        )}
      </main>

      {selectedPackage && (
        <div className="fixed inset-0 z-50 flex min-h-dvh flex-col bg-slate-950/80 px-4 py-8">
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col rounded-[2.5rem] bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{modalTitle}</h3>
              <button
                type="button"
                onClick={handleCloseModal}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600"
              >
                Close
              </button>
            </div>

            {status === 'success' ? (
              <div className="mt-6 flex flex-1 flex-col items-center justify-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  ✓
                </div>
                <h4 className="mt-4 text-xl font-semibold text-slate-900">Payment completed</h4>
                <p className="mt-2 text-sm text-slate-600">Coins have been added to your balance.</p>
                <button
                  type="button"
                  onClick={handleSuccessReturn}
                  className="focus-ring mt-6 min-h-11 rounded-2xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  Back to Generate
                </button>
              </div>
            ) : (
              <div className="mt-6 flex flex-1 flex-col items-center text-center">
                <p className="text-sm text-slate-600">PromptPay QR for {selectedPackage.price}</p>
                <div className="mt-4 flex h-56 w-56 items-center justify-center rounded-3xl border border-slate-200 bg-slate-50">
                  {qrUrl ? (
                    <img src={qrUrl} alt="PromptPay QR" className="h-48 w-48" />
                  ) : (
                    <span className="text-xs text-slate-400">Generating QR...</span>
                  )}
                </div>
                <p className="mt-4 text-xs text-slate-500">Polling every 5 seconds for payment status.</p>
                <button
                  type="button"
                  onClick={handleManualCheck}
                  className="focus-ring mt-4 min-h-11 rounded-2xl border border-slate-200 px-6 py-2 text-sm font-semibold text-slate-700 hover:border-emerald-300"
                >
                  ฉันจ่ายแล้ว
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default PaymentPage;
