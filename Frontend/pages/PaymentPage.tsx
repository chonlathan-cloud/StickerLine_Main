import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { createPayment, getPaymentStatus } from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

type PackageOption = {
  id: 'pkg_70' | 'pkg_100';
  title: string;
  priceLabel: string;
  amount: number;
  coins: number;
  highlight?: string;
  accent: string;
  description: string;
};

type PaymentFlowStatus = 'idle' | 'redirecting' | 'checking' | 'pending' | 'success' | 'failed';

const PACKAGES: PackageOption[] = [
  {
    id: 'pkg_70',
    title: 'Starter Pack',
    priceLabel: '70 THB',
    amount: 70,
    coins: 7,
    accent: 'from-sky-500 to-cyan-500',
    description: 'เหมาะสำหรับทดลองเติมครั้งแรก',
  },
  {
    id: 'pkg_100',
    title: 'Best Value',
    priceLabel: '100 THB',
    amount: 100,
    coins: 12,
    highlight: 'โบนัส +2 coins',
    accent: 'from-emerald-500 to-teal-500',
    description: 'แพ็กยอดนิยม ได้เหรียญคุ้มกว่า',
  },
];

const PENDING_PAYMENT_ID_KEY = 'beam_pending_payment_link_id';
const PENDING_CHECKOUT_URL_KEY = 'beam_pending_checkout_url';
const PENDING_PACKAGE_ID_KEY = 'beam_pending_package_id';
const PENDING_EXPIRES_AT_KEY = 'beam_pending_expires_at';
const AUTO_REDIRECT_DELAY_MS = 1800;

const readPendingState = () => {
  try {
    return {
      paymentLinkId: localStorage.getItem(PENDING_PAYMENT_ID_KEY),
      checkoutUrl: localStorage.getItem(PENDING_CHECKOUT_URL_KEY),
      packageId: localStorage.getItem(PENDING_PACKAGE_ID_KEY),
      expiresAt: localStorage.getItem(PENDING_EXPIRES_AT_KEY),
    };
  } catch {
    return {
      paymentLinkId: null,
      checkoutUrl: null,
      packageId: null,
      expiresAt: null,
    };
  }
};

const persistPendingState = (
  paymentLinkId: string,
  checkoutUrl: string,
  packageId: string,
  expiresAt?: string | null,
) => {
  try {
    localStorage.setItem(PENDING_PAYMENT_ID_KEY, paymentLinkId);
    localStorage.setItem(PENDING_CHECKOUT_URL_KEY, checkoutUrl);
    localStorage.setItem(PENDING_PACKAGE_ID_KEY, packageId);
    if (expiresAt) {
      localStorage.setItem(PENDING_EXPIRES_AT_KEY, expiresAt);
    } else {
      localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
    }
  } catch {
    // ignore browser storage failures
  }
};

const clearPendingState = () => {
  try {
    localStorage.removeItem(PENDING_PAYMENT_ID_KEY);
    localStorage.removeItem(PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PENDING_PACKAGE_ID_KEY);
    localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
  } catch {
    // ignore browser storage failures
  }
};

