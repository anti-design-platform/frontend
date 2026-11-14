/**
 * UpdateBanner — Auto-Update notification bar
 *
 * Listens to Electron IPC events forwarded via preload.cjs:
 *   update:available  → shows "Update v1.x available" banner
 *   update:progress   → shows download progress bar
 *   update:downloaded → shows "Restart to apply" button
 *   update:error      → shows error (dismissible)
 *
 * Only renders inside packaged Electron (window.electronAPI?.onUpdateAvailable present).
 */
import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, X, AlertTriangle, CheckCircle2 } from 'lucide-react';

type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string; releaseDate?: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

export const UpdateBanner: React.FC = () => {
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  const api = (window as any).electronAPI;

  useEffect(() => {
    if (!api?.onUpdateAvailable) return; // not in Electron

    api.onUpdateAvailable((info: { version: string; releaseDate?: string }) => {
      setDismissed(false);
      setUpdate({ phase: 'available', version: info.version, releaseDate: info.releaseDate });
    });

    api.onUpdateProgress((info: { percent: number }) => {
      setUpdate({ phase: 'downloading', percent: info.percent });
    });

    api.onUpdateDownloaded((info: { version: string }) => {
      setUpdate({ phase: 'downloaded', version: info.version });
    });

    api.onUpdateError((info: { message: string }) => {
      setUpdate({ phase: 'error', message: info.message });
    });
  }, []);

  if (dismissed || update.phase === 'idle') return null;

  const handleDownload = async () => {
    setUpdate({ phase: 'downloading', percent: 0 });
    await api?.downloadUpdate?.();
  };

  const handleInstall = () => {
    api?.installUpdate?.();
  };

  const handleDismiss = () => setDismissed(true);

  // ── Styles ────────────────────────────────────────────────────────────────
  const base =
    'fixed top-0 left-0 right-0 z-[9999] flex items-center justify-between gap-3 px-4 py-2.5 text-xs font-mono shadow-lg select-none';

  if (update.phase === 'available') {
    return (
      <div className={`${base} bg-indigo-600 text-white`}>
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 shrink-0" />
          <span>
            🚀 تحديث جديد متاح — <strong>v{update.version}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            className="px-3 py-1 bg-white text-indigo-700 font-bold rounded-lg hover:bg-indigo-50 transition-colors"
          >
            تحديث الآن
          </button>
          <button onClick={handleDismiss} className="p-1 hover:bg-indigo-500 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (update.phase === 'downloading') {
    return (
      <div className={`${base} bg-indigo-700 text-white flex-col items-stretch gap-1 py-3`}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Download className="w-4 h-4 animate-bounce shrink-0" />
            جارٍ تنزيل التحديث… {update.percent}%
          </span>
        </div>
        <div className="w-full bg-indigo-500 rounded-full h-1.5 mt-1">
          <div
            className="bg-white rounded-full h-1.5 transition-all duration-300"
            style={{ width: `${update.percent}%` }}
          />
        </div>
      </div>
    );
  }

  if (update.phase === 'downloaded') {
    return (
      <div className={`${base} bg-emerald-600 text-white`}>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>
            ✅ التحديث <strong>v{update.version}</strong> جاهز — أعد التشغيل لتطبيقه
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstall}
            className="px-3 py-1 bg-white text-emerald-700 font-bold rounded-lg hover:bg-emerald-50 transition-colors flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            إعادة التشغيل
          </button>
          <button onClick={handleDismiss} className="p-1 hover:bg-emerald-500 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (update.phase === 'error') {
    return (
      <div className={`${base} bg-red-600 text-white`}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>خطأ في التحديث: {update.message}</span>
        </div>
        <button onClick={handleDismiss} className="p-1 hover:bg-red-500 rounded">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return null;
};
