import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { createPayment, getPaymentStatus } from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

// --- Icons ---
const WalletIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
  </svg>
);

const CreditCardIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <line x1="2" x2="22" y1="10" y2="10" />
  </svg>
);

const ClockIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const ShieldCheckIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const ZapIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const WalletOutlineIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
  </svg>
);

const PlusCircleIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10"/>
    <path d="M8 12h8"/>
    <path d="M12 8v8"/>
  </svg>
);

const ChevronRightIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m9 18 6-6-6-6"/>
  </svg>
);

type PackageOption = {
  id: 'pkg_70' | 'pkg_100';
  title: string;
  subtitle: string;
  price: string;
  coins: number;
  highlight?: string;
  paymentMethods: string;
};

type PaymentFlowStatus = 'idle' | 'redirecting' | 'checking' | 'pending' | 'success' | 'failed';

const PACKAGES: PackageOption[] = [
  { 
    id: 'pkg_70', 
    title: 'แพ็กเริ่มต้น', 
    subtitle: 'เหมาะสำหรับลองใช้งานครั้งแรก',
    price: '70 THB', 
    coins: 7,
    paymentMethods: 'ชำระผ่าน Beam / UOB'
  },
  { 
    id: 'pkg_100', 
    title: 'แพ็กคุ้มค่า', 
    subtitle: 'แพ็กยอดนิยม ได้เหรียญคุ้มกว่า',
    price: '100 THB', 
    coins: 12, 
    highlight: 'โบนัส +2 เหรียญ',
    paymentMethods: 'ชำระผ่าน Beam / UOB'
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
  const activePackage = PACKAGES.find((pkg) => pkg.id === (selectedPackageId ?? pendingPackageId)) ?? null;

  const projectedCoinBalance = useMemo(() => {
    if (coinBalance == null || !pendingPackage || status === 'success') return null;
    return coinBalance + pendingPackage.coins;
  }, [coinBalance, pendingPackage, status]);

  const expiryLabel = useMemo(() => formatDateTime(expiresAt), [expiresAt]);
  const expiryHint = useMemo(() => formatRemainingTime(expiresAt), [expiresAt]);
  const currentCoins = coinBalance || 0;

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
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-12 pt-6">
        
        {/* Top Header Card */}
        <section className="rounded-[28px] bg-white p-6 md:p-8 shadow-sm border border-slate-200 flex flex-col gap-6 relative">
          
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-3 text-slate-500">
              <PlusCircleIcon className="w-5 h-5" />
              <p className="text-sm font-bold">เติมเหรียญ</p>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold mb-3 tracking-tight text-slate-900">เติมเหรียญเพื่อสร้างสติ๊กเกอร์</h2>
            <p className="text-slate-500 text-sm md:text-base font-medium max-w-xl">
              ระบบจะพาไปหน้าชำระเงินที่ปลอดภัย และพากลับอัตโนมัติ
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 relative z-10">
            {/* Card 1 */}
            <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-blue-100 text-blue-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <WalletIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">เหรียญของคุณ</p>
              </div>
              <p className="text-3xl font-extrabold text-slate-900">{currentCoins} <span className="text-sm font-semibold text-slate-500">เหรียญ</span></p>
            </div>
            
            {/* Card 2 */}
            <div className="bg-emerald-50/50 rounded-2xl p-5 border border-emerald-50 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-emerald-100 text-emerald-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <CreditCardIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">ช่องทางชำระเงิน</p>
              </div>
              <p className="text-sm font-bold leading-relaxed text-slate-600">บัตร / PromptPay,<br />Mobile Banking</p>
            </div>

            {/* Card 3 */}
            <div className="bg-purple-50/50 rounded-2xl p-5 border border-purple-50 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-purple-100 text-purple-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <ClockIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">เหรียญเข้าเมื่อ</p>
              </div>
              <p className="text-sm font-bold leading-relaxed text-slate-600">ชำระเงินสำเร็จ</p>
            </div>
          </div>

          <hr className="border-slate-100 my-2" />

          {/* Badges */}
          <div className="flex flex-col sm:flex-row gap-4 sm:gap-0 justify-between text-xs md:text-sm font-bold text-slate-600">
            <div className="flex items-center gap-2 flex-1 justify-center sm:justify-start">
              <ShieldCheckIcon className="w-5 h-5 text-slate-500" /> ชำระเงินปลอดภัย
            </div>
            <div className="hidden sm:block w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-2 flex-1 justify-center">
              <WalletOutlineIcon className="w-5 h-5 text-slate-500 shrink-0" /> <span className="text-center sm:text-left">รองรับ PromptPay<br className="hidden md:block" />และ Mobile Banking</span>
            </div>
            <div className="hidden sm:block w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-2 flex-1 justify-center sm:justify-end">
              <ZapIcon className="w-5 h-5 text-slate-500" /> เหรียญเข้าอัตโนมัติทันที
            </div>
          </div>
        </section>

        {(pendingPackage || status === 'success') && (
          <section className="rounded-[28px] border border-emerald-200 bg-emerald-50/80 p-6 shadow-sm">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
              <div className="max-w-xl">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-600">Payment Status</p>
                <h3 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">
                  {status === 'success'
                    ? 'ชำระเงินสำเร็จ'
                    : status === 'failed'
                      ? 'รายการชำระเงินมีปัญหา'
                      : status === 'checking'
                        ? 'กำลังตรวจสอบสถานะการชำระเงิน'
                        : status === 'redirecting'
                          ? 'กำลังเปิดหน้าชำระเงิน'
                          : 'มีรายการชำระเงินรอดำเนินการ'}
                </h3>
                <p className="mt-2 text-sm font-medium text-slate-600">
                  {status === 'success'
                    ? `เติม ${pendingPackage?.coins ?? activePackage?.coins ?? 0} เหรียญเรียบร้อยแล้ว กำลังพากลับไปหน้าสร้างสติกเกอร์`
                    : activePackage
                      ? `แพ็ก ${activePackage.title} จำนวน ${activePackage.price} พร้อมชำระผ่าน Beam / UOB`
                      : 'คุณสามารถกลับไปที่หน้าชำระเงินเดิมหรือตรวจสอบสถานะรายการล่าสุดได้'}
                </p>
                {(status === 'pending' || status === 'checking' || status === 'redirecting') && (
                  <div className="mt-4 rounded-2xl border border-white/80 bg-white/80 p-4 text-sm text-slate-700">
                    <p className="font-bold text-slate-900">หากชำระเงินแล้วแต่ยอดยังไม่เข้า</p>
                    <p className="mt-1">กดปุ่มตรวจสอบสถานะอีกครั้ง ระบบจะเช็กกับ Beam โดยตรง</p>
                    {expiryLabel && <p className="mt-3 text-xs font-medium text-slate-500">หมดอายุ: {expiryLabel}</p>}
                    {expiryHint && <p className="mt-1 text-xs font-medium text-slate-500">{expiryHint}</p>}
                  </div>
                )}
              </div>

              <div className="rounded-[24px] border border-emerald-200 bg-white px-5 py-4 md:min-w-56">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">เหรียญที่จะได้รับ</p>
                <p className="mt-2 text-3xl font-extrabold text-slate-900">
                  +{pendingPackage?.coins ?? activePackage?.coins ?? 0}
                </p>
                {status !== 'success' && projectedCoinBalance != null && (
                  <p className="mt-2 text-xs font-medium text-slate-500">หลังชำระจะมีประมาณ {projectedCoinBalance} เหรียญ</p>
                )}
                {status === 'success' && (
                  <p className="mt-2 text-xs font-medium text-emerald-700">ยอดล่าสุด {currentCoins.toLocaleString()} เหรียญ</p>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {status !== 'success' ? (
                <button
                  type="button"
                  onClick={() => handleCheckStatus()}
                  disabled={!paymentLinkId || status === 'checking'}
                  className="focus-ring min-h-12 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {status === 'checking' ? 'กำลังตรวจสอบ...' : 'ฉันชำระเงินแล้ว'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSuccessReturn}
                  className="focus-ring min-h-12 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-emerald-700"
                >
                  กลับไปหน้าสร้างสติกเกอร์
                </button>
              )}

              {checkoutUrl && status !== 'success' && (
                <button
                  type="button"
                  onClick={handleResumeCheckout}
                  className="focus-ring min-h-12 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 transition hover:border-emerald-300"
                >
                  กลับไปหน้าชำระเงิน
                </button>
              )}

              {(status === 'failed' || status === 'pending') && (
                <button
                  type="button"
                  onClick={handleResetPending}
                  className="focus-ring min-h-12 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 transition hover:border-rose-300"
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
                  className="text-sm font-bold text-slate-700 underline decoration-slate-300 underline-offset-4"
                >
                  {showPaymentDetails ? 'ซ่อนข้อมูลอ้างอิงรายการ' : 'ดูข้อมูลอ้างอิงรายการ'}
                </button>
                {showPaymentDetails && (
                  <div className="mt-3 rounded-2xl border border-emerald-200 bg-white/90 p-4 text-xs text-slate-500">
                    <p>Payment Link ID</p>
                    <p className="mt-1 break-all font-semibold text-slate-700">{paymentLinkId}</p>
                    {expiryLabel && <p className="mt-3">หมดอายุ: {expiryLabel}</p>}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Packages List */}
        <section className="flex flex-col gap-4">
          {PACKAGES.map((pkg) => (
            <button
              key={pkg.id} 
              type="button"
              onClick={() => handleSelectPackage(pkg)}
              disabled={status === 'redirecting' || status === 'checking'}
              className={`group relative overflow-hidden rounded-[24px] border bg-white p-6 text-left shadow-sm transition-all ${
                pendingPackageId === pkg.id
                  ? 'border-emerald-300 shadow-md shadow-emerald-100/60'
                  : 'border-slate-200 hover:border-slate-300 hover:shadow-md'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {/* Left colored line */}
              <div className={`absolute top-0 left-0 bottom-0 w-1.5 ${pkg.id === 'pkg_70' ? 'bg-blue-500' : 'bg-emerald-500'}`} />

              <div className="flex flex-col gap-1.5 w-full md:w-auto pl-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-extrabold text-xl text-slate-900 group-hover:text-blue-600 transition-colors">{pkg.title}</h3>
                  {pkg.highlight && (
                    <span className="bg-emerald-50 text-emerald-600 text-xs px-2.5 py-1 rounded-full font-bold border border-emerald-100">
                      {pkg.highlight}
                    </span>
                  )}
                </div>
                <p className="text-slate-500 text-sm font-medium">{pkg.subtitle}</p>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-3xl font-extrabold text-blue-500">{pkg.coins}</span>
                  <span className="text-slate-500 text-sm font-bold">เหรียญ</span>
                </div>
                <p className="text-slate-400 text-xs font-medium">เติมแล้วจะมีประมาณ {currentCoins + pkg.coins} เหรียญ</p>
                {selectedPackageId === pkg.id && status === 'redirecting' && (
                  <p className="mt-3 text-xs font-bold text-blue-600">กำลังเปิดหน้าชำระเงิน...</p>
                )}
              </div>

              <div className="mt-6 md:mt-0 flex items-center justify-between w-full md:w-auto border-t md:border-t-0 border-slate-100 pt-4 md:pt-0 gap-6">
                <div className="flex flex-col items-start md:items-end">
                  <div className="font-extrabold text-2xl text-slate-900">{pkg.price}</div>
                  <div className="text-slate-400 text-xs mt-1 font-medium">{pkg.paymentMethods}</div>
                </div>
                <div className="w-10 h-10 rounded-full border border-slate-200 flex items-center justify-center text-slate-400 group-hover:border-blue-500 group-hover:text-blue-500 transition-colors bg-white shadow-sm">
                  <ChevronRightIcon className="w-5 h-5" />
                </div>
              </div>
            </button>
          ))}
        </section>

        {error && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800 shadow-sm" role="alert">
            {error}
          </div>
        )}
      </main>

    </PageLayout>
  );
};

export default PaymentPage;
