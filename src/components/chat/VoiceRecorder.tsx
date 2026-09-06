import { forwardRef, useEffect, useImperativeHandle, useState, useRef, useCallback } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';

interface VoiceRecorderProps {
  onAudioReady: (audioBase64: string, transcription: string) => void;
  disabled?: boolean;
}

export interface VoiceRecorderHandle {
  cancel: () => void;
  isRecording: () => boolean;
}

export const VoiceRecorder = forwardRef<VoiceRecorderHandle, VoiceRecorderProps>(function VoiceRecorder(
  { onAudioReady, disabled },
  ref,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    cancelRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelRef.current || generationRef.current !== generation || disabled || !mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        if (generationRef.current === generation) {
          cancelRef.current = false;
        }
        return;
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      streamRef.current = stream;
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        cleanupStream();
        mediaRecorderRef.current = null;
        if (mountedRef.current) {
          setIsRecording(false);
        }

        if (cancelRef.current) {
          cancelRef.current = false;
          chunksRef.current = [];
          return;
        }

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        if (mountedRef.current) {
          setIsTranscribing(true);
        }
        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          if (cancelRef.current || generationRef.current !== generation || !mountedRef.current) return;
          const text = await window.lionclaw.voice.transcribe(base64);
          if (cancelRef.current || generationRef.current !== generation || !mountedRef.current) return;
          onAudioReady(base64, text || '');
        } catch (err) {
          if (!cancelRef.current && generationRef.current === generation && mountedRef.current) {
            console.error('Transcription failed:', err);
          }
        } finally {
          if (generationRef.current === generation && mountedRef.current) {
            setIsTranscribing(false);
          }
        }
      };

      mediaRecorder.start(250);
      if (mountedRef.current) {
        setIsRecording(true);
      }
    } catch (err) {
      cleanupStream();
      mediaRecorderRef.current = null;
      if (!cancelRef.current && generationRef.current === generation) {
        console.error('Mic access denied:', err);
      }
    }
  }, [cleanupStream, disabled, onAudioReady]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    cancelRef.current = true;
    generationRef.current += 1;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      cleanupStream();
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      if (mountedRef.current) {
        setIsRecording(false);
        setIsTranscribing(false);
      }
    }
  }, [cleanupStream]);

  useEffect(() => {
    if (disabled) {
      cancelRecording();
    }
  }, [cancelRecording, disabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecording();
    };
  }, [cancelRecording]);

  useImperativeHandle(ref, () => ({
    cancel: cancelRecording,
    isRecording: () => isRecording,
  }), [cancelRecording, isRecording]);

  if (isTranscribing) {
    return (
      <button disabled className="p-1.5 rounded-lg bg-zinc-800 text-amber-500">
        <Loader2 size={16} className="animate-spin" />
      </button>
    );
  }

  return (
    <button
      onClick={isRecording ? stopRecording : startRecording}
      disabled={disabled}
      className={`p-1.5 rounded-lg transition-colors ${
        isRecording
          ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400'
      } disabled:opacity-30`}
      title={isRecording ? 'Parar gravacao' : 'Gravar audio'}
    >
      {isRecording ? <Square size={16} /> : <Mic size={16} />}
    </button>
  );
});