const formatDateTime = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const formatRemainingTime = (value?: string | null) => {
  if (!value) return null;
  const expiresAt = new Date(value).getTime();
  if (Number.isNaN(expiresAt)) return null;

  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return 'ลิงก์นี้หมดอายุแล้ว';

  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) return `ลิงก์นี้จะหมดอายุใน ${totalMinutes} นาที`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? `ลิงก์นี้จะหมดอายุใน ${hours} ชม. ${minutes} นาที`
    : `ลิงก์นี้จะหมดอายุใน ${hours} ชม.`;
};

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile, coinBalance, isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [selectedPackageId, setSelectedPackageId] = useState<PackageOption['id'] | null>(null);
  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [pendingPackageId, setPendingPackageId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showPaymentDetails, setShowPaymentDetails] = useState(false);

  const shouldRedirect = isReady && !isAuthenticated;
  const pendingPackage = PACKAGES.find((pkg) => pkg.id === pendingPackageId) ?? null;

  const projectedCoinBalance = useMemo(() => {
    if (coinBalance == null || !pendingPackage || status === 'success') return null;
    return coinBalance + pendingPackage.coins;
  }, [coinBalance, pendingPackage, status]);

  const expiryLabel = useMemo(() => formatDateTime(expiresAt), [expiresAt]);
  const expiryHint = useMemo(() => formatRemainingTime(expiresAt), [expiresAt]);

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;

    const pendingState = readPendingState();
    setPaymentLinkId(pendingState.paymentLinkId);
    setCheckoutUrl(pendingState.checkoutUrl);
    setPendingPackageId(pendingState.packageId);
    setExpiresAt(pendingState.expiresAt);

    if (pendingState.paymentLinkId) {
      setStatus('pending');
    }
  }, [isAuthenticated, isReady]);

  useEffect(() => {
    if (status !== 'success') return;

    const timeout = window.setTimeout(() => {
      navigate('/generate');
    }, AUTO_REDIRECT_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [navigate, status]);

  useEffect(() => {
    if (!paymentLinkId) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('beam_return') !== '1') return;

    void handleCheckStatus(paymentLinkId);
  }, [paymentLinkId]);

  const handleSelectPackage = async (pkg: PackageOption) => {
    if (!profile?.userId) return;

    setSelectedPackageId(pkg.id);
    setPendingPackageId(pkg.id);
    setStatus('redirecting');
    setError(null);

    try {
      const result = await createPayment(profile.userId, pkg.id);
      persistPendingState(result.payment_link_id, result.checkout_url, pkg.id, result.expires_at);
      setPaymentLinkId(result.payment_link_id);
      setCheckoutUrl(result.checkout_url);
      setExpiresAt(result.expires_at ?? null);
      window.location.assign(result.checkout_url);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'ไม่สามารถสร้างลิงก์ชำระเงินได้');
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
      setExpiresAt(result.expires_at ?? null);

      if (result.status === 'success') {
        clearPendingState();
        setCheckoutUrl(null);
        setStatus('success');
        await refreshProfile();
        return;
      }

      setStatus(result.status === 'failed' ? 'failed' : 'pending');
      if (result.status === 'failed') {
        setError('รายการชำระเงินนี้ยังไม่สำเร็จหรือหมดอายุแล้ว กรุณาสร้างรายการใหม่อีกครั้ง');
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'ไม่สามารถตรวจสอบสถานะการชำระเงินได้');
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
    setExpiresAt(null);
    setStatus('idle');
    setError(null);
    setShowPaymentDetails(false);
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
        <section className="overflow-hidden rounded-[2.75rem] border border-slate-200 bg-white shadow-sm">
          <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 px-6 py-6 text-white">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/60">Top Up</p>
            <h1 className="mt-2 text-3xl font-semibold">เติมเหรียญสำหรับสร้างสติกเกอร์</h1>
            <p className="mt-2 text-sm text-white/75">
              ระบบจะพาคุณไปยังหน้าชำระเงินของ Beam / UOB ที่ปลอดภัย จากนั้นพากลับมาที่แอปโดยอัตโนมัติ
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">เหรียญคงเหลือ</p>
                <p className="mt-2 text-3xl font-semibold">{(coinBalance ?? 0).toLocaleString()}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">ช่องทางชำระ</p>
                <p className="mt-2 text-sm font-medium text-white/90">Card, PromptPay, Mobile Banking</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">เครดิตเข้าเมื่อ</p>
                <p className="mt-2 text-sm font-medium text-white/90">เมื่อระบบยืนยันการชำระเงินสำเร็จ</p>
              </div>
            </div>
          </div>

          <div className="px-6 py-6">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                Beam Secure Checkout
              </span>
              <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">
                รองรับ PromptPay และ Mobile Banking
              </span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                เติมเหรียญได้ทันทีหลังยืนยันการชำระ
              </span>
            </div>

            <div className="mt-6 grid gap-4">
              {PACKAGES.map((pkg) => {
                const isSelected = pendingPackageId === pkg.id;
                return (
                  <button
                    key={pkg.id}
                    type="button"
                    onClick={() => handleSelectPackage(pkg)}
                    disabled={status === 'redirecting' || status === 'checking'}
                    className={`focus-ring relative overflow-hidden rounded-[2rem] border px-5 py-5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      isSelected
                        ? 'border-emerald-300 shadow-[0_18px_40px_-24px_rgba(16,185,129,0.6)]'
                        : 'border-slate-200 hover:border-emerald-300 hover:shadow-sm'
                    }`}
                  >
                    <div className={`absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r ${pkg.accent}`} aria-hidden="true" />
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-semibold text-slate-900">{pkg.title}</p>
                          {pkg.highlight && (
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                              {pkg.highlight}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm text-slate-600">{pkg.description}</p>
                        <div className="mt-4 flex items-end gap-2">
                          <span className="text-3xl font-semibold text-slate-900">{pkg.coins}</span>
                          <span className="pb-1 text-sm font-medium text-slate-500">coins</span>
                        </div>
                        <p className="mt-2 text-xs font-medium text-slate-500">
                          {coinBalance != null ? `เติมแล้วจะมีประมาณ ${coinBalance + pkg.coins} coins` : 'ยอดเหรียญจะอัปเดตหลังชำระสำเร็จ'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-semibold text-slate-900">{pkg.priceLabel}</p>
                        <p className="mt-1 text-xs font-medium text-slate-500">
                          {selectedPackageId === pkg.id && status === 'redirecting' ? 'กำลังเปิดหน้าชำระเงิน...' : 'ชำระผ่าน Beam / UOB'}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {pendingPackage && (
          <section className="rounded-[2.5rem] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-500">Payment Status</p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                  {status === 'success'
                    ? 'ชำระเงินสำเร็จ'
                    : status === 'failed'
                      ? 'รายการชำระเงินมีปัญหา'
                      : 'มีรายการชำระเงินรอดำเนินการ'}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {status === 'success'
                    ? `เติม ${pendingPackage.coins} coins เรียบร้อยแล้ว กำลังพาคุณกลับไปหน้าสร้างสติกเกอร์`
                    : status === 'failed'
                      ? 'หากรายการนี้หมดอายุหรือชำระไม่สำเร็จ คุณสามารถสร้างรายการใหม่ได้ทันที'
                      : `แพ็กเกจ ${pendingPackage.title} จำนวน ${pendingPackage.priceLabel}`}
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-right">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">เหรียญที่จะได้รับ</p>
                <p className="mt-2 text-3xl font-semibold text-slate-900">+{pendingPackage.coins}</p>
                {status !== 'success' && projectedCoinBalance != null && (
                  <p className="mt-1 text-xs text-slate-500">หลังชำระจะมีประมาณ {projectedCoinBalance} coins</p>
                )}
              </div>
            </div>

            {(status === 'pending' || status === 'checking') && (
              <div className="mt-5 rounded-2xl border border-white/70 bg-white/70 p-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">หากชำระเงินแล้วแต่ยอดยังไม่เข้า</p>
                <p className="mt-1">
                  กดปุ่ม <span className="font-semibold">ตรวจสอบสถานะอีกครั้ง</span> ได้ ระบบจะเช็กกับ Beam โดยตรง
                </p>
                {expiryLabel && <p className="mt-3 text-xs text-slate-500">หมดอายุ: {expiryLabel}</p>}
                {expiryHint && <p className="mt-1 text-xs text-slate-500">{expiryHint}</p>}
              </div>
            )}

            {status === 'success' && (
              <div className="mt-5 rounded-2xl border border-emerald-200 bg-white/80 p-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">ยอดเหรียญปัจจุบัน</p>
                <p className="mt-2 text-2xl font-semibold text-emerald-700">{(coinBalance ?? 0).toLocaleString()} coins</p>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-3">
              {status !== 'success' ? (
                <button
                  type="button"
                  onClick={() => handleCheckStatus()}
                  className="focus-ring min-h-11 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  {status === 'checking' ? 'กำลังตรวจสอบ...' : 'ฉันชำระเงินแล้ว ตรวจสอบสถานะอีกครั้ง'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSuccessReturn}
                  className="focus-ring min-h-11 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  ไปหน้าสร้างสติกเกอร์ตอนนี้
                </button>
              )}

              {checkoutUrl && status !== 'success' && (
                <button
                  type="button"
                  onClick={handleResumeCheckout}
                  className="focus-ring min-h-11 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:border-emerald-300"
                >
                  กลับไปหน้าชำระเงิน
                </button>
              )}

              {(status === 'failed' || status === 'pending') && (
                <button
                  type="button"
                  onClick={handleResetPending}
                  className="focus-ring min-h-11 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 hover:border-rose-300"
                >
                  เริ่มรายการใหม่
                </button>
              )}
            </div>

            {paymentLinkId && (
              <div className="mt-4 border-t border-emerald-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowPaymentDetails((prev) => !prev)}
                  className="text-sm font-semibold text-slate-700 underline decoration-slate-300 underline-offset-4"
                >
                  {showPaymentDetails ? 'ซ่อนข้อมูลอ้างอิงรายการ' : 'ดูข้อมูลอ้างอิงรายการ'}
                </button>
                {showPaymentDetails && (
                  <div className="mt-3 rounded-2xl border border-emerald-200 bg-white/80 p-4 text-xs text-slate-500">
                    <p>Payment Link ID</p>
                    <p className="mt-1 break-all font-medium text-slate-700">{paymentLinkId}</p>
                    {expiryLabel && <p className="mt-3">หมดอายุ: {expiryLabel}</p>}
                  </div>
                )}
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
