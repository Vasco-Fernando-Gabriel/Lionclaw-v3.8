import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chat-store';

export type VoiceConversationState =
  | 'closed'
  | 'idle'
  | 'permission-pending'
  | 'permission-denied'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'error';

interface UseVoiceConversationOptions {
  disabled?: boolean;
  autoStart?: boolean;
  onSendMessage: (message: string) => Promise<void> | void;
}

interface VoiceTurnTimings {
  id: number;
  recordingStartedAt?: number;
  recordingEndedAt?: number;
  transcriptionStartedAt?: number;
  transcriptionEndedAt?: number;
  agentFirstDeltaAt?: number;
  agentDoneAt?: number;
  ttsStartedAt?: number;
  ttsEndedAt?: number;
  playbackStartedAt?: number;
  playbackEndedAt?: number;
}

class VoicePlaybackError extends Error {
  constructor(cause?: unknown) {
    super('Falha ao tocar audio');
    this.name = 'VoicePlaybackError';
    this.cause = cause;
  }
}

const VOICE_SILENCE_THRESHOLD_DB = -42;
const VOICE_START_THRESHOLD_DB = -38;
const VOICE_END_OF_SPEECH_MS = 1_250;
const VOICE_PRE_ROLL_MS = 750;
const VOICE_MIN_SPEECH_MS = 700;
const VOICE_MIN_BLOB_BYTES = 2_048;
const MAX_TURN_AUDIO_MS = 60_000;
const TURN_WARNING_MS = 50_000;
const RECORDER_CHUNK_MS = 100;
const BARGE_IN_START_THRESHOLD_DB = -32;
const BARGE_IN_MIN_SPEECH_MS = 360;
const BARGE_IN_GRACE_MS = 900;
const STREAM_FIRST_CHUNK_MIN_WORDS = 30;
const STREAM_FIRST_CHUNK_TARGET_WORDS = 45;
const STREAM_FIRST_CHUNK_MAX_WORDS = 70;
const STREAM_FOLLOWUP_MAX_WORDS = 60;

type LiveSpeechResult = { base64: string; format: 'mp3' | 'opus' };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function cleanAssistantText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~>]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectWordEnds(text: string, limit: number): number[] {
  const ends: number[] = [];
  const matcher = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) && ends.length < limit) {
    ends.push(match.index + match[0].length);
  }
  return ends;
}

function findStreamingSpeechCut(text: string, final: boolean): number {
  if (final) return text.length;

  const wordEnds = collectWordEnds(text, STREAM_FIRST_CHUNK_MAX_WORDS + 1);
  if (wordEnds.length < STREAM_FIRST_CHUNK_MIN_WORDS) return -1;

  const minIndex = wordEnds[STREAM_FIRST_CHUNK_MIN_WORDS - 1] ?? 0;
  const targetIndex = wordEnds[STREAM_FIRST_CHUNK_TARGET_WORDS - 1] ?? wordEnds[wordEnds.length - 1];
  const maxIndex = wordEnds[STREAM_FIRST_CHUNK_MAX_WORDS - 1] ?? wordEnds[wordEnds.length - 1];

  const naturalLimit = Math.min(text.length, maxIndex + 1);
  for (let index = minIndex; index < naturalLimit; index += 1) {
    if (/[.!?]/.test(text[index]) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return index + 1;
    }
  }

  for (let index = Math.min(text.length - 1, maxIndex); index >= targetIndex; index -= 1) {
    if (/[,;:]/.test(text[index]) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return index + 1;
    }
  }

  for (let index = Math.min(text.length - 1, maxIndex); index >= targetIndex; index -= 1) {
    if (/\s/.test(text[index])) return index;
  }

  return targetIndex;
}

function findFollowUpSpeechCut(text: string): number {
  let sentenceCut = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (/[.!?]/.test(text[index]) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      sentenceCut = index + 1;
    }
  }
  if (sentenceCut >= 0) return sentenceCut;

  const wordEnds = collectWordEnds(text, STREAM_FOLLOWUP_MAX_WORDS + 1);
  if (wordEnds.length <= STREAM_FOLLOWUP_MAX_WORDS) return -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/[,;:]/.test(text[index]) && (index === text.length - 1 || /\s/.test(text[index + 1]))) {
      return index + 1;
    }
  }
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(text[index])) return index;
  }
  return -1;
}

function getRecorderMimeType(): string {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return '';
}

function withRecorderHeader(chunks: Blob[], header: Blob | null): Blob[] {
  if (!header || chunks.includes(header)) return chunks;
  return [header, ...chunks];
}

function appendPreRollChunk(chunks: Blob[], chunk: Blob, header: Blob | null, maxChunks: number): Blob[] {
  const next = chunks.includes(chunk) ? chunks : [...chunks, chunk];
  if (!header) return next.slice(-maxChunks);

  const withoutHeader = next.filter((item) => item !== header);
  return [header, ...withoutHeader.slice(-Math.max(0, maxChunks - 1))];
}

function buildTimingDurations(timings: VoiceTurnTimings): Record<string, number | null> {
  const duration = (start?: number, end?: number) => (
    start != null && end != null ? Math.round(end - start) : null
  );

  return {
    recordingMs: duration(timings.recordingStartedAt, timings.recordingEndedAt),
    transcriptionMs: duration(timings.transcriptionStartedAt, timings.transcriptionEndedAt),
    agentToFirstDeltaMs: duration(timings.transcriptionEndedAt, timings.agentFirstDeltaAt),
    agentTotalMs: duration(timings.transcriptionEndedAt, timings.agentDoneAt),
    ttsMs: duration(timings.ttsStartedAt, timings.ttsEndedAt),
    playbackMs: duration(timings.playbackStartedAt, timings.playbackEndedAt),
    totalMs: duration(timings.recordingStartedAt, timings.playbackEndedAt ?? timings.agentDoneAt ?? timings.transcriptionEndedAt),
  };
}

