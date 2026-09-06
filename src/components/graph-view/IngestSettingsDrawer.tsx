import { useState, useEffect } from 'react';
import { X, Settings } from 'lucide-react';
import type { IngestSettings } from '@/types';


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-zinc-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  'w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500/50';


interface IngestSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function IngestSettingsDrawer({ open, onClose }: IngestSettingsDrawerProps) {
  const [settings, setSettings] = useState<IngestSettings | null>(null);

  useEffect(() => {
    if (!open) return;
    window.lionclaw.mgraph.ingestSettings().then(setSettings).catch(() => {});
  }, [open]);

  const update = async (key: keyof IngestSettings, raw: string) => {
    if (!settings) return;

    let value: IngestSettings[keyof IngestSettings];
    if (key === 'maxFileSizeMb' || key === 'maxChunks') {
      value = Number(raw);
    } else if (key === 'urlLevel') {
      value = Number(raw) as 1 | 2 | 3;
    } else if (key === 'autoConfirm') {
      value = raw === 'true';
    } else {
      value = raw as IngestSettings[typeof key];
    }

    const updated = { ...settings, [key]: value } as IngestSettings;
    setSettings(updated);
    await window.lionclaw.mgraph.ingestSettingsUpdate({ [key]: raw }).catch(() => {});
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Drawer */}
      <div className="relative w-80 h-full bg-zinc-950 border-l border-zinc-800 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Settings size={14} className="text-amber-500" />
            <span className="text-sm font-semibold text-zinc-200">Configurações de Ingestão</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {!settings ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <Field label="Modelo Vision">
                <input
                  type="text"
                  value={settings.visionModel}
                  onChange={(e) => update('visionModel', e.target.value)}
                  className={INPUT_CLS}
                />
              </Field>

              <Field label="Modelo Extração">
                <input
                  type="text"
                  value={settings.extractionModel}
                  onChange={(e) => update('extractionModel', e.target.value)}
                  className={INPUT_CLS}
                />
              </Field>

              <Field label="Provedor STT">
                <select
                  value={settings.sttProvider}
                  onChange={(e) => update('sttProvider', e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="whisper">Whisper</option>
                </select>
              </Field>

              <Field label="Tamanho máximo de arquivo (MB)">
                <input
                  type="number"
                  value={settings.maxFileSizeMb}
                  min={1}
                  max={500}
                  onChange={(e) => update('maxFileSizeMb', e.target.value)}
                  className={INPUT_CLS}
                />
              </Field>

              <Field label="Max chunks por job">
                <input
                  type="number"
                  value={settings.maxChunks}
                  min={1}
                  onChange={(e) => update('maxChunks', e.target.value)}
                  className={INPUT_CLS}
                />
              </Field>

              <Field label="Extrator PDF">
                <select
                  value={settings.pdfExtractor}
                  onChange={(e) => update('pdfExtractor', e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value="auto">Auto</option>
                  <option value="pdfjs">PDF.js</option>
                  <option value="vision">Vision</option>
                </select>
              </Field>

              <Field label="Nível de extração URL">
                <select
                  value={settings.urlLevel}
                  onChange={(e) => update('urlLevel', e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value={1}>1 — Básico</option>
                  <option value={2}>2 — Médio</option>
                  <option value={3}>3 — Completo</option>
                </select>
              </Field>

              <Field label="Auto-confirmar">
                <button
                  type="button"
                  onClick={() => update('autoConfirm', String(!settings.autoConfirm))}
                  className="flex items-center gap-2.5"
                >
                  <div
                    className={`relative w-8 h-4 rounded-full transition-colors ${
                      settings.autoConfirm ? 'bg-amber-500' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${
                        settings.autoConfirm ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                  <span className="text-xs text-zinc-400">
                    {settings.autoConfirm ? 'Ativado' : 'Desativado'}
                  </span>
                </button>
              </Field>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
