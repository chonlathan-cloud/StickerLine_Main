import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { StickerStyle, StickerSheetConfig } from '../types';
import { downloadCurrentStickerForShare, getCurrentStickersDownloadUrl, getCurrentStickers, resetCurrentStickers, uploadImage, startGeneration, checkJobStatus } from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

type ProcessingStep = 'idle' | 'analyzing' | 'generating' | 'removing' | 'complete';

const DEFAULT_STICKER_COUNT = 16;
const ALLOWED_STICKER_COUNTS = new Set([15, 16]);
const SAVE_TO_PHOTOS_PARAM = 'saveToPhotos';
const SAVE_TO_PHOTOS_PARAM_VALUE = '1';
const DOWNLOAD_DELAY_MS = 180;

interface StickerSlot {
  id: string;
  url: string;
  locked: boolean;
}

const isSupportedStickerCount = (count: number) => ALLOWED_STICKER_COUNTS.has(count);

const STYLE_OPTIONS: Array<{
  value: StickerStyle;
  label: '2D' | '3D';
  title: string;
  hint: string;
  previewSrc: string;
}> = [
    {
      value: 'Chibi 2D',
      label: '2D',
      title: 'Chibi 2D',
      hint: 'เส้นคม สีสด',
      previewSrc: '/Chibi2D.png',
    },
    {
      value: 'Pixar 3D',
      label: '3D',
      title: 'Pixar 3D',
      hint: 'นุ่มลึก มีมิติ',
      previewSrc: '/Pixar3D.png',
    },
  ];