export function useVoiceConversation({ disabled, autoStart, onSendMessage }: UseVoiceConversationOptions) {
  const [state, setState] = useState<VoiceConversationState>('closed');
  const [amplitude, setAmplitude] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);
  const [turnElapsedMs, setTurnElapsedMs] = useState(0);

  const assistantTurnEvents = useChatStore((chatState) => chatState.assistantTurnEvents);
  const assistantTurnCount = useChatStore((chatState) => chatState.assistantTurnCount);
  const streamingContent = useChatStore((chatState) => chatState.streamingContent);
  const setVoiceModeActive = useChatStore((chatState) => chatState.setVoiceModeActive);

  const stateRef = useRef<VoiceConversationState>('closed');
  const activeRef = useRef(false);
  const lifecycleTokenRef = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const preRollChunksRef = useRef<Blob[]>([]);
  const recorderHeaderChunkRef = useRef<Blob | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const runVadLoopRef = useRef<(() => void) | null>(null);
  const finishTurnRef = useRef<(() => Promise<void>) | null>(null);
  const silenceStartedAtRef = useRef<number | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const voiceCandidateStartedAtRef = useRef<number | null>(null);
  const recordingSpeechRef = useRef(false);
  const finishingTurnRef = useRef(false);
  const startingCaptureRef = useRef(false);
  const startCaptureRef = useRef<(() => Promise<void>) | null>(null);
  const awaitingResponseRef = useRef(false);
  const voiceExpectedTurnSequenceRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptedPlaybackRef = useRef(false);
  const speechTokenRef = useRef(0);
  const playbackCancelRef = useRef<(() => void) | null>(null);
  const bargeInStreamRef = useRef<MediaStream | null>(null);
  const bargeInAudioContextRef = useRef<AudioContext | null>(null);
  const bargeInSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const bargeInAnalyserRef = useRef<AnalyserNode | null>(null);
  const bargeInRecorderRef = useRef<MediaRecorder | null>(null);
  const bargeInRecorderHeaderChunkRef = useRef<Blob | null>(null);
  const bargeInPreRollChunksRef = useRef<Blob[]>([]);
  const bargeInFrameRef = useRef<number | null>(null);
  const bargeInCandidateStartedAtRef = useRef<number | null>(null);
  const bargeInMonitorStartedAtRef = useRef<number>(0);
  const bargeInMonitorTokenRef = useRef(0);
  const timingsRef = useRef<VoiceTurnTimings>({ id: 0 });
  const timingIdRef = useRef(0);
  const timingsLoggedRef = useRef(false);
  const streamingSpeechRawOffsetRef = useRef(0);
  const streamingSpeechBufferRef = useRef('');
  const streamingSpeechQueueRef = useRef<string[]>([]);
  const streamingSpeechProcessingRef = useRef(false);
  const streamingSpeechStartedRef = useRef(false);
  const streamingSpeechFinalRef = useRef(false);
  const streamingSpeechTokenRef = useRef<number | null>(null);
  const streamingSpeechFirstChunkQueuedRef = useRef(false);
  const streamingSpeechPrefetchRef = useRef<Promise<LiveSpeechResult> | null>(null);

  const isCurrentTimings = useCallback((timings: VoiceTurnTimings) => (
    timingsRef.current === timings && timingsRef.current.id === timings.id
  ), []);

  const logTimings = useCallback((status: string, extra?: Record<string, unknown>) => {
    if (timingsLoggedRef.current) return;
    timingsLoggedRef.current = true;
    console.debug('[voice-conversation:timings]', JSON.stringify({
      status,
      ...buildTimingDurations(timingsRef.current),
      ...extra,
    }));
  }, []);

  const startTimingTurn = useCallback((recordingStartedAt: number): VoiceTurnTimings => {
    const timings = {
      id: timingIdRef.current + 1,
      recordingStartedAt,
    };
    timingIdRef.current = timings.id;
    timingsRef.current = timings;
    timingsLoggedRef.current = false;
    return timings;
  }, []);

  const updateState = useCallback((nextState: VoiceConversationState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    playbackCancelRef.current?.();
    playbackCancelRef.current = null;

    const audio = audioRef.current;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audioRef.current = null;
  }, []);

  const resetStreamingSpeech = useCallback(() => {
    streamingSpeechRawOffsetRef.current = 0;
    streamingSpeechBufferRef.current = '';
    streamingSpeechQueueRef.current = [];
    streamingSpeechStartedRef.current = false;
    streamingSpeechFinalRef.current = false;
    streamingSpeechTokenRef.current = null;
    streamingSpeechFirstChunkQueuedRef.current = false;
    streamingSpeechPrefetchRef.current = null;
  }, []);

  const stopBargeInMonitor = useCallback(() => {
    bargeInMonitorTokenRef.current += 1;

    if (bargeInFrameRef.current != null) {
      cancelAnimationFrame(bargeInFrameRef.current);
      bargeInFrameRef.current = null;
    }

    bargeInSourceRef.current?.disconnect();
    bargeInSourceRef.current = null;
    bargeInAnalyserRef.current = null;
    const bargeRecorder = bargeInRecorderRef.current;
    if (bargeRecorder && bargeRecorder.state !== 'inactive') {
      bargeRecorder.ondataavailable = null;
      bargeRecorder.onstop = null;
      bargeRecorder.stop();
    }
    bargeInRecorderRef.current = null;
    bargeInRecorderHeaderChunkRef.current = null;
    bargeInPreRollChunksRef.current = [];
    bargeInStreamRef.current?.getTracks().forEach((track) => track.stop());
    bargeInStreamRef.current = null;
    void bargeInAudioContextRef.current?.close().catch(() => undefined);
    bargeInAudioContextRef.current = null;
    bargeInCandidateStartedAtRef.current = null;
    bargeInMonitorStartedAtRef.current = 0;
  }, []);

  const releaseCapture = useCallback((clearAudioChunks = true) => {
    if (maxTurnTimerRef.current) {
      clearTimeout(maxTurnTimerRef.current);
      maxTurnTimerRef.current = null;
    }

    if (vadFrameRef.current != null) {
      cancelAnimationFrame(vadFrameRef.current);
      vadFrameRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    mediaRecorderRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;

    recordingSpeechRef.current = false;
    silenceStartedAtRef.current = null;
    speechStartedAtRef.current = null;
    voiceCandidateStartedAtRef.current = null;
    setTurnElapsedMs(0);
    setAmplitude(0);

    if (clearAudioChunks) {
      chunksRef.current = [];
      preRollChunksRef.current = [];
      recorderHeaderChunkRef.current = null;
    }
  }, []);

  const restartListeningSoon = useCallback((delayMs = 0) => {
    clearRecoveryTimer();
    if (!activeRef.current || disabled) return;

    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      if (activeRef.current && !disabled) {
        void startCaptureRef.current?.();
      }
    }, delayMs);
  }, [clearRecoveryTimer, disabled]);

  const promoteBargeInToRecording = useCallback(() => {
    const stream = bargeInStreamRef.current;
    const audioContext = bargeInAudioContextRef.current;
    const source = bargeInSourceRef.current;
    const analyser = bargeInAnalyserRef.current;
    const recorder = bargeInRecorderRef.current;

    if (!stream || !audioContext || !source || !analyser || !recorder || recorder.state === 'inactive') {
      return false;
    }

    bargeInMonitorTokenRef.current += 1;
    if (bargeInFrameRef.current != null) {
      cancelAnimationFrame(bargeInFrameRef.current);
      bargeInFrameRef.current = null;
    }

    mediaStreamRef.current = stream;
    audioContextRef.current = audioContext;
    sourceRef.current = source;
    analyserRef.current = analyser;
    mediaRecorderRef.current = recorder;

    bargeInStreamRef.current = null;
    bargeInAudioContextRef.current = null;
    bargeInSourceRef.current = null;
    bargeInAnalyserRef.current = null;
    bargeInRecorderRef.current = null;

    const recordingStartedAt = bargeInCandidateStartedAtRef.current || performance.now();
    recorderHeaderChunkRef.current = bargeInRecorderHeaderChunkRef.current;
    chunksRef.current = withRecorderHeader([...bargeInPreRollChunksRef.current], recorderHeaderChunkRef.current);
    preRollChunksRef.current = [];
    bargeInPreRollChunksRef.current = [];
    bargeInRecorderHeaderChunkRef.current = null;
    recordingSpeechRef.current = true;
    speechStartedAtRef.current = recordingStartedAt;
    silenceStartedAtRef.current = null;
    voiceCandidateStartedAtRef.current = null;
    bargeInCandidateStartedAtRef.current = null;
    bargeInMonitorStartedAtRef.current = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recorderHeaderChunkRef.current ??= event.data;
        chunksRef.current.push(event.data);
      }
    };

    startTimingTurn(recordingStartedAt);
    setTurnElapsedMs(0);
    setLastError(null);
    maxTurnTimerRef.current = setTimeout(() => {
      if (stateRef.current !== 'recording') return;
      setLastError('Limite de 60 segundos atingido. Transcrevendo agora.');
      void finishTurnRef.current?.();
    }, MAX_TURN_AUDIO_MS + 250);
    updateState('recording');
    runVadLoopRef.current?.();

    return true;
  }, [startTimingTurn, updateState]);

  const triggerBargeIn = useCallback(() => {
    if (stateRef.current !== 'speaking') return;

    interruptedPlaybackRef.current = true;
    speechTokenRef.current += 1;
    const timings = timingsRef.current;
    if (isCurrentTimings(timings)) {
      timings.playbackEndedAt ??= timings.playbackStartedAt ? performance.now() : undefined;
    }
    logTimings('barge_in');
    stopPlayback();

    if (!promoteBargeInToRecording()) {
      stopBargeInMonitor();
      updateState('interrupted');
      restartListeningSoon();
    }
  }, [isCurrentTimings, logTimings, promoteBargeInToRecording, restartListeningSoon, stopBargeInMonitor, stopPlayback, updateState]);

  const startBargeInMonitor = useCallback(async (speechToken: number) => {
    if (!activeRef.current || disabled || stateRef.current !== 'speaking') return;

    stopBargeInMonitor();
    const monitorToken = bargeInMonitorTokenRef.current + 1;
    bargeInMonitorTokenRef.current = monitorToken;

    let setupStream: MediaStream | null = null;
    let setupAudioContext: AudioContext | null = null;
    let setupSource: MediaStreamAudioSourceNode | null = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setupStream = stream;
      bargeInStreamRef.current = stream;

      if (
        !activeRef.current
        || disabled
        || stateRef.current !== 'speaking'
        || speechTokenRef.current !== speechToken
        || bargeInMonitorTokenRef.current !== monitorToken
      ) {
        stopBargeInMonitor();
        return;
      }

      const audioContext = new window.AudioContext();
      setupAudioContext = audioContext;
      bargeInAudioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      if (
        !activeRef.current
        || disabled
        || stateRef.current !== 'speaking'
        || speechTokenRef.current !== speechToken
        || bargeInMonitorTokenRef.current !== monitorToken
      ) {
        stopBargeInMonitor();
        return;
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.74;
      const source = audioContext.createMediaStreamSource(stream);
      setupSource = source;
      source.connect(analyser);
      bargeInAnalyserRef.current = analyser;
      bargeInSourceRef.current = source;
      bargeInMonitorStartedAtRef.current = performance.now();
      bargeInCandidateStartedAtRef.current = null;
      bargeInPreRollChunksRef.current = [];

      const mimeType = getRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const maxPreRollChunks = Math.max(1, Math.ceil(VOICE_PRE_ROLL_MS / RECORDER_CHUNK_MS) + 1);
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        bargeInRecorderHeaderChunkRef.current ??= event.data;
        const graceElapsed = performance.now() - bargeInMonitorStartedAtRef.current >= BARGE_IN_GRACE_MS;
        if (!graceElapsed) return;

        bargeInPreRollChunksRef.current = appendPreRollChunk(
          bargeInPreRollChunksRef.current,
          event.data,
          bargeInRecorderHeaderChunkRef.current,
          maxPreRollChunks,
        );
      };
      recorder.start(RECORDER_CHUNK_MS);
      bargeInRecorderRef.current = recorder;

      setupStream = null;
      setupAudioContext = null;
      setupSource = null;

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (
          !activeRef.current
          || disabled
          || stateRef.current !== 'speaking'
          || speechTokenRef.current !== speechToken
          || bargeInMonitorTokenRef.current !== monitorToken
        ) {
          stopBargeInMonitor();
          return;
        }

        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const value = (data[i] - 128) / 128;
          sum += value * value;
        }

        const rms = Math.sqrt(sum / data.length);
        const db = 20 * Math.log10(Math.max(rms, 0.00001));
        const now = performance.now();
        const graceElapsed = now - bargeInMonitorStartedAtRef.current >= BARGE_IN_GRACE_MS;
        const hasVoice = graceElapsed && db > BARGE_IN_START_THRESHOLD_DB;

        if (hasVoice) {
          bargeInCandidateStartedAtRef.current ??= now;
        } else {
          bargeInCandidateStartedAtRef.current = null;
        }

        const candidateMs = bargeInCandidateStartedAtRef.current == null
          ? 0
          : now - bargeInCandidateStartedAtRef.current;

        if (candidateMs >= BARGE_IN_MIN_SPEECH_MS) {
          triggerBargeIn();
          return;
        }

        bargeInFrameRef.current = requestAnimationFrame(tick);
      };

      bargeInFrameRef.current = requestAnimationFrame(tick);
    } catch (error) {
      setupSource?.disconnect();
      setupStream?.getTracks().forEach((track) => track.stop());
      void setupAudioContext?.close().catch(() => undefined);
      stopBargeInMonitor();
      console.debug('[voice-conversation:barge-in]', {
        status: 'monitor_indisponivel',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }, [disabled, stopBargeInMonitor, triggerBargeIn]);

  const stopRecorderToBlob = useCallback((): Promise<Blob> => {
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder?.mimeType || 'audio/webm';

    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') {
        resolve(new Blob(withRecorderHeader(chunksRef.current, recorderHeaderChunkRef.current), { type: mimeType }));
        return;
      }

      recorder.onstop = () => {
        resolve(new Blob(withRecorderHeader(chunksRef.current, recorderHeaderChunkRef.current), { type: mimeType }));
      };
      recorder.requestData();
      recorder.stop();
    });
  }, []);

  const speakResponse = useCallback(async (rawText: string) => {
    const cleanText = cleanAssistantText(rawText);
    if (!activeRef.current || disabled) return;

    if (cleanText.length < 2) {
      updateState('idle');
      restartListeningSoon();
      logTimings('sem_tts');
      return;
    }

    updateState('speaking');
    interruptedPlaybackRef.current = false;
    const speechToken = speechTokenRef.current + 1;
    speechTokenRef.current = speechToken;
    const timings = timingsRef.current;
    if (isCurrentTimings(timings)) {
      timings.ttsStartedAt = performance.now();
    }
    let ttsCompleted = false;

    const canContinueSpeaking = () => (
      activeRef.current
      && !disabled
      && !interruptedPlaybackRef.current
      && speechTokenRef.current === speechToken
    );

    try {
      if (!canContinueSpeaking()) return;

      const result = await window.lionclaw.voice.speakLive(cleanText.slice(0, 5000));
      if (isCurrentTimings(timings)) {
        timings.ttsEndedAt = performance.now();
      }
      ttsCompleted = true;
      if (!canContinueSpeaking()) return;

      const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
      const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
      if (!canContinueSpeaking()) return;

      audioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          audio.onended = null;
          audio.onerror = null;
          if (playbackCancelRef.current === cancelPlayback) {
            playbackCancelRef.current = null;
          }
        };
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const cancelPlayback = () => {
          settle(resolve);
        };

        playbackCancelRef.current = cancelPlayback;
        audio.onended = () => settle(resolve);
        audio.onerror = () => settle(() => reject(new VoicePlaybackError()));
        if (isCurrentTimings(timings)) {
          timings.playbackStartedAt = performance.now();
        }
        const playPromise = audio.play();
        playPromise
          .then(() => {
            if (canContinueSpeaking()) {
              void startBargeInMonitor(speechToken);
            }
          })
          .catch((error: unknown) => settle(() => reject(new VoicePlaybackError(error))));
      });
      stopBargeInMonitor();
      if (isCurrentTimings(timings)) {
        timings.playbackEndedAt = performance.now();
      }

      if (audioRef.current === audio) {
        audioRef.current = null;
      }
      if (canContinueSpeaking()) {
        logTimings('completo');
        updateState('idle');
        restartListeningSoon();
      }
    } catch (error) {
      if (!canContinueSpeaking()) return;
      stopBargeInMonitor();
      if (isCurrentTimings(timings)) {
        if (ttsCompleted) {
          timings.playbackEndedAt ??= timings.playbackStartedAt ? performance.now() : undefined;
        } else {
          timings.ttsEndedAt ??= performance.now();
        }
      }
      logTimings(ttsCompleted ? 'erro_playback' : 'erro_tts', { errorType: error instanceof Error ? error.name : typeof error });
      console.error('Voice conversation TTS failed:', error);
      setLastError('Nao consegui reproduzir a resposta em voz.');
      updateState('error');
      restartListeningSoon(1200);
    }
  }, [disabled, isCurrentTimings, logTimings, restartListeningSoon, startBargeInMonitor, stopBargeInMonitor, updateState]);

  const generateLiveAudio = useCallback((text: string): Promise<LiveSpeechResult> => {
    return window.lionclaw.voice.speakLive(text.slice(0, 5000));
  }, []);

  const playLiveSpeechChunk = useCallback(async (
    result: LiveSpeechResult,
    speechToken: number,
    timings: VoiceTurnTimings,
  ) => {
    const canContinueSpeaking = () => (
      activeRef.current
      && !disabled
      && !interruptedPlaybackRef.current
      && speechTokenRef.current === speechToken
    );

    if (!canContinueSpeaking()) return false;

    const mimeType = result.format === 'opus' ? 'audio/ogg' : 'audio/mpeg';
    const audio = new Audio(`data:${mimeType};base64,${result.base64}`);
    if (!canContinueSpeaking()) return false;

    audioRef.current = audio;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        if (playbackCancelRef.current === cancelPlayback) {
          playbackCancelRef.current = null;
        }
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const cancelPlayback = () => {
        settle(resolve);
      };

      playbackCancelRef.current = cancelPlayback;
      audio.onended = () => settle(resolve);
      audio.onerror = () => settle(() => reject(new VoicePlaybackError()));
      if (isCurrentTimings(timings)) {
        timings.playbackStartedAt ??= performance.now();
      }
      const playPromise = audio.play();
      playPromise
        .then(() => {
          if (canContinueSpeaking()) {
            void startBargeInMonitor(speechToken);
          }
        })
        .catch((error: unknown) => settle(() => reject(new VoicePlaybackError(error))));
    });

    stopBargeInMonitor();
    if (isCurrentTimings(timings)) {
      timings.playbackEndedAt = performance.now();
    }
    if (audioRef.current === audio) {
      audioRef.current = null;
    }

    return canContinueSpeaking();
  }, [disabled, isCurrentTimings, startBargeInMonitor, stopBargeInMonitor]);

  const processStreamingSpeechQueue = useCallback(async () => {
    if (streamingSpeechProcessingRef.current) return;
    streamingSpeechProcessingRef.current = true;

    try {
      if (!streamingSpeechStartedRef.current) {
        streamingSpeechStartedRef.current = true;
        interruptedPlaybackRef.current = false;
        const speechToken = speechTokenRef.current + 1;
        speechTokenRef.current = speechToken;
        streamingSpeechTokenRef.current = speechToken;
        updateState('speaking');
      }

      const speechToken = streamingSpeechTokenRef.current;
      if (speechToken == null) return;
      const timings = timingsRef.current;

      const guardsOk = () => (
        activeRef.current
        && !disabled
        && !interruptedPlaybackRef.current
        && speechTokenRef.current === speechToken
      );

      if (isCurrentTimings(timings)) {
        timings.ttsStartedAt ??= performance.now();
      }

      while (guardsOk()) {
        let audioPromise = streamingSpeechPrefetchRef.current;
        streamingSpeechPrefetchRef.current = null;
        if (!audioPromise) {
          const text = streamingSpeechQueueRef.current.shift();
          if (!text) break;
          audioPromise = generateLiveAudio(text);
        }
        const following = streamingSpeechQueueRef.current.shift();
        if (following) {
          const prefetch = generateLiveAudio(following);
          prefetch.catch(() => {}); // descartado em cancel/barge-in: evita unhandled rejection
          streamingSpeechPrefetchRef.current = prefetch;
        }

        const result = await audioPromise;
        if (isCurrentTimings(timings)) {
          timings.ttsEndedAt = performance.now();
        }
        if (!guardsOk()) return;
        const continued = await playLiveSpeechChunk(result, speechToken, timings);
        if (!continued) return;
      }

      const drained = streamingSpeechQueueRef.current.length === 0
        && streamingSpeechBufferRef.current.trim().length === 0;
      if (
        streamingSpeechFinalRef.current
        && drained
        && activeRef.current
        && !disabled
        && !interruptedPlaybackRef.current
        && speechTokenRef.current === speechToken
      ) {
        logTimings('completo_streaming');
        resetStreamingSpeech();
        updateState('idle');
        restartListeningSoon();
      }
    } catch (error) {
      const speechToken = streamingSpeechTokenRef.current;
      if (speechToken != null && speechTokenRef.current !== speechToken) return;
      stopBargeInMonitor();
      const timings = timingsRef.current;
      if (isCurrentTimings(timings)) {
        timings.ttsEndedAt ??= performance.now();
      }
      logTimings('erro_streaming_tts', { errorType: error instanceof Error ? error.name : typeof error });
      console.error('Voice conversation streaming TTS failed:', error);
      resetStreamingSpeech();
      setLastError('Nao consegui reproduzir a resposta em voz.');
      updateState('error');
      restartListeningSoon(1200);
    } finally {
      streamingSpeechProcessingRef.current = false;
      const speechToken = streamingSpeechTokenRef.current;
      const canContinue = speechToken != null
        && activeRef.current
        && !disabled
        && !interruptedPlaybackRef.current
        && speechTokenRef.current === speechToken;
      if (canContinue && streamingSpeechQueueRef.current.length > 0) {
        void processStreamingSpeechQueue();
      }
    }
  }, [
    disabled,
    generateLiveAudio,
    isCurrentTimings,
    logTimings,
    playLiveSpeechChunk,
    resetStreamingSpeech,
    restartListeningSoon,
    stopBargeInMonitor,
    updateState,
  ]);

  const appendStreamingSpeechContent = useCallback((fullContent: string, final = false) => {
    if (final) {
      streamingSpeechFinalRef.current = true;
    }

    if (fullContent.length < streamingSpeechRawOffsetRef.current) {
      streamingSpeechRawOffsetRef.current = 0;
      streamingSpeechBufferRef.current = '';
    }

    const rawDelta = fullContent.slice(streamingSpeechRawOffsetRef.current);
    streamingSpeechRawOffsetRef.current = fullContent.length;
    const cleanDelta = cleanAssistantText(rawDelta);
    if (cleanDelta) {
      const buffer = streamingSpeechBufferRef.current;
      const needsSpace = buffer.length > 0 && !/[\s([{'"-]$/.test(buffer) && !/^[.,!?;:)\]}]/.test(cleanDelta);
      streamingSpeechBufferRef.current = `${buffer}${needsSpace ? ' ' : ''}${cleanDelta}`;
    }

    const chunks: string[] = [];
    let buffer = streamingSpeechBufferRef.current.trimStart();

    if (final) {
      const finalText = buffer.trim();
      if (finalText.length >= 2) {
        chunks.push(finalText);
      }
      buffer = '';
    } else if (!streamingSpeechFirstChunkQueuedRef.current) {
      const cut = findStreamingSpeechCut(buffer, false);
      if (cut >= 0) {
        const chunk = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut).trimStart();
        if (chunk.length >= 2) {
          chunks.push(chunk);
          streamingSpeechFirstChunkQueuedRef.current = true;
        }
      }
    } else {
      let cut = findFollowUpSpeechCut(buffer);
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut).trimStart();
        if (chunk.length >= 2) chunks.push(chunk);
        cut = findFollowUpSpeechCut(buffer);
      }
    }

    streamingSpeechBufferRef.current = buffer;

    if (chunks.length > 0) {
      streamingSpeechQueueRef.current.push(...chunks);
      void processStreamingSpeechQueue();
    } else if (final && streamingSpeechStartedRef.current) {
      void processStreamingSpeechQueue();
    }

    return chunks.length > 0
      || streamingSpeechStartedRef.current
      || streamingSpeechQueueRef.current.length > 0
      || streamingSpeechBufferRef.current.trim().length > 0;
  }, [processStreamingSpeechQueue]);

  const finishTurn = useCallback(async () => {
    if (finishingTurnRef.current || stateRef.current !== 'recording') return;
    finishingTurnRef.current = true;
    const lifecycleToken = lifecycleTokenRef.current;
    updateState('transcribing');

    const speechDuration = speechStartedAtRef.current ? performance.now() - speechStartedAtRef.current : 0;
    const blob = await stopRecorderToBlob();
    const timings = timingsRef.current;
    if (isCurrentTimings(timings)) {
      timings.recordingEndedAt = performance.now();
      timings.transcriptionStartedAt = timings.recordingEndedAt;
    }
    releaseCapture(false);

    try {
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken) return;

      if (blob.size === 0 || speechDuration < 250) {
        updateState('idle');
        restartListeningSoon();
        return;
      }

      if (blob.size < VOICE_MIN_BLOB_BYTES || speechDuration < VOICE_MIN_SPEECH_MS) {
        setLastError('Audio muito curto. Pode falar de novo.');
        updateState('error');
        logTimings('audio_curto', { blobBytes: blob.size, speechMs: Math.round(speechDuration) });
        restartListeningSoon(900);
        return;
      }

      const base64 = await blobToBase64(blob);
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken) return;

      const text = (await window.lionclaw.voice.transcribe(base64)).trim();
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken || !isCurrentTimings(timings)) return;
      timings.transcriptionEndedAt = performance.now();
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken) return;

      setTranscript(text);

      if (!text) {
        setLastError('Nao consegui entender o audio. Tente falar um pouco mais perto do microfone.');
        updateState('error');
        logTimings('transcricao_vazia');
        restartListeningSoon(1200);
        return;
      }

      awaitingResponseRef.current = true;
      resetStreamingSpeech();
      const chatState = useChatStore.getState();
      voiceExpectedTurnSequenceRef.current = chatState.submittedUserTurnCount + 1;
      updateState('thinking');
      await onSendMessage(text);
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken) {
        awaitingResponseRef.current = false;
        voiceExpectedTurnSequenceRef.current = null;
      }
    } catch (error) {
      if (!activeRef.current || lifecycleTokenRef.current !== lifecycleToken) return;
      if (isCurrentTimings(timings)) {
        timings.transcriptionEndedAt ??= performance.now();
      }
      logTimings('erro_stt', { errorType: error instanceof Error ? error.name : typeof error });
      console.error('Voice conversation transcription failed:', error);
      setLastError('Falha ao transcrever sua fala. Verifique o microfone e tente novamente.');
      awaitingResponseRef.current = false;
      updateState('error');
      restartListeningSoon(1200);
    } finally {
      finishingTurnRef.current = false;
      chunksRef.current = [];
      preRollChunksRef.current = [];
      recorderHeaderChunkRef.current = null;
    }
  }, [isCurrentTimings, logTimings, onSendMessage, releaseCapture, resetStreamingSpeech, restartListeningSoon, stopRecorderToBlob, updateState]);

  finishTurnRef.current = finishTurn;

  const runVadLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      const currentState = stateRef.current;
      if (!activeRef.current || (currentState !== 'listening' && currentState !== 'recording')) {
        return;
      }

      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(Math.max(rms, 0.00001));
      const nextAmplitude = clamp((db - VOICE_SILENCE_THRESHOLD_DB) / 24, 0, 1);
      setAmplitude(nextAmplitude);

      const now = performance.now();
      const hasStartVoice = db > VOICE_START_THRESHOLD_DB;
      const hasContinuingVoice = db > VOICE_SILENCE_THRESHOLD_DB;

      if (currentState === 'listening') {
        if (hasStartVoice) {
          voiceCandidateStartedAtRef.current ??= now;
        } else {
          voiceCandidateStartedAtRef.current = null;
        }

        const candidateMs = voiceCandidateStartedAtRef.current == null ? 0 : now - voiceCandidateStartedAtRef.current;
        if (candidateMs >= 140) {
          const speechStartedAt = voiceCandidateStartedAtRef.current ?? now;
          recordingSpeechRef.current = true;
          chunksRef.current = withRecorderHeader([...preRollChunksRef.current], recorderHeaderChunkRef.current);
          speechStartedAtRef.current = speechStartedAt;
          startTimingTurn(speechStartedAt);
          silenceStartedAtRef.current = null;
          voiceCandidateStartedAtRef.current = null;
          setTurnElapsedMs(0);
          maxTurnTimerRef.current = setTimeout(() => {
            if (stateRef.current !== 'recording') return;
            setLastError('Limite de 60 segundos atingido. Transcrevendo agora.');
            void finishTurn();
          }, MAX_TURN_AUDIO_MS + 250);
          setLastError(null);
          updateState('recording');
        }
      }

      if (stateRef.current === 'recording') {
        if (hasContinuingVoice) {
          silenceStartedAtRef.current = null;
        } else if (silenceStartedAtRef.current == null) {
          silenceStartedAtRef.current = now;
        }

        const silenceMs = silenceStartedAtRef.current == null ? 0 : now - silenceStartedAtRef.current;
        const speechMs = speechStartedAtRef.current == null ? 0 : now - speechStartedAtRef.current;
        setTurnElapsedMs(speechMs);

        if (silenceMs >= VOICE_END_OF_SPEECH_MS || speechMs >= MAX_TURN_AUDIO_MS) {
          if (speechMs >= MAX_TURN_AUDIO_MS) {
            setLastError('Limite de 60 segundos atingido. Transcrevendo agora.');
          }
          void finishTurn();
          return;
        }
      }

      vadFrameRef.current = requestAnimationFrame(tick);
    };

    vadFrameRef.current = requestAnimationFrame(tick);
  }, [finishTurn, startTimingTurn, updateState]);

  runVadLoopRef.current = runVadLoop;

  const startCapture = useCallback(async () => {
    if (disabled || startingCaptureRef.current || !activeRef.current) return;
    if (!['closed', 'idle', 'interrupted', 'error', 'permission-denied', 'listening'].includes(stateRef.current)) return;
    startingCaptureRef.current = true;
    clearRecoveryTimer();
    releaseCapture();
    updateState('permission-pending');

    let setupStream: MediaStream | null = null;
    let setupAudioContext: AudioContext | null = null;
    let setupSource: MediaStreamAudioSourceNode | null = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      setupStream = stream;
      mediaStreamRef.current = stream;

      if (!activeRef.current || disabled) {
        releaseCapture();
        return;
      }

      const AudioContextCtor = window.AudioContext;
      const audioContext = new AudioContextCtor();
      setupAudioContext = audioContext;
      audioContextRef.current = audioContext;

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      if (!activeRef.current || disabled) {
        releaseCapture();
        return;
      }

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.68;
      const source = audioContext.createMediaStreamSource(stream);
      setupSource = source;
      source.connect(analyser);

      const mimeType = getRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const maxPreRollChunks = Math.max(1, Math.ceil(VOICE_PRE_ROLL_MS / RECORDER_CHUNK_MS) + 1);

      chunksRef.current = [];
      preRollChunksRef.current = [];
      recorderHeaderChunkRef.current = null;
      recordingSpeechRef.current = false;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      voiceCandidateStartedAtRef.current = null;
      setTurnElapsedMs(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        recorderHeaderChunkRef.current ??= event.data;
        if (recordingSpeechRef.current) {
          chunksRef.current.push(event.data);
          return;
        }

        preRollChunksRef.current = appendPreRollChunk(
          preRollChunksRef.current,
          event.data,
          recorderHeaderChunkRef.current,
          maxPreRollChunks,
        );
      };

      analyserRef.current = analyser;
      sourceRef.current = source;
      mediaRecorderRef.current = recorder;
      setupStream = null;
      setupAudioContext = null;
      setupSource = null;

      recorder.start(RECORDER_CHUNK_MS);
      updateState('listening');
      runVadLoop();
    } catch (error) {
      setupSource?.disconnect();
      setupStream?.getTracks().forEach((track) => track.stop());
      void setupAudioContext?.close().catch(() => undefined);
      console.error('Voice conversation mic access failed:', error);
      setLastError('Nao consegui acessar o microfone. Verifique a permissao do sistema.');
      updateState('permission-denied');
      releaseCapture();
    } finally {
      startingCaptureRef.current = false;
    }
  }, [clearRecoveryTimer, disabled, releaseCapture, runVadLoop, updateState]);

  startCaptureRef.current = startCapture;

  const start = useCallback(async () => {
    if (disabled) return;
    lifecycleTokenRef.current += 1;
    activeRef.current = true;
    setVoiceModeActive(true);
    setTranscript('');
    setLastError(null);
    timingIdRef.current += 1;
    timingsRef.current = { id: timingIdRef.current };
    timingsLoggedRef.current = false;
    updateState('idle');
    await startCapture();
  }, [disabled, setVoiceModeActive, startCapture, updateState]);

  const stop = useCallback(() => {
    lifecycleTokenRef.current += 1;
    speechTokenRef.current += 1;
    activeRef.current = false;
    awaitingResponseRef.current = false;
    voiceExpectedTurnSequenceRef.current = null;
    interruptedPlaybackRef.current = false;
    clearRecoveryTimer();
    releaseCapture();
    resetStreamingSpeech();
    stopBargeInMonitor();
    stopPlayback();
    setVoiceModeActive(false);
    updateState('closed');
  }, [clearRecoveryTimer, releaseCapture, resetStreamingSpeech, setVoiceModeActive, stopBargeInMonitor, stopPlayback, updateState]);

  const interrupt = useCallback(() => {
    if (stateRef.current !== 'speaking') return;
    interruptedPlaybackRef.current = true;
    speechTokenRef.current += 1;
    const timings = timingsRef.current;
    if (isCurrentTimings(timings)) {
      timings.playbackEndedAt ??= timings.playbackStartedAt ? performance.now() : undefined;
    }
    logTimings('interrompido');
    stopBargeInMonitor();
    stopPlayback();
    updateState('interrupted');
    restartListeningSoon(200);
  }, [isCurrentTimings, logTimings, restartListeningSoon, stopBargeInMonitor, stopPlayback, updateState]);

  useEffect(() => {
    if (autoStart && !disabled) {
      void start();
    }

    return () => {
      stop();
    };
  }, [autoStart, disabled, start, stop]);

  useEffect(() => {
    if ((state !== 'thinking' && state !== 'speaking') || !awaitingResponseRef.current) {
      return;
    }

    const expectedSequence = voiceExpectedTurnSequenceRef.current;
    if (expectedSequence == null) return;

    const turnEvent = assistantTurnEvents.find((event) => event.sequence === expectedSequence);
    if (!turnEvent) return;

    awaitingResponseRef.current = false;
    voiceExpectedTurnSequenceRef.current = null;
    timingsRef.current.agentDoneAt = performance.now();

    if (turnEvent.status === 'error') {
      setLastError(turnEvent.error || 'O agente retornou um erro.');
      updateState('error');
      logTimings('erro_agente', { turnStatus: turnEvent.status });
      restartListeningSoon(1200);
      return;
    }

    if (!turnEvent.content.trim()) {
      updateState('idle');
      logTimings(turnEvent.status === 'stopped' ? 'parado' : 'sem_resposta', { turnStatus: turnEvent.status });
      restartListeningSoon();
      return;
    }

    const streamingSpeechHandled = appendStreamingSpeechContent(turnEvent.content, true);
    if (!streamingSpeechHandled) {
      void speakResponse(turnEvent.content);
    }
  }, [appendStreamingSpeechContent, assistantTurnEvents, restartListeningSoon, speakResponse, state, updateState]);

  useEffect(() => {
    if ((state !== 'thinking' && state !== 'speaking') || !awaitingResponseRef.current || !streamingContent) return;
    const expectedSequence = voiceExpectedTurnSequenceRef.current;
    if (expectedSequence == null || assistantTurnCount !== expectedSequence - 1) return;
    timingsRef.current.agentFirstDeltaAt ??= performance.now();
    appendStreamingSpeechContent(streamingContent);
  }, [appendStreamingSpeechContent, assistantTurnCount, state, streamingContent]);

  return {
    state,
    amplitude,
    transcript,
    lastError,
    turnElapsedMs,
    maxTurnMs: MAX_TURN_AUDIO_MS,
    turnWarningMs: TURN_WARNING_MS,
    start,
    stop,
    interrupt,
  };
}
