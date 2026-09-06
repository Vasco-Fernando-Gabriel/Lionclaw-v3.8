import { useState, useEffect } from 'react';
import { Play, Loader2, Check } from 'lucide-react';

interface Voice {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview_url: string;
}

interface VoiceSelectorProps {
  selectedVoiceId?: string;
  onSelect: (voiceId: string) => void;
}

export function VoiceSelector({ selectedVoiceId, onSelect }: VoiceSelectorProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioRef, setAudioRef] = useState<HTMLAudioElement | null>(null);

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.lionclaw.voice.listVoices();
      setVoices(result);
    } catch {
      setError('Nao foi possivel carregar vozes. Verifique a ELEVENLABS_API_KEY no Vault.');
    } finally {
      setLoading(false);
    }
  };

  const playPreview = (voice: Voice) => {
    if (audioRef) {
      audioRef.pause();
      audioRef.currentTime = 0;
    }

    if (playingId === voice.voice_id) {
      setPlayingId(null);
      return;
    }

    setPlayingId(voice.voice_id);
    window.lionclaw.voice.speak('Ola! Eu sou uma voz da ElevenLabs. Prazer em conhecer voce!', voice.voice_id)
      .then(result => {
        const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
        const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
        audio.onended = () => setPlayingId(null);
        audio.play().catch(() => setPlayingId(null));
        setAudioRef(audio);
      })
      .catch(() => setPlayingId(null));
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-500 text-sm py-2">
        <Loader2 size={14} className="animate-spin" />
        Carregando vozes...
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-64 overflow-y-auto">
      <p className="text-xs text-zinc-500 mb-2">Voz padrao</p>
      {voices.map(voice => (
        <div
          key={voice.voice_id}
          onClick={() => onSelect(voice.voice_id)}
          className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
            selectedVoiceId === voice.voice_id
              ? 'bg-amber-600/20 border border-amber-500/30'
              : 'bg-zinc-900 border border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2">
            {selectedVoiceId === voice.voice_id && (
              <Check size={14} className="text-amber-500" />
            )}
            <div>
              <p className="text-sm text-zinc-200">{voice.name}</p>
              <p className="text-[10px] text-zinc-500">
                {voice.category} {voice.labels?.accent ? `- ${voice.labels.accent}` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); playPreview(voice); }}
            className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 transition-colors"
            title="Ouvir preview"
          >
            {playingId === voice.voice_id ? (
              <Loader2 size={14} className="animate-spin text-amber-500" />
            ) : (
              <Play size={14} />
            )}
          </button>
        </div>
      ))}
    </div>
  );
}
