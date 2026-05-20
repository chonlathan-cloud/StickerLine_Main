import React from 'react';

interface ApiKeyScreenProps {
  onKeySelected: () => void;
}

export const ApiKeyScreen: React.FC<ApiKeyScreenProps> = ({ onKeySelected }) => {
  const handleSelectKey = async () => {
    try {
      await (window as any).aistudio.openSelectKey();
      onKeySelected();
    } catch (err) {
      console.error('Failed to open key selector', err);
    }
  };

  return (
    <main className="min-h-dvh bg-[#f8fafc] px-4 py-8">
      <section className="mx-auto w-full max-w-xl rounded-[2.5rem] border border-slate-200 bg-white p-7 shadow-sm">
        <header className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-2xl font-semibold text-white">
            S
          </div>
          <p className="mt-4 text-sm font-medium text-slate-700">Sticker Studio</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-900">Connect API key</h1>
          <p className="mt-3 text-sm text-slate-700">
            Authenticate once to use Gemini image generation and create LINE sticker sheets.
          </p>
        </header>

        <div className="mt-7 space-y-3">
          <button
            type="button"
            onClick={handleSelectKey}
            className="focus-ring min-h-11 w-full rounded-2xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-700"
          >
            Authenticate Studio Key
          </button>

          <a
            href="https://ai.google.dev/gemini-api/docs/billing"
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-800 hover:border-indigo-500 hover:text-indigo-700"
          >
            View billing documentation
          </a>
        </div>
      </section>
    </main>
  );
};
