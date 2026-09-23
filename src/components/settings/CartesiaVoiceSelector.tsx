import { useEffect, useState } from 'react';
import { Check, Loader2, Play, Search } from 'lucide-react';

interface CartesiaVoice {
  id: string;
  name: string;
  description: string;
  gender?: string;
  language?: string;
  country?: string;
}

interface CartesiaVoiceSelectorProps {
  selectedVoiceId?: string;
  onSelect: (voiceId: string, language?: string) => void;
}

export function CartesiaVoiceSelector({ selectedVoiceId, onSelect }: CartesiaVoiceSelectorProps) {
  const [voices, setVoices] = useState<CartesiaVoice[]>([]);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState<'all' | 'pt' | 'en'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioRef, setAudioRef] = useState<HTMLAudioElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadVoices(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, language]);

  const loadVoices = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      let result = await window.lionclaw.voice.listCartesiaVoices({
        q: q.trim() || undefined,
        language: language === 'all' ? undefined : language,
        limit: 80,
      });

      if (result.length === 0 && language !== 'all' && !q.trim()) {
        result = await window.lionclaw.voice.listCartesiaVoices({ limit: 80 });
      }

      setVoices(result);
    } catch {
      setError('Nao foi possivel carregar vozes. Verifique a CARTESIA_API_KEY no Vault.');
    } finally {
      setLoading(false);
    }
  };

  const playPreview = (voice: CartesiaVoice) => {
    if (audioRef) {
      audioRef.pause();
      audioRef.currentTime = 0;
    }

    if (playingId === voice.id) {
      setPlayingId(null);
      return;
    }

    setPlayingId(voice.id);
    const previewText =
      voice.language === 'en'
        ? 'Hi! I am a Cartesia voice for real-time conversations.'
        : 'Ola! Eu sou uma voz da Cartesia para conversas em tempo real.';
    window.lionclaw.voice
      .speakCartesia(previewText, voice.id, voice.language)
      .then((result) => {
        const audio = new Audio(`data:audio/mpeg;base64,${result.base64}`);
        audio.onended = () => setPlayingId(null);
        audio.play().catch(() => setPlayingId(null));
        setAudioRef(audio);
      })
      .catch(() => setPlayingId(null));
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar voz Cartesia"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-3 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
          {(
            [
              ['all', 'Todas'],
              ['pt', 'PT'],
              ['en', 'EN'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setLanguage(value)}
              className={`px-2.5 rounded-md transition-colors ${
                language === value ? 'bg-amber-600 text-white' : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-2">
          <Loader2 size={14} className="animate-spin" />
          Carregando vozes Cartesia...
        </div>
      )}

      {error && <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      {!loading && !error && voices.length === 0 && (
        <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg border border-zinc-800 px-3 py-2">
          Nenhuma voz encontrada.
        </div>
      )}

      {!loading && !error && voices.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          <p className="text-xs text-zinc-500 mb-2">Voz do chat ao vivo</p>
          {voices.map((voice) => (
            <div
              key={voice.id}
              onClick={() => onSelect(voice.id, voice.language)}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                selectedVoiceId === voice.id
                  ? 'bg-amber-600/20 border border-amber-500/30'
                  : 'bg-zinc-900 border border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {selectedVoiceId === voice.id && <Check size={14} className="text-amber-500 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{voice.name}</p>
                  <p className="text-[10px] text-zinc-500 truncate">
                    {[voice.language, voice.country, voice.gender].filter(Boolean).join(' - ')}
                  </p>
                  {voice.description && (
                    <p className="text-[10px] text-zinc-600 truncate max-w-md">{voice.description}</p>
                  )}
                </div>
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  playPreview(voice);
                }}
                className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 transition-colors"
                title="Ouvir preview"
              >
                {playingId === voice.id ? (
                  <Loader2 size={14} className="animate-spin text-amber-500" />
                ) : (
                  <Play size={14} />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
