import { useState, useRef } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';

interface AudioPlayerProps {
  audioBase64: string;
  mimeType?: string;
  label?: string;
}

export function AudioPlayer({ audioBase64, mimeType = 'audio/mpeg', label }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = () => {
    if (!audioRef.current) {
      const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
      audioRef.current = audio;
      audio.ontimeupdate = () => setProgress(audio.currentTime / audio.duration * 100);
      audio.onended = () => { setIsPlaying(false); setProgress(0); };
    }
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-zinc-800/50 rounded-lg border border-zinc-700/50 my-2">
      <button
        onClick={togglePlay}
        className="w-8 h-8 rounded-full bg-amber-600 hover:bg-amber-500 flex items-center justify-center text-white transition-colors"
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>
      <div className="flex-1">
        {label && <span className="text-xs text-zinc-400 block mb-1">{label}</span>}
        <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500 rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <Volume2 size={14} className="text-zinc-500" />
    </div>
  );
}

export default AudioPlayer;
