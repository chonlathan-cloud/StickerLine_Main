import React, { useEffect, useState } from 'react';
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

type PaymentFlowStatus = 'idle' | 'redirecting' | 'checking' | 'pending' | 'success' | 'failed';

const PACKAGES: PackageOption[] = [
  { id: 'pkg_70', title: 'Starter Pack', price: '70 THB', coins: 7 },
  { id: 'pkg_100', title: 'Best Value', price: '100 THB', coins: 12, highlight: 'Bonus +2 coins' },
];

const PENDING_PAYMENT_ID_KEY = 'beam_pending_payment_link_id';
const PENDING_CHECKOUT_URL_KEY = 'beam_pending_checkout_url';
const PENDING_PACKAGE_ID_KEY = 'beam_pending_package_id';

const readPendingState = () => {
  try {
    return {
      paymentLinkId: localStorage.getItem(PENDING_PAYMENT_ID_KEY),
      checkoutUrl: localStorage.getItem(PENDING_CHECKOUT_URL_KEY),
      packageId: localStorage.getItem(PENDING_PACKAGE_ID_KEY),
    };
  } catch {
    return {
      paymentLinkId: null,
      checkoutUrl: null,
      packageId: null,
    };
  }
};

const persistPendingState = (paymentLinkId: string, checkoutUrl: string, packageId: string) => {
  try {
    localStorage.setItem(PENDING_PAYMENT_ID_KEY, paymentLinkId);
    localStorage.setItem(PENDING_CHECKOUT_URL_KEY, checkoutUrl);
    localStorage.setItem(PENDING_PACKAGE_ID_KEY, packageId);
  } catch {
    // ignore browser storage failures
  }
};

const clearPendingState = () => {
  try {
    localStorage.removeItem(PENDING_PAYMENT_ID_KEY);
    localStorage.removeItem(PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PENDING_PACKAGE_ID_KEY);
  } catch {
    // ignore browser storage failures
  }
};

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile, isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [selectedPackageId, setSelectedPackageId] = useState<PackageOption['id'] | null>(null);
  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [pendingPackageId, setPendingPackageId] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const shouldRedirect = isReady && !isAuthenticated;
  const pendingPackage = PACKAGES.find((pkg) => pkg.id === pendingPackageId) ?? null;

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;

    const pendingState = readPendingState();
    setPaymentLinkId(pendingState.paymentLinkId);
    setCheckoutUrl(pendingState.checkoutUrl);
    setPendingPackageId(pendingState.packageId);

    if (pendingState.paymentLinkId) {
      setStatus('pending');
    }
  }, [isAuthenticated, isReady]);

  useEffect(() => {
    if (!paymentLinkId) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('beam_return') !== '1') return;

    void handleCheckStatus(paymentLinkId);
  }, [paymentLinkId]);

  const handleSelectPackage = async (pkg: PackageOption) => {
    if (!profile?.userId) return;

    setSelectedPackageId(pkg.id);
    setStatus('redirecting');
    setError(null);

    try {
      const result = await createPayment(profile.userId, pkg.id);
      persistPendingState(result.payment_link_id, result.checkout_url, pkg.id);
      setPaymentLinkId(result.payment_link_id);
      setCheckoutUrl(result.checkout_url);
      setPendingPackageId(pkg.id);
      window.location.assign(result.checkout_url);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'Failed to create payment link.');
    } finally {
      setSelectedPackageId(null);
    }
  };

  const handleCheckStatus = async (targetPaymentLinkId?: string) => {
    const resolvedPaymentLinkId = targetPaymentLinkId || paymentLinkId;
    if (!resolvedPaymentLinkId) return;

    setStatus('checking');
    setError(null);

    try {
      const result = await getPaymentStatus(resolvedPaymentLinkId);
      setCheckoutUrl(result.checkout_url || null);

      if (result.status === 'success') {
        clearPendingState();
        setCheckoutUrl(null);
        setStatus('success');
        await refreshProfile();
        return;
      }

      setStatus(result.status === 'failed' ? 'failed' : 'pending');
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'Failed to check payment status.');
    }
  };

  const handleResumeCheckout = () => {
    if (!checkoutUrl) return;
    window.location.assign(checkoutUrl);
  };

  const handleResetPending = () => {
    clearPendingState();
    setPaymentLinkId(null);
    setCheckoutUrl(null);
    setPendingPackageId(null);
    setStatus('idle');
    setError(null);
  };

  const handleSuccessReturn = () => {
    navigate('/generate');
  };

  if (shouldRedirect) {
    return <Navigate to="/login" replace />;
  }

  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-8 pt-6 sm:max-w-xl">
        <section className="rounded-[2.5rem] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Top Up</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Choose a package</h2>
          <p className="mt-2 text-sm text-slate-600">
            Choose a package and continue to the Beam checkout page to complete payment.
          </p>

          <div className="mt-6 grid gap-3">
            {PACKAGES.map((pkg) => (
              <button
                key={pkg.id}
                type="button"
                onClick={() => handleSelectPackage(pkg)}
                disabled={status === 'redirecting' || status === 'checking'}
                className="focus-ring flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-emerald-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">{pkg.title}</p>
                  <p className="text-xs text-slate-500">{pkg.coins} coins</p>
                  {pkg.highlight && (
                    <p className="mt-1 text-xs font-semibold text-emerald-600">{pkg.highlight}</p>
                  )}
                </div>
                <span className="text-lg font-semibold text-slate-900">
                  {selectedPackageId === pkg.id && status === 'redirecting' ? 'Opening...' : pkg.price}
                </span>
              </button>
            ))}
          </div>
        </section>

        {paymentLinkId && (
          <section className="rounded-[2.5rem] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-500">Payment</p>
            <h3 className="mt-2 text-xl font-semibold text-slate-900">
              {status === 'success' ? 'Payment completed' : 'Pending payment'}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              {pendingPackage
                ? `${pendingPackage.title} (${pendingPackage.price})`
                : 'There is a payment waiting for confirmation.'}
            </p>
            <p className="mt-2 break-all text-xs text-slate-500">Payment Link ID: {paymentLinkId}</p>

            {status === 'success' ? (
              <div className="mt-6">
                <p className="text-sm text-slate-600">Coins have been added to your balance.</p>
                <button
                  type="button"
                  onClick={handleSuccessReturn}
                  className="focus-ring mt-4 min-h-11 rounded-2xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  Back to Generate
                </button>
              </div>
            ) : (
              <div className="mt-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => handleCheckStatus()}
                  className="focus-ring min-h-11 rounded-2xl bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  {status === 'checking' ? 'Checking...' : 'I have completed payment'}
                </button>
                {checkoutUrl && (
                  <button
                    type="button"
                    onClick={handleResumeCheckout}
                    className="focus-ring min-h-11 rounded-2xl border border-slate-200 px-6 py-2 text-sm font-semibold text-slate-700 hover:border-emerald-300"
                  >
                    Continue to Checkout
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleResetPending}
                  className="focus-ring min-h-11 rounded-2xl border border-slate-200 px-6 py-2 text-sm font-semibold text-slate-700 hover:border-rose-300"
                >
                  Clear Pending Payment
                </button>
              </div>
            )}
          </section>
        )}

        {error && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">
            {error}
          </div>
        )}
      </main>
    </PageLayout>
  );
};

export default PaymentPage;
