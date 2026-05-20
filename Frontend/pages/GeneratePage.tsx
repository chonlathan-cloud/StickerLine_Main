import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExtraPickResponse, StickerSlotResponse } from '../api/client';
import { StickerStyle, StickerSheetConfig } from '../types';
import {
  applyCurrentExtraPicks,
  checkJobStatus,
  downloadCurrentStickerForShare,
  getCurrentStickers,
  getCurrentStickersDownloadUrl,
  resetCurrentStickers,
  startGeneration,
  unlockCurrentExtraPicks,
  uploadImage,
} from '../api/client';
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
interface ExtraPickSlot {
  id: string;
  index: number;
  url: string | null;
  previewUrl: string | null;
}

interface CurrentGenerationPayload {
  status: 'ok' | 'empty';
  job_id?: string | null;
  sticker_count?: number;
  result_slots?: StickerSlotResponse[];
  extra_pick_count?: number;
  extra_picks_unlocked?: boolean;
  extra_picks?: ExtraPickResponse[];
}

const isSupportedStickerCount = (count: number) => ALLOWED_STICKER_COUNTS.has(count);

const buildSaveToPhotosBatchId = () => {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${randomSuffix}`;
};

const buildStickerPngFileName = (index: number, batchId: string) =>
  `sticker-${batchId}-${String(index + 1).padStart(2, '0')}.png`;

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
  const { profile, coinBalance, refreshProfile } = useAuth();
  const [simulatedStickerCount, setSimulatedStickerCount] = useState(1);
  const [generationTargetCount, setGenerationTargetCount] = useState(DEFAULT_STICKER_COUNT);
  const [isComplianceChecking, setIsComplianceChecking] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharingToPhotos, setIsSharingToPhotos] = useState(false);
  const [extraPickSlots, setExtraPickSlots] = useState<ExtraPickSlot[]>([]);
  const [isExtraPicksUnlocked, setIsExtraPicksUnlocked] = useState(false);
  const [isUnlockingExtraPicks, setIsUnlockingExtraPicks] = useState(false);
  const [isApplyingExtraPicks, setIsApplyingExtraPicks] = useState(false);
  const [isPromptGuideOpen, setIsPromptGuideOpen] = useState(false);

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
  const hydrateCurrentGeneration = (data: CurrentGenerationPayload) => {
    const now = Date.now();
    const resultSlots = data.result_slots ?? [];
    const stickerCount = resultSlots.length;
    const extraPicks = data.extra_picks ?? [];

    if (data.status === 'ok' && isSupportedStickerCount(stickerCount)) {
      const slots = resultSlots.map((slot, index) => ({
        id: `${data.job_id ?? now}-${index}`,
        url: slot.url,
        locked: slot.locked,
      }));
      setStickerSlots(slots);
      setTransparentImageUrl(slots[0]?.url ?? null);
      setHasGenerated(true);
      setJobId(data.job_id ?? null);
      setGenerationTargetCount(stickerCount);
    } else if (data.status === 'empty') {
      setStickerSlots([]);
      setTransparentImageUrl(null);
      setHasGenerated(false);
      setJobId(data.job_id ?? null);
      setGenerationTargetCount(DEFAULT_STICKER_COUNT);
    }

    setExtraPickSlots(
      extraPicks.map((pick, index) => ({
        id: `${data.job_id ?? now}-extra-${index}`,
        index: pick.index,
        url: pick.url ?? null,
        previewUrl: pick.preview_url ?? null,
      })),
    );
    setIsExtraPicksUnlocked(Boolean(data.extra_picks_unlocked));
  };

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
        hydrateCurrentGeneration(data);
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
        setExtraPickSlots([]);
        setIsExtraPicksUnlocked(false);
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

        setProcessingStep('complete');

        try {
          const currentData = await getCurrentStickers(profile.userId);
          hydrateCurrentGeneration(currentData);
          finalStickerCount = currentData.result_slots?.length ?? resultCount;
        } catch {
          // Fallback to the completed job payload when the follow-up sync fails.
          setStickerSlots(slots);
          setJobId(resolved.job_id || null);
          setTransparentImageUrl(slots[0]?.url ?? null);
          setHasGenerated(true);
          setExtraPickSlots([]);
          setIsExtraPicksUnlocked(false);
          finalStickerCount = resultCount;
          setGenerationTargetCount(resultCount);
        }

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

  const setAllStickerLocks = (locked: boolean) => {
    setStickerSlots((prev) => prev.map((slot) => ({ ...slot, locked })));
    setError(null);
  };

  const handleUnlockExtraPicks = async () => {
    if (!profile?.userId || extraPickSlots.length === 0) {
      setError('ไม่มี Extra Picks ให้ปลดล็อกในรอบนี้');
      return;
    }

    try {
      setIsUnlockingExtraPicks(true);
      setError(null);
      const data = await unlockCurrentExtraPicks(profile.userId);
      hydrateCurrentGeneration(data);
      await refreshProfile();
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.message || 'Failed to unlock Extra Picks.';
      setError(message);
    } finally {
      setIsUnlockingExtraPicks(false);
    }
  };

  const handleUseExtraPick = async (index: number) => {
    if (!profile?.userId) {
      setError('กรุณาเข้าสู่ระบบก่อนใช้งาน Extra Picks');
      return;
    }

    try {
      setIsApplyingExtraPicks(true);
      setError(null);
      const data = await applyCurrentExtraPicks(profile.userId, [index]);
      hydrateCurrentGeneration(data);
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.message || 'Failed to move extra pick into the final pack.';
      setError(message);
    } finally {
      setIsApplyingExtraPicks(false);
    }
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

      const saveBatchId = buildSaveToPhotosBatchId();
      stickers = await Promise.all(
        stickerSlots.map(async (_slot, index) => {
          const blob = await downloadCurrentStickerForShare(userId, index);
          const fileName = buildStickerPngFileName(index, saveBatchId);
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
  const canReuseExisting = isSupportedStickerCount(currentStickerCount);
  const unlockedCount = currentStickerCount > 0 ? currentStickerCount - lockedCount : DEFAULT_STICKER_COUNT;
  const regenerateCount = canReuseExisting ? unlockedCount : DEFAULT_STICKER_COUNT;
  const keepCount = canReuseExisting ? lockedCount : 0;
  const canGenerate = Boolean(config.base64Image) && isOnline && (!hasGenerated || lockedCount < currentStickerCount);
  const generateButtonLabel = loading
    ? 'Generating...'
    : hasGenerated
      ? lockedCount > 0
        ? `Regenerate ${regenerateCount} Slots`
        : 'Generate All Again'
      : 'Generate';
  const generateHelperText = loading
    ? '🔄 Generating'
    : hasGenerated && currentStickerCount > 0 && lockedCount === currentStickerCount
      ? 'เลือกปลดอย่างน้อย 1 รูปเพื่อเริ่มรอบถัดไป'
      : hasGenerated
        ? `รอบถัดไปจะคงไว้ ${keepCount} รูป และสร้างใหม่ ${regenerateCount} รูป`
        : '';
  const selectionHeading = hasGenerated
    ? lockedCount === 0
      ? 'ยังไม่ได้เลือกภาพที่จะเก็บไว้'
      : `เก็บไว้แล้ว ${keepCount} รูป`
    : 'อัปโหลดรูปแล้วเริ่มสร้างได้ทันที';
  const selectionSubtext = hasGenerated
    ? lockedCount === currentStickerCount
      ? 'ตอนนี้ทั้งชุดถูกเก็บไว้ทั้งหมด ปลดอย่างน้อย 1 รูปก่อนกด regenerate รอบใหม่'
      : 'แตะรูปที่ชอบเพื่อเก็บ slot เดิมไว้ รอบถัดไประบบจะสร้างเฉพาะรูปที่ไม่ถูกเลือก'
    : 'รอบแรกระบบจะสร้างครบ 16 รูป จากรูปต้นฉบับและ concept ที่กรอกไว้';

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
        <section className="relative overflow-hidden rounded-[2rem] sm:rounded-[2.5rem] border border-slate-200/50 bg-white p-5 sm:p-7 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.08)]">
          {/* Subtle luxurious background accent */}
          <div className="absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 rounded-full bg-emerald-50/50 blur-3xl pointer-events-none"></div>
          <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 rounded-full bg-amber-50/50 blur-3xl pointer-events-none"></div>
          
          <div className="relative z-10 flex flex-row items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5 min-w-0">
              <p className="text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.25em] text-slate-400">Your Balance</p>
              
              <div className="flex items-center gap-3 sm:gap-4 mt-1">
                {/* Original Coin Icon */}
                <div className="relative flex h-10 w-10 sm:h-14 sm:w-14 items-center justify-center shrink-0">
                  <div className="absolute inset-0 rounded-full bg-[#fbc02d] shadow-md" />
                  <div className="absolute inset-[2px] rounded-full bg-gradient-to-b from-[#ffeb3b] to-[#f9a825] shadow-[inset_0_1.5px_3px_rgba(255,255,255,0.6)]" />
                  <div className="absolute inset-[18%] rounded-full border border-[#fbc02d]/20" />
                  <span className="relative z-10 text-xl sm:text-3xl font-black text-[#9a7b0c] drop-shadow-[0_1px_1px_rgba(255,255,255,0.8)]">C</span>
                </div>

                <div className="flex items-baseline gap-1.5 sm:gap-2">
                  <p className="text-3xl sm:text-[40px] font-extrabold tracking-tight text-slate-800 leading-none">
                    {(coinBalance ?? 0).toLocaleString()} 
                  </p>
                  <p className="text-sm sm:text-base font-bold text-slate-400">Coins</p>
                </div>
              </div>
            </div>
            
            <Link
              to="/payment"
              className="focus-ring group relative flex shrink-0 items-center justify-center gap-1.5 sm:gap-2 overflow-hidden rounded-[1.25rem] sm:rounded-[1.5rem] bg-emerald-600 px-5 sm:px-7 py-3 sm:py-3.5 text-sm sm:text-base font-bold text-white shadow-[0_8px_20px_-4px_rgba(16,185,129,0.4),inset_0_1px_1px_rgba(255,255,255,0.2)] transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_24px_-6px_rgba(16,185,129,0.5)] hover:bg-emerald-500 active:scale-95"
            >
              {/* Shine effect */}
              <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-in-out group-hover:translate-x-full"></div>
              
              <svg className="relative z-10 h-4 w-4 sm:h-5 sm:w-5 text-white/90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="relative z-10">เติมเงิน</span>
            </Link>
          </div>
        </section>
        <section className="p-3 bg-white rounded-[2.5rem] shadow-sm" aria-labelledby="upload-heading">
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

          <div className="relative overflow-hidden rounded-[2rem] border-2 border-dashed border-slate-200 bg-[#F8FAFC]">
            <button
              type="button"
              onClick={openImagePicker}
              className="focus-ring relative block aspect-[11/10] w-full overflow-hidden sm:aspect-[4/3] flex flex-col items-center justify-center"
              aria-label="Choose or capture source photo"
            >
              {config.base64Image ? (
                <img
                  src={config.base64Image}
                  alt="Uploaded source preview"
                  className={`h-full w-full object-cover ${loading ? 'opacity-60' : ''}`}
                />
              ) : (
                <div className="flex flex-col items-center justify-center mt-[-2rem]">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white shadow-sm mb-4">
                    <svg className="h-10 w-10 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                    </svg>
                  </div>
                  <span className="text-lg font-bold text-slate-800">เพิ่มรูปภาพ</span>
                  <span className="text-sm font-medium text-slate-400 mt-1">หรือ ลากและวางไฟล์ที่นี่</span>
                </div>
              )}
              <span className="sr-only">Open camera or photo library</span>
            </button>

            {!config.base64Image && (
              <div className="absolute inset-x-0 bottom-8 flex items-center justify-center gap-4" aria-hidden="true">
                <button type="button" onClick={openImagePicker} className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm border border-slate-100 hover:bg-slate-50 transition-colors">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path
                      d="M4 8h3l2-2h6l2 2h3v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                </button>
                <button type="button" onClick={openImagePicker} className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm border border-slate-100 hover:bg-slate-50 transition-colors">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="4" y="5" width="16" height="14" rx="2" />
                    <path d="m8 13 2-2 4 4 2-2 2 2" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="9" cy="9" r="1.25" />
                  </svg>
                </button>
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
            <section className="relative overflow-hidden rounded-[2rem] border border-white/60 bg-gradient-to-br from-[#f2f7ff] via-[#f8faff] to-[#edf4ff] p-5 shadow-[0_8px_30px_rgb(0,0,0,0.03)]">
              {/* Decorative elements - sparkles and background patterns */}
              <div className="pointer-events-none absolute inset-0 opacity-40 mix-blend-overlay" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>
              <svg className="absolute left-1/2 top-6 h-5 w-5 text-blue-300 animate-pulse" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L13.5 9.5L21 11L13.5 12.5L12 20L10.5 12.5L3 11L10.5 9.5L12 2Z"/></svg>
              <svg className="absolute right-4 top-1/2 h-4 w-4 text-indigo-200 animate-pulse" style={{ animationDelay: '1s' }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L13.5 9.5L21 11L13.5 12.5L12 20L10.5 12.5L3 11L10.5 9.5L12 2Z"/></svg>

              <div className="relative z-10 flex">
                {/* Left Side Texts */}
                <div className="flex-1 pr-2 sm:pr-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-600/80">Regenerate Flow</p>
                  <h2 className="mt-2 text-xl font-black leading-tight tracking-tight text-slate-900 sm:text-[22px]">{selectionHeading}</h2>
                  <p className="mt-2 max-w-xs text-xs font-medium leading-relaxed text-slate-500 sm:text-[13px]">
                    {selectionSubtext}
                  </p>

                  {/* NEXT ROUND Card */}
                  <div className="mt-5 inline-block min-w-[140px] rounded-[1.25rem] bg-white p-4 shadow-sm ring-1 ring-slate-100/50">
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-blue-400">Next Round</p>
                    <p className="mt-1 text-[32px] font-black leading-none text-blue-600">{regenerateCount}</p>
                    <p className="mt-1.5 text-[11px] font-medium text-slate-400">images will regenerate</p>
                  </div>
                </div>

                {/* Right Side Icon */}
                <div className="relative -mr-2 flex h-[130px] w-[130px] flex-shrink-0 items-center justify-center sm:-mr-0">
                  <div className="absolute inset-0 rounded-3xl bg-blue-400/20 blur-[24px]"></div>

                  {/* Orbital ring (back layer) */}
                  <svg className="pointer-events-none absolute -inset-3 h-[calc(100%+1.5rem)] w-[calc(100%+1.5rem)]" viewBox="0 0 100 100" fill="none">
                    <ellipse cx="50" cy="50" rx="44" ry="18" stroke="rgba(255,255,255,0.8)" strokeWidth="0.6" className="origin-center rotate-[-12deg]" />
                  </svg>

                  {/* Glass Box */}
                  <div className="group relative flex h-[100px] w-[100px] transform items-center justify-center rounded-[1.75rem] border border-white/60 bg-gradient-to-br from-white/95 via-white/50 to-white/20 shadow-[inset_-2px_-2px_8px_rgba(255,255,255,0.4),inset_2px_2px_16px_rgba(255,255,255,0.9),4px_12px_24px_rgba(59,130,246,0.15)] backdrop-blur-md transition-transform duration-500 hover:scale-105">

                    {/* Inner 3D Sync arrows */}
                    <div className="relative mt-1">
                      {/* Soft Shadow for inner SVG */}
                      <svg className="absolute h-10 w-10 translate-x-[1px] translate-y-[3px] text-indigo-900/40 blur-[4px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 11a8.1 8.1 0 0 0-8.1-8.1 8.8 8.8 0 0 0-6.1 2.5L3 8" /><path d="M3 3v5h5" /><path d="M4 13a8.1 8.1 0 0 0 8.1 8.1 8.8 8.8 0 0 0 6.1-2.5L21 16" /><path d="M21 21v-5h-5" />
                      </svg>
                      
                      {/* Extrusion / 3D depth layer 1 */}
                      <svg className="absolute h-10 w-10 translate-x-[0.5px] translate-y-[1.5px] text-indigo-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 11a8.1 8.1 0 0 0-8.1-8.1 8.8 8.8 0 0 0-6.1 2.5L3 8" /><path d="M3 3v5h5" /><path d="M4 13a8.1 8.1 0 0 0 8.1 8.1 8.8 8.8 0 0 0 6.1-2.5L21 16" /><path d="M21 21v-5h-5" />
                      </svg>
                      
                      {/* Extrusion / 3D depth layer 2 */}
                      <svg className="absolute h-10 w-10 translate-x-[0.25px] translate-y-[0.75px] text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 11a8.1 8.1 0 0 0-8.1-8.1 8.8 8.8 0 0 0-6.1 2.5L3 8" /><path d="M3 3v5h5" /><path d="M4 13a8.1 8.1 0 0 0 8.1 8.1 8.8 8.8 0 0 0 6.1-2.5L21 16" /><path d="M21 21v-5h-5" />
                      </svg>

                      {/* Foreground SVG */}
                      <svg className="relative h-10 w-10 drop-shadow-sm" viewBox="0 0 24 24" fill="none" stroke="url(#blueGradient3D)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <defs>
                          <linearGradient id="blueGradient3D" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#60a5fa" />
                            <stop offset="45%" stopColor="#3b82f6" />
                            <stop offset="80%" stopColor="#4f46e5" />
                            <stop offset="100%" stopColor="#4338ca" />
                          </linearGradient>
                        </defs>
                        <path d="M20 11a8.1 8.1 0 0 0-8.1-8.1 8.8 8.8 0 0 0-6.1 2.5L3 8" /><path d="M3 3v5h5" /><path d="M4 13a8.1 8.1 0 0 0 8.1 8.1 8.8 8.8 0 0 0 6.1-2.5L21 16" /><path d="M21 21v-5h-5" />
                      </svg>

                      {/* Top edge highlight for 3D bevel */}
                      <svg className="pointer-events-none absolute inset-0 h-10 w-10 -translate-x-[0.5px] -translate-y-[0.5px] text-white/80 mix-blend-overlay" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 11a8.1 8.1 0 0 0-8.1-8.1 8.8 8.8 0 0 0-6.1 2.5L3 8" /><path d="M3 3v5h5" /><path d="M4 13a8.1 8.1 0 0 0 8.1 8.1 8.8 8.8 0 0 0 6.1-2.5L21 16" /><path d="M21 21v-5h-5" />
                      </svg>
                    </div>

                    {/* Glossy reflection highlight on the glass block itself */}
                    <div className="pointer-events-none absolute left-[2px] right-[2px] top-[2px] h-[40%] rounded-t-[1.6rem] bg-gradient-to-b from-white/90 to-transparent opacity-95"></div>
                    
                    {/* Left edge glossy highlight */}
                    <div className="pointer-events-none absolute bottom-[2px] left-[2px] top-[2px] w-[20%] rounded-l-[1.6rem] bg-gradient-to-r from-white/80 to-transparent opacity-90"></div>
                  </div>

                  {/* Orbital ring (front layer, clipped to bottom half) */}
                  <svg className="pointer-events-none absolute z-10 -inset-3 h-[calc(100%+1.5rem)] w-[calc(100%+1.5rem)]" viewBox="0 0 100 100" fill="none">
                    <clipPath id="frontHalfRing">
                      {/* Polygon covers the bottom left half of the space to let the ring pass in front of the box */}
                      <polygon points="-20,120 120,120 120,55 -20,35" />
                    </clipPath>
                    <ellipse cx="50" cy="50" rx="44" ry="18" stroke="rgba(255,255,255,1)" strokeWidth="0.8" clipPath="url(#frontHalfRing)" className="origin-center rotate-[-12deg] drop-shadow-[0_1px_3px_rgba(255,255,255,0.8)]" />
                  </svg>
                  
                  {/* Floating Sparkles from Image 2 */}
                  <svg className="absolute -left-3 top-2 h-4 w-4 animate-pulse text-blue-300 drop-shadow-md" fill="currentColor" viewBox="0 0 24 24"><path d="M12 1L14 10L23 12L14 14L12 23L10 14L1 12L10 10L12 1Z"/></svg>
                  <svg className="absolute -bottom-2 left-6 h-3 w-3 animate-pulse text-indigo-300 drop-shadow-md" style={{ animationDelay: '0.5s' }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 1L14 10L23 12L14 14L12 23L10 14L1 12L10 10L12 1Z"/></svg>
                  <svg className="absolute right-0 top-1/2 h-3 w-3 animate-pulse text-blue-200 drop-shadow-md" style={{ animationDelay: '1s' }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 1L14 10L23 12L14 14L12 23L10 14L1 12L10 10L12 1Z"/></svg>
                </div>
              </div>

              {/* Bottom Row */}
              <div className="relative z-10 mt-5 flex items-center justify-between rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100/50">
                {/* Keep */}
                <div className="flex flex-1 flex-col items-center justify-center border-r border-slate-100">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-500 ring-1 ring-emerald-100/50">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
                    </div>
                    <div className="flex flex-col items-start leading-none">
                      <p className="mb-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-500 sm:text-[10px]">Keep</p>
                      <p className="text-[20px] font-black leading-none text-emerald-600 sm:text-[22px]">{keepCount}</p>
                    </div>
                  </div>
                </div>

                {/* Regen */}
                <div className="flex flex-1 flex-col items-center justify-center border-r border-slate-100">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-50 text-blue-500 ring-1 ring-blue-100/50">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 21v-5h5" /></svg>
                    </div>
                    <div className="flex flex-col items-start leading-none">
                      <p className="mb-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-500 sm:text-[10px]">Regen</p>
                      <p className="text-[20px] font-black leading-none text-blue-600 sm:text-[22px]">{regenerateCount}</p>
                    </div>
                  </div>
                </div>

                {/* Final Pack */}
                <div className="flex flex-1 flex-col items-center justify-center">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-50 text-indigo-500 ring-1 ring-indigo-100/50">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
                    </div>
                    <div className="flex flex-col items-start leading-none">
                      <p className="mb-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-500 sm:text-[10px]">Final Pack</p>
                      <p className="text-[20px] font-black leading-none text-slate-900 sm:text-[22px]">{currentStickerCount || DEFAULT_STICKER_COUNT}</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

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
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-black tracking-tight text-slate-800">Concept</h3>
                <button
                  type="button"
                  onClick={() => setIsPromptGuideOpen(true)}
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-bold text-slate-600 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 active:scale-95"
                >
                  <svg className="h-3.5 w-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  Prompt tips
                </button>
              </div>
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
                  || !canGenerate
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
                <div className="mt-4 rounded-[1.75rem] border border-slate-200 bg-slate-50/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">เลือกภาพที่ต้องการเก็บไว้ในรอบถัดไป</p>
                      <p className="mt-1 text-sm text-slate-600">
                        รูปที่มีเครื่องหมายถูกจะคงอยู่ที่ slot เดิม ส่วนที่ไม่ได้เลือกจะถูก generate ใหม่
                      </p>
                    </div>
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                      Keep {lockedCount}/{currentStickerCount}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setAllStickerLocks(true)}
                      disabled={loading || lockedCount === currentStickerCount}
                      className="focus-ring rounded-full border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Keep All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllStickerLocks(false)}
                      disabled={loading || lockedCount === 0}
                      className="focus-ring rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-sky-400 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Generate All Again
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-3">
                  {stickerSlots.map((slot, index) => (
                    <button
                      type="button"
                      key={slot.id}
                      onClick={() => toggleStickerLock(index)}
                      disabled={loading}
                      aria-pressed={slot.locked}
                      aria-label={`${slot.locked ? 'Keep' : 'Regenerate'} sticker ${index + 1}`}
                      className={`relative block overflow-hidden rounded-2xl border bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgHQAmUPwdICYAOIyDPr5CABdamAivXkrFgAAAABJRU5ErkJggg==')] bg-repeat p-[3px] transition ${slot.locked ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-slate-200 hover:border-sky-300'
                        }`}
                    >
                      <img
                        src={slot.url}
                        alt={`Sticker ${index + 1}`}
                        className="focus-ring aspect-square w-full rounded-xl bg-white object-contain"
                      />
                      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/72 px-2 py-1 text-[11px] font-semibold text-white shadow-sm">
                        Slot {index + 1}
                      </span>
                      {slot.locked && (
                        <>
                          <span className="pointer-events-none absolute inset-[3px] rounded-xl bg-emerald-400/20" aria-hidden="true" />
                          <span
                            className="pointer-events-none absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/90 text-xs font-bold text-white shadow"
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                          <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-emerald-500/90 px-2 py-1 text-[11px] font-semibold text-white shadow">
                            Keep
                          </span>
                        </>
                      )}
                      {!slot.locked && (
                        <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-sky-500/90 px-2 py-1 text-[11px] font-semibold text-white shadow">
                          Regenerate
                        </span>
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
            {extraPickSlots.length > 0 ? (
              <div className="mt-6 border-t border-slate-200 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">Extra Picks</h3>
                    <p className="text-sm text-slate-600">
                      ตัวเลือกเพิ่มเติมจากรอบล่าสุด {extraPickSlots.length} รูป
                    </p>
                  </div>
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                    {isExtraPicksUnlocked ? 'Unlocked' : 'Locked'}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {extraPickSlots.map((slot) => (
                    <button
                      type="button"
                      key={slot.id}
                      onClick={() => {
                        if (isExtraPicksUnlocked) {
                          handleUseExtraPick(slot.index);
                        }
                      }}
                      disabled={!isExtraPicksUnlocked || isApplyingExtraPicks}
                      className={`relative overflow-hidden rounded-2xl border p-[3px] ${
                        isExtraPicksUnlocked ? 'border-slate-200 hover:border-emerald-400' : 'border-slate-200'
                      } ${!isExtraPicksUnlocked ? 'cursor-default' : ''}`}
                    >
                      {slot.url ? (
                        <img
                          src={slot.url}
                          alt={`Extra pick for sticker ${slot.index + 1}`}
                          className="aspect-square w-full rounded-xl bg-white object-contain"
                        />
                      ) : slot.previewUrl ? (
                        <div className="relative">
                          <img
                            src={slot.previewUrl}
                            alt={`Locked preview for extra pick ${slot.index + 1}`}
                            className="aspect-square w-full rounded-xl bg-slate-100 object-contain"
                          />
                          <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-slate-950/12 via-transparent to-white/5" />
                          <div className="pointer-events-none absolute inset-x-4 bottom-3 flex justify-center">
                            <span className="rounded-full border border-white/35 bg-slate-950/38 px-3 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm">
                              Preview locked
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-slate-100 text-center text-sm font-medium text-slate-500">
                          Preview unavailable
                        </div>
                      )}
                      <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-white">
                        Slot {slot.index + 1}
                      </span>
                      {isExtraPicksUnlocked ? (
                        <span className="absolute bottom-2 right-2 rounded-full bg-emerald-500/90 px-2 py-1 text-[11px] font-semibold text-white shadow">
                          Use in Final
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>

                {!isExtraPicksUnlocked ? (
                  <div className="mt-4 space-y-2">
                    <button
                      type="button"
                      onClick={handleUnlockExtraPicks}
                      disabled={isUnlockingExtraPicks || (coinBalance ?? 0) < 1}
                      className="focus-ring min-h-11 w-full rounded-2xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      {isUnlockingExtraPicks ? 'Unlocking...' : 'Unlock Extra Picks (1 Coin)'}
                    </button>
                    {(coinBalance ?? 0) < 1 ? (
                      <p className="text-sm text-slate-600">Coins ไม่พอสำหรับปลดล็อก Extra Picks</p>
                    ) : (
                      <p className="text-sm text-slate-600">
                        ปลดล็อกทั้งหมดด้วย 1 coin เพื่อดูรูปจริง แล้วเลือกเฉพาะรูปที่ต้องการสลับเข้า final 16
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm text-slate-600">
                      แตะรูปที่ต้องการ แล้วระบบจะสลับรูปนั้นเข้า final pack ตาม slot เดิมทันที
                    </p>
                    <p className="text-sm text-slate-600">
                      เมื่อ final 16 เป็นชุดที่พอใจแล้ว กด Save to Photos ได้เลย
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        )}

      </main>

      {/* Prompt Guide Modal */}
      {isPromptGuideOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={() => setIsPromptGuideOpen(false)}></div>
          
          <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto overflow-x-hidden rounded-[2.5rem] bg-white shadow-2xl ring-1 ring-slate-200 overscroll-contain pb-6">
            <button
              onClick={() => setIsPromptGuideOpen(false)}
              className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 z-10"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>

            <div className="px-6 pt-8">
              <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-blue-500">Prompt Guide</p>
              <h2 className="mt-1.5 text-xl font-black tracking-tight text-slate-900">เขียน prompt ให้ได้ภาพที่ต้องการ</h2>
              <p className="mt-2 text-sm font-medium leading-relaxed text-slate-500">บอกสิ่งที่ต้องการให้ชัดเจน เพื่อให้ AI สร้างภาพออกมาตรงใจมากขึ้น</p>

              <div className="mt-6 space-y-3">
                {/* Green Section */}
                <div className="rounded-[1.5rem] bg-emerald-50/50 p-4 ring-1 ring-emerald-100">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400 text-white shadow-sm">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    </div>
                    <span className="font-bold text-emerald-700">ควรใส่</span>
                  </div>
                  
                  <ul className="space-y-3">
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">รายละเอียดหลัก</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">ธีม, อารมณ์, สไตล์ของภาพ</p>
                      </div>
                    </li>
                    <div className="ml-11 border-t border-emerald-100/50"></div>
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">องค์ประกอบสำคัญ</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">ตัวละคร, props, ฉาก, การกระทำ</p>
                      </div>
                    </li>
                    <div className="ml-11 border-t border-emerald-100/50"></div>
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">รายละเอียดเสริม</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">สี, แสง, มุมกล้อง, บรรยากาศ</p>
                      </div>
                    </li>
                    <div className="ml-11 border-t border-emerald-100/50"></div>
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-emerald-600 shadow-sm ring-1 ring-emerald-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="12" y1="7" x2="12" y2="13"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">ข้อความ (ถ้ามี)</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">caption หรือข้อความบนภาพ</p>
                      </div>
                    </li>
                  </ul>
                </div>

                {/* Red Section */}
                <div className="rounded-[1.5rem] bg-rose-50/50 p-4 ring-1 ring-rose-100">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-400 text-white shadow-sm">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </div>
                    <span className="font-bold text-rose-700">ควรหลีกเลี่ยง</span>
                  </div>
                  
                  <ul className="space-y-3">
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm ring-1 ring-rose-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">โครงสร้างที่รกเกินไป</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">กรอบ, ตาราง, comic panel, พื้นหลังขาว</p>
                      </div>
                    </li>
                    <div className="ml-11 border-t border-rose-100/50"></div>
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm ring-1 ring-rose-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/><path d="M3 11h18"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">ข้อความยาว</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">กล่องข้อความ, แถบสีหลังข้อความ</p>
                      </div>
                    </li>
                    <div className="ml-11 border-t border-rose-100/50"></div>
                    <li className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm ring-1 ring-rose-100">
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/><path d="m3 3 18 18"/></svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-800">คำสั่งที่ซ้ำซ้อน</p>
                        <p className="text-xs font-medium text-slate-500 mt-0.5">บอกรายละเอียดเดียวกันหลายครั้ง</p>
                      </div>
                    </li>
                  </ul>
                </div>

                {/* Example Section */}
                <div className="rounded-[1.5rem] bg-blue-50 p-4 ring-1 ring-blue-100/50">
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    <span className="font-bold text-slate-800 text-sm">ตัวอย่าง prompt</span>
                  </div>
                  <p className="text-[13px] font-medium leading-relaxed text-slate-600">
                    ทำสติ๊กเกอร์แมวออฟฟิศ อารมณ์เหนื่อย นั่งทำงานดึกๆ มี laptop เอกสาร กาแฟ แสงไฟสลัวๆ มุมกล้องใกล้ สไตล์น่ารัก สีอบอุ่น
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-3">
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#1e293b] p-4 text-sm font-bold text-white shadow-md hover:bg-slate-800 transition-colors"
                  onClick={() => {
                    setConfig(prev => ({ ...prev, extraPrompt: 'ทำสติ๊กเกอร์แมวออฟฟิศ อารมณ์เหนื่อย นั่งทำงานดึกๆ มี laptop เอกสาร กาแฟ แสงไฟสลัวๆ มุมกล้องใกล้ สไตล์น่ารัก สีอบอุ่น' }));
                    setIsPromptGuideOpen(false);
                  }}
                >
                  <svg className="h-4 w-4 text-amber-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                  ดูตัวอย่าง prompt
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-white p-4 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
                  onClick={() => setIsPromptGuideOpen(false)}
                >
                  เข้าใจแล้ว
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default GeneratePage;