const GeneratePage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [processingStep, setProcessingStep] = useState<ProcessingStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [transparentImageUrl, setTransparentImageUrl] = useState<string | null>(null);
  const [stickerSlots, setStickerSlots] = useState<StickerSlot[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const isOnline = useOnlineStatus();
  const { profile, coinBalance } = useAuth();
  const [simulatedStickerCount, setSimulatedStickerCount] = useState(1);
  const [generationTargetCount, setGenerationTargetCount] = useState(DEFAULT_STICKER_COUNT);
  const [isComplianceChecking, setIsComplianceChecking] = useState(false);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharingToPhotos, setIsSharingToPhotos] = useState(false);

  const [config, setConfig] = useState<StickerSheetConfig>({
    base64Image: '',
    size: '2K',
    aspectRatio: '1:1',
    extraPrompt: '',
    style: 'Pixar 3D',
  });

  // Backend-driven: no local AI/image-processing refs needed
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!loading) {
      setSimulatedStickerCount(1);
      setIsComplianceChecking(false);
      return;
    }

    if (processingStep === 'analyzing') {
      setSimulatedStickerCount(1);
      setIsComplianceChecking(false);
      return;
    }

    if (processingStep === 'removing') {
      setSimulatedStickerCount(generationTargetCount);
      setIsComplianceChecking(true);
      return;
    }

    if (processingStep !== 'generating') return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const nextCount = Math.min(generationTargetCount, Math.max(1, Math.floor(elapsedSeconds * 1.35) + 1));
      setSimulatedStickerCount(nextCount);
      setIsComplianceChecking(Math.floor(elapsedSeconds / 2.2) % 2 === 1);
    }, 650);

    return () => window.clearInterval(interval);
  }, [loading, processingStep, generationTargetCount]);

  useEffect(() => {
    const loadCurrentSet = async () => {
      if (!profile?.userId) return;
      try {
        const data = await getCurrentStickers(profile.userId);
        const slotCount = data.result_slots?.length ?? 0;
        if (data.status === 'ok' && data.result_slots && isSupportedStickerCount(slotCount)) {
          const now = Date.now();
          const slots = data.result_slots.map((slot, index) => ({
            id: `${data.job_id ?? now}-${index}`,
            url: slot.url,
            locked: slot.locked,
          }));
          setStickerSlots(slots);
          setTransparentImageUrl(slots[0]?.url ?? null);
          setHasGenerated(true);
          setJobId(data.job_id ?? null);
          setGenerationTargetCount(slotCount);
        }
      } catch {
        // Non-blocking: ignore load failures for current set
      }
    };

    loadCurrentSet();
  }, [profile?.userId]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file only.');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        setConfig((prev) => ({ ...prev, base64Image: reader.result }));
        setHasGenerated(false);
        setTransparentImageUrl(null);
        setStickerSlots([]);
        setJobId(null);
        setGenerationTargetCount(DEFAULT_STICKER_COUNT);
        setError(null);
        if (profile?.userId) {
          resetCurrentStickers(profile.userId).catch(() => null);
        }
      }
    };

    reader.readAsDataURL(file);
  };

  const openImagePicker = () => {
    fileInputRef.current?.click();
  };

  const generateSheet = async () => {
    if (!isOnline) {
      setError('You are offline. Please connect to the internet and try again.');
      return;
    }

    if (!profile?.userId) {
      setError('Please log in with LINE before generating stickers.');
      return;
    }

    if (!config.base64Image) {
      setError('Please upload a source image first.');
      return;
    }

    const canReuseExisting = isSupportedStickerCount(stickerSlots.length);
    const unlockedCount = canReuseExisting
      ? stickerSlots.filter((slot) => !slot.locked).length
      : DEFAULT_STICKER_COUNT;

    if (canReuseExisting && unlockedCount === 0) {
      setError('เลือกอย่างน้อย 1 สติ๊กเกอร์ที่ยังไม่ล็อกก่อนกด Regenerate');
      return;
    }

    let finalStickerCount = canReuseExisting ? stickerSlots.length : DEFAULT_STICKER_COUNT;
    setGenerationTargetCount(unlockedCount);
    setLoading(true);
    setProcessingStep('analyzing');
    setError(null);
    setJobId(null);

    const pollUntilComplete = async (jobId: string) => {
      const maxAttempts = 180;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const statusResp = await checkJobStatus(jobId);
        if (statusResp.status === 'completed' && statusResp.result_slots) {
          return statusResp;
        }
        if (statusResp.status === 'failed') {
          throw new Error(statusResp.error || 'Generation failed.');
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      throw new Error('กำลังสร้างภาพใช้เวลานานกว่าปกติ โปรดลองอีกครั้งในภายหลัง');
    };

    try {
      // Step 1: Upload Image to Backend -> GCS
      const uploadResp = await uploadImage(config.base64Image, `selfie_${Date.now()}.jpg`);
      const gcsUri = uploadResp.gcs_uri;

      // Step 2: Start Generation Job on backend
      setProcessingStep('generating');
      const lockedIndices = stickerSlots
        .map((slot, index) => (slot.locked ? index : null))
        .filter((index): index is number => index !== null);

      const jobResp = await startGeneration(profile.userId, gcsUri, config.style, config.extraPrompt, lockedIndices);

      // The current backend returns result_urls directly (synchronous flow)
      let resolved = jobResp;
      if (jobResp.status !== 'completed' && jobResp.job_id) {
        resolved = await pollUntilComplete(jobResp.job_id);
      }

      const resultCount = resolved.result_slots?.length ?? 0;
      if (resolved.status === 'completed' && resolved.result_slots && isSupportedStickerCount(resultCount)) {
        const now = Date.now();
        const slots = resolved.result_slots.map((slot, index) => ({
          id: `${resolved.job_id ?? now}-${index}`,
          url: slot.url,
          locked: slot.locked,
        }));

        setStickerSlots(slots);
        setJobId(resolved.job_id || null);
        setTransparentImageUrl(slots[0]?.url ?? null);
        setHasGenerated(true);
        finalStickerCount = resultCount;
        setGenerationTargetCount(resultCount);
        setProcessingStep('complete');

        setTimeout(() => {
          const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          resultRef.current?.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'start',
          });
        }, 250);
      } else {
        throw new Error('Generation failed or returned unexpected status.');
      }
    } catch (err: any) {
      console.error('Generation Error:', err);
      const backendDetail = err?.response?.data?.detail;
      const message = typeof backendDetail === 'string' 
        ? backendDetail 
        : (backendDetail ? JSON.stringify(backendDetail) : (err.response?.data ? JSON.stringify(err.response.data) : err.message || 'Error connecting to server'));
      setError(message);
    } finally {
      setLoading(false);
      setProcessingStep('idle');
      setGenerationTargetCount(finalStickerCount);
    }
  };

  const toggleStickerLock = (index: number) => {
    setStickerSlots((prev) =>
      prev.map((slot, slotIndex) =>
        slotIndex === index
          ? { ...slot, locked: !slot.locked }
          : slot
      )
    );
    setError(null);
  };

  const sanitizeFileName = (value: string) => {
    const cleaned = value.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'stickers';
  };

  const isIOSDevice = () => {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  };

  const isAndroidDevice = () => /Android/i.test(navigator.userAgent || '');

  const isMobileDevice = () => {
    const ua = navigator.userAgent || '';
    return /Android|webOS|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints ?? 0) > 1;
  };

  const isLiffInClient = () => {
    const liffSdk = (window as any).liff;
    return Boolean(liffSdk?.isInClient?.());
  };

  const supportsFileShare = () =>
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined';

  const shouldContinueSaveToPhotosInExternalBrowser = () => {
    const currentUrl = new URL(window.location.href);
    return currentUrl.searchParams.get(SAVE_TO_PHOTOS_PARAM) === SAVE_TO_PHOTOS_PARAM_VALUE;
  };

  const clearSaveToPhotosIntent = () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete(SAVE_TO_PHOTOS_PARAM);
    window.history.replaceState({}, document.title, currentUrl.toString());
  };

  const buildExternalBrowserSaveToPhotosUrl = () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set(SAVE_TO_PHOTOS_PARAM, SAVE_TO_PHOTOS_PARAM_VALUE);
    return currentUrl.toString();
  };

  const openDownloadUrl = (url: string) => {
    const liffSdk = (window as any).liff;
    if (liffSdk?.isInClient?.()) {
      liffSdk.openWindow({ url, external: true });
      return;
    }

    if (isIOSDevice()) {
      window.location.href = url;
      return;
    }

    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const triggerBlobDownload = (blob: Blob, fileName: string) => {
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
  };

  const downloadStickerPngs = async (stickers: Array<{ blob: Blob; fileName: string }>) => {
    for (const sticker of stickers) {
      triggerBlobDownload(sticker.blob, sticker.fileName);
      await new Promise((resolve) => window.setTimeout(resolve, DOWNLOAD_DELAY_MS));
    }
  };

  const continueSaveToPhotos = async (userId: string) => {
    let stickers: Array<{ blob: Blob; fileName: string }> = [];

    try {
      setIsSharingToPhotos(true);
      setError(null);

      stickers = await Promise.all(
        stickerSlots.map(async (_slot, index) => {
          const blob = await downloadCurrentStickerForShare(userId, index);
          const fileName = `sticker-${String(index + 1).padStart(2, '0')}.png`;
          return {
            blob,
            fileName,
          };
        }),
      );

      if (supportsFileShare()) {
        const files = stickers.map(
          (sticker) => new File([sticker.blob], sticker.fileName, { type: sticker.blob.type || 'image/png' }),
        );
        const canShareFiles =
          typeof navigator.canShare === 'function' ? navigator.canShare({ files }) : true;

        if (canShareFiles) {
          await navigator.share({
            title: 'LINE Sticker PNG Set',
            files,
          });
          return;
        }
      }

      if (!supportsFileShare() && !isAndroidDevice()) {
        setError('อุปกรณ์นี้ไม่รองรับ Save to Photos โดยตรง กรุณาใช้ Download ZIP แทน');
        return;
      }

      await downloadStickerPngs(stickers);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return;
      }

      const message = err?.response?.data?.detail || err?.message || 'Save to Photos failed.';
      const isSharePermissionDenied =
        err?.name === 'NotAllowedError' || /permission denied|notallowederror/i.test(message);

      if (isAndroidDevice() && stickers.length > 0 && isSharePermissionDenied) {
        await downloadStickerPngs(stickers);
        return;
      }

      setError(
        /fetch|load failed|networkerror|prepare sticker/i.test(message)
          ? 'ไม่สามารถเตรียมไฟล์ PNG สำหรับ Save to Photos ได้ กรุณาลองใหม่อีกครั้ง'
          : message,
      );
    } finally {
      setIsSharingToPhotos(false);
    }
  };

  const handleDownload = async () => {
    if (!profile?.userId || !isSupportedStickerCount(stickerSlots.length)) {
      setError('Download is not ready yet. Please generate stickers first.');
      return;
    }

    try {
      setIsDownloading(true);
      const { url } = await getCurrentStickersDownloadUrl(profile.userId);
      if (!url) {
        throw new Error('Download URL is unavailable.');
      }

      openDownloadUrl(url);
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.message || 'Failed to download stickers.';
      setError(message);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveToPhotos = async () => {
    if (!profile?.userId || !isSupportedStickerCount(stickerSlots.length)) {
      setError('Save to Photos is not ready yet. Please generate stickers first.');
      return;
    }

    if (isAndroidDevice() && isLiffInClient()) {
      openDownloadUrl(buildExternalBrowserSaveToPhotosUrl());
      return;
    }

    if (shouldContinueSaveToPhotosInExternalBrowser()) {
      clearSaveToPhotosIntent();
    }

    await continueSaveToPhotos(profile.userId);
  };

  const lockedCount = stickerSlots.filter((slot) => slot.locked).length;
  const currentStickerCount = stickerSlots.length;
  const isMobile = isMobileDevice();
  const isAndroid = isAndroidDevice();
  const isInLiffClient = isLiffInClient();
  const shouldResumeSaveToPhotos = shouldContinueSaveToPhotosInExternalBrowser() && !isInLiffClient;
  const unlockedCount = currentStickerCount > 0 ? currentStickerCount - lockedCount : DEFAULT_STICKER_COUNT;
  const generateButtonLabel = loading
    ? 'Generating...'
    : hasGenerated
      ? lockedCount > 0
        ? `Regenerate Unchecked (${unlockedCount})`
        : 'Regenerate'
      : 'Generate';
  const generateHelperText = loading
    ? '🔄 Generating'
    : hasGenerated && currentStickerCount > 0 && lockedCount === currentStickerCount
      ? '🔒 Locked'
      : hasGenerated
        ? '✅ Ready'
        : '';

  const loadingHeadline =
    processingStep === 'analyzing'
      ? 'กำลังเตรียมภาพต้นฉบับ'
      : processingStep === 'generating'
        ? `กำลังสร้างสติ๊กเกอร์ ${simulatedStickerCount}/${generationTargetCount}`
        : processingStep === 'removing'
          ? 'กำลังเตรียมไฟล์ PNG'
          : 'พร้อมใช้งาน';

  const loadingSubtext =
    processingStep === 'analyzing'
      ? 'กำลังจัดองค์ประกอบตัวละคร'
      : processingStep === 'generating'
        ? isComplianceChecking
          ? 'กำลังตรวจสอบกฎระเบียบของ LINE'
          : `กำลังเรนเดอร์สติ๊กเกอร์ ${simulatedStickerCount}/${generationTargetCount}`
        : processingStep === 'removing'
          ? 'กำลังตัดพื้นหลังสีเขียว'
          : 'Ready';

  const simulatedProgress =
    processingStep === 'analyzing'
      ? 12
      : processingStep === 'generating'
        ? 16 + Math.round((simulatedStickerCount / generationTargetCount) * 64)
        : processingStep === 'removing'
          ? 92
          : processingStep === 'complete'
            ? 100
            : 0;

  return (
    <PageLayout isOnline={isOnline}>
      <main id="main-content" className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 pb-6 pt-3 sm:max-w-xl" aria-busy={loading}>
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-[3.5rem] border border-slate-100 border-b-[6px] border-b-slate-200/50 bg-white px-10 py-8 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.08)]">
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.25em] text-slate-400">Your Balance</p>
            <div className="flex items-center gap-3">
              {/* Detailed 3D Coin Icon */}
              <div className="relative flex h-12 w-12 items-center justify-center shrink-0">
                <div className="absolute inset-0 rounded-full bg-[#fbc02d] shadow-md" />
                <div className="absolute inset-[3px] rounded-full bg-gradient-to-b from-[#ffeb3b] to-[#f9a825] shadow-[inset_0_2px_4px_rgba(255,255,255,0.6)]" />
                <div className="absolute inset-[18%] rounded-full border-2 border-[#fbc02d]/20" />
                <span className="relative z-10 text-2xl font-black text-[#9a7b0c] drop-shadow-[0_1px_1px_rgba(255,255,255,0.8)]">C</span>
              </div>
              <p className="text-3xl font-extrabold tracking-tight text-slate-800">
                {(coinBalance ?? 0).toLocaleString()} <span className="text-xl font-bold text-slate-800">Coins</span>
              </p>
            </div>
          </div>
          <Link
            to="/payment"
            className="focus-ring flex min-h-16 items-center rounded-full bg-[#10b981] px-10 py-2 text-xl font-bold text-white shadow-[0_10px_25px_-5px_rgba(16,185,129,0.4)] transition-all hover:bg-[#059669] active:scale-95"
          >
            เติมเงิน
          </Link>
        </section>
        <section className="overflow-hidden rounded-[2.5rem] border border-slate-200 bg-white shadow-sm" aria-labelledby="upload-heading">
          <h2 id="upload-heading" className="sr-only">
            Source photo
          </h2>

          <input
            id="source-image-input"
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="sr-only"
          />

          <div className="relative overflow-hidden rounded-[2.5rem] bg-gradient-to-b from-slate-50 to-slate-100/80">
            <button
              type="button"
              onClick={openImagePicker}
              className="focus-ring relative block aspect-[11/10] w-full overflow-hidden sm:aspect-[4/3]"
              aria-label="Choose or capture source photo"
            >
              {config.base64Image ? (
                <img
                  src={config.base64Image}
                  alt="Uploaded source preview"
                  className={`h-full w-full object-cover ${loading ? 'opacity-60' : ''}`}
                />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                  <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/95 text-slate-700 shadow-lg ring-1 ring-slate-200">
                    <svg className="h-11 w-11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                    </svg>
                  </span>
                </span>
              )}
              <span className="sr-only">Open camera or photo library</span>
            </button>

            {!config.base64Image && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 flex items-center justify-center gap-2" aria-hidden="true">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm ring-1 ring-slate-200">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path
                      d="M4 8h3l2-2h6l2 2h3v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                </span>
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 shadow-sm ring-1 ring-slate-200">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="4" y="5" width="16" height="14" rx="2" />
                    <path d="m8 13 2-2 4 4 2-2 2 2" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="9" cy="9" r="1.25" />
                  </svg>
                </span>
              </div>
            )}

            {config.base64Image && !loading && (
              <button
                type="button"
                onClick={openImagePicker}
                className="focus-ring absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/95 text-slate-700 shadow-sm ring-1 ring-slate-200"
                aria-label="Replace source photo"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path
                    d="M4 8h3l2-2h6l2 2h3v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
              </button>
            )}

            {loading && (
              <div className="pointer-events-none absolute inset-0 flex items-end p-3">
                <div
                  className="w-full rounded-2xl bg-black/25 p-3 text-white backdrop-blur-[2px]"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" aria-hidden="true" />
                    <p className="text-sm font-semibold text-white">{loadingHeadline}</p>
                  </div>
                  <p className="mt-1 text-xs text-white/90">{loadingSubtext}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/30">
                    <span
                      className="block h-full rounded-full bg-indigo-300 transition-all duration-500"
                      style={{ width: `${simulatedProgress}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

        </section>

        <section className="relative rounded-[2.5rem] border border-slate-100 bg-white p-7 shadow-[0_15px_40px_rgba(0,0,0,0.04)]">
          <div className="space-y-6">
            <fieldset>
              <legend className="text-2xl font-black tracking-tight text-slate-800">Style</legend>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {STYLE_OPTIONS.map((styleOption) => {
                  const selected = config.style === styleOption.value;
                  return (
                    <label
                      key={styleOption.value}
                      className={`relative flex cursor-pointer items-center gap-4 overflow-hidden rounded-[1.5rem] border-2 p-3 transition-all duration-300 ${selected
                        ? 'border-indigo-400 bg-indigo-50/30 shadow-[0_0_20px_rgba(99,102,241,0.15)]'
                        : 'border-slate-100 bg-white hover:border-slate-200 shadow-sm'
                        }`}
                    >
                      {/* Active State Glass Effect + Sparkles */}
                      {selected && (
                        <>
                          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 backdrop-blur-[2px]" />
                          <svg className="absolute inset-0 h-full w-full opacity-40 pointer-events-none" viewBox="0 0 100 100">
                            <circle cx="20" cy="30" r="0.8" fill="white" className="animate-pulse" />
                            <circle cx="75" cy="65" r="1.2" fill="white" className="animate-pulse" style={{ animationDelay: '0.5s' }} />
                            <circle cx="40" cy="85" r="0.8" fill="white" className="animate-pulse" style={{ animationDelay: '1s' }} />
                            <circle cx="85" cy="15" r="1.0" fill="white" className="animate-pulse" style={{ animationDelay: '0.2s' }} />
                          </svg>
                        </>
                      )}

                      <div className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${selected ? 'border-indigo-500 bg-indigo-500' : 'border-slate-200'
                        }`}>
                        {selected && <div className="h-2 w-2 rounded-full bg-white shadow-[0_0_8px_white]" />}
                      </div>

                      <div className={`relative z-10 flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-slate-100 shadow-inner transition-transform duration-500 ${selected ? 'scale-110' : ''}`}>
                        <img
                          src={styleOption.previewSrc}
                          alt={styleOption.label}
                          className="h-full w-full object-contain"
                        />
                      </div>

                      <div className="relative z-10 min-w-0">
                        <span className="block text-lg font-black leading-none text-slate-800">{styleOption.label}</span>
                        <span className="mt-1 block text-sm font-bold text-slate-600/80">{styleOption.title}</span>
                        <span className="mt-0.5 block text-xs font-medium text-slate-400">{styleOption.hint}</span>
                      </div>

                      <input
                        type="radio"
                        name="sticker-style"
                        value={styleOption.value}
                        checked={selected}
                        onChange={() => setConfig((prev) => ({ ...prev, style: styleOption.value }))}
                        className="sr-only"
                      />
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="space-y-4">
              <h3 className="text-xl font-black tracking-tight text-slate-800">Concept</h3>
              <div className="overflow-hidden rounded-[2rem] bg-slate-50/50 p-4 ring-1 ring-slate-100">
                <div className="relative flex items-start gap-3">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 shadow-sm ring-1 ring-blue-100">
                    <svg className="h-5 w-5 fill-blue-500 text-blue-500 drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]" viewBox="0 0 24 24">
                      <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
                    </svg>
                  </div>
                  <textarea
                    id="prompt-details"
                    value={config.extraPrompt}
                    onChange={(e) => setConfig((prev) => ({ ...prev, extraPrompt: e.target.value }))}
                    placeholder="Describe your image..."
                    rows={2}
                    className="w-full resize-none bg-transparent py-1 text-base font-medium text-slate-700 placeholder:text-slate-400 focus:outline-none"
                  />
                </div>
                <div className="mt-3 border-t border-slate-200/50 pt-3">
                  <p className="text-xs font-semibold text-slate-400">
                    e.g. "A boy wearing hoodie in cyberpunk city"
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={generateSheet}
                disabled={
                  loading
                  || !config.base64Image
                  || !isOnline
                  || (hasGenerated && currentStickerCount > 0 && lockedCount === currentStickerCount)
                }
                className="relative h-16 w-full overflow-hidden rounded-full font-black text-white shadow-2xl transition-all hover:scale-[1.01] hover:shadow-indigo-500/25 active:scale-95 disabled:grayscale disabled:opacity-50"
              >
                {/* Vibrant Gradient Background */}
                <div className="absolute inset-0 bg-gradient-to-r from-blue-400 via-indigo-500 to-purple-600 animate-gradient-x" />
                
                {/* Particle Overlay */}
                <svg className="absolute inset-0 h-full w-full opacity-30" viewBox="0 0 100 100">
                  <circle cx="10" cy="20" r="1" fill="white" className="animate-pulse" />
                  <circle cx="90" cy="50" r="0.8" fill="white" className="animate-pulse" />
                  <circle cx="30" cy="80" r="1.2" fill="white" className="animate-pulse" />
                  <circle cx="60" cy="20" r="0.5" fill="white" className="animate-pulse" />
                </svg>

                <span className="relative z-10 flex items-center justify-center gap-2 text-xl tracking-wide">
                  {loading && <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
                  {generateButtonLabel}
                </span>
              </button>
            </div>
          </div>
        </section>

            {generateHelperText && (
              <p id="generate-helper" className="text-sm text-slate-700" role="status" aria-live="polite">
                {generateHelperText}
              </p>
            )}

        {error && (
          <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {transparentImageUrl && (
          <section
            ref={resultRef}
            className="rounded-[2.5rem] border border-slate-200 bg-white p-6 shadow-sm"
            aria-labelledby="preview-heading"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="preview-heading" className="text-lg font-semibold text-slate-900">
                Preview
              </h2>
              <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">PNG ready</span>
            </div>

            {isSupportedStickerCount(currentStickerCount) ? (
              <>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-slate-700">ติ๊กถูกที่สติ๊กเกอร์ที่ต้องการเก็บไว้ก่อนกด Regenerate</p>
                  <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700">
                    Locked {lockedCount}/{currentStickerCount}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-3">
                  {stickerSlots.map((slot, index) => (
                    <button
                      type="button"
                      key={slot.id}
                      onClick={() => toggleStickerLock(index)}
                      disabled={loading}
                      aria-pressed={slot.locked}
                      aria-label={`Select sticker ${index + 1}`}
                      className={`relative block overflow-hidden rounded-2xl border bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgHQAmUPwdICYAOIyDPr5CABdamAivXkrFgAAAABJRU5ErkJggg==')] bg-repeat p-[3px] ${slot.locked ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-slate-200'
                        }`}
                    >
                      <img
                        src={slot.url}
                        alt={`Sticker ${index + 1}`}
                        className="focus-ring aspect-square w-full rounded-xl bg-white object-contain"
                      />
                      {slot.locked && (
                        <>
                          <span className="pointer-events-none absolute inset-[3px] rounded-xl bg-emerald-400/20" aria-hidden="true" />
                          <span
                            className="pointer-events-none absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/90 text-xs font-bold text-white shadow"
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-5 overflow-hidden rounded-[2rem] border border-slate-200 bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgHQAmUPwdICYAOIyDPr5CABdamAivXkrFgAAAABJRU5ErkJggg==')] bg-repeat p-2">
                <img
                  src={transparentImageUrl}
                  alt="Generated transparent sticker sheet preview"
                  className="aspect-square w-full rounded-[1.5rem] bg-white object-contain"
                />
              </div>
            )}

            <div className="mt-4 space-y-2">
              {isMobile ? (
                <button
                  type="button"
                  onClick={handleSaveToPhotos}
                  disabled={isSharingToPhotos || !isSupportedStickerCount(currentStickerCount)}
                  className="focus-ring min-h-11 w-full rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {isSharingToPhotos ? 'Preparing PNGs...' : 'Save to Photos'}
                </button>
              ) : null}

              <button
                type="button"
                onClick={handleDownload}
                disabled={isDownloading || !isSupportedStickerCount(currentStickerCount)}
                className={`focus-ring min-h-11 w-full rounded-2xl border px-4 py-3 text-sm font-semibold ${
                  isMobile
                    ? 'border-slate-300 bg-white text-slate-900 hover:border-indigo-500 hover:text-indigo-700'
                    : 'border-slate-300 bg-white text-slate-900 hover:border-indigo-500 hover:text-indigo-700'
                } disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400`}
              >
                {isDownloading ? 'Preparing ZIP...' : 'Download ZIP'}
              </button>

              {isMobile && isAndroid && isInLiffClient ? (
                <p className="text-sm text-slate-600">
                  บน Android ใน LINE ระบบจะเปิดเบราว์เซอร์ภายนอกให้ก่อน แล้วค่อยบันทึกรูปจากที่นั่น
                </p>
              ) : null}

              {isMobile && shouldResumeSaveToPhotos ? (
                <p className="text-sm text-slate-600">
                  ตอนนี้เปิดในเบราว์เซอร์ภายนอกแล้ว กด Save to Photos อีกครั้งเพื่อแชร์หรือดาวน์โหลด PNG
                </p>
              ) : null}

              {isMobile && !isAndroid && !supportsFileShare() ? (
                <p className="text-sm text-slate-600">
                  อุปกรณ์นี้ไม่รองรับ Save to Photos โดยตรง กรุณาใช้ Download ZIP แทน
                </p>
              ) : null}
            </div>
          </section>
        )}

      </main>
    </PageLayout>
  );
};

export default GeneratePage;
