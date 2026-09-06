import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, Image, Music, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  KNOWLEDGE_AUDIO_EXTENSIONS,
  KNOWLEDGE_UPLOAD_EXT_MIMES,
  knowledgeIngestExtension,
  validateKnowledgeUploadFile,
} from '@/constants/knowledge-ingest-files';


export interface FilePreview {
  file: File;
  path: string;
  typeLabel: string;
}


const EXT_LABEL: Record<string, string> = {
  '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.csv': 'CSV',
  '.md': 'Markdown', '.txt': 'Texto', '.png': 'Imagem', '.jpg': 'Imagem',
  '.jpeg': 'Imagem', '.webp': 'Imagem', '.mp3': 'Áudio', '.m4a': 'Áudio',
  '.wav': 'Áudio', '.ogg': 'Áudio', '.flac': 'Áudio',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTS = new Set<string>(KNOWLEDGE_AUDIO_EXTENSIONS);


function getFileExt(name: string): string {
  return knowledgeIngestExtension(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(ext: string): typeof FileText {
  if (IMAGE_EXTS.has(ext)) return Image;
  if (AUDIO_EXTS.has(ext)) return Music;
  return FileText;
}

function validateFile(
  file: File,
  maxBytes: number,
): { ok: true; typeLabel: string } | { ok: false; reason: string } {
  const result = validateKnowledgeUploadFile(file, maxBytes);
  if (!result.ok) return result;
  return {
    ok: true,
    typeLabel: EXT_LABEL[result.extension] || result.extension,
  };
}


interface UploadDropZoneProps {
  maxFileSizeMb: number;
  onNewFilesAdded: (files: FilePreview[]) => void;
}

export function UploadDropZone({ maxFileSizeMb, onNewFilesAdded }: UploadDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<FilePreview[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    (rawFiles: File[]) => {
      const maxBytes = maxFileSizeMb * 1024 * 1024;
      const accepted: FilePreview[] = [];
      const rejectedMsgs: string[] = [];

      for (const file of rawFiles) {
        const result = validateFile(file, maxBytes);
        if (!result.ok) {
          rejectedMsgs.push(`${file.name}: ${result.reason}`);
          continue;
        }
        const path = window.lionclaw.utils.getPathForFile(file);
        accepted.push({ file, path, typeLabel: result.typeLabel });
      }

      if (accepted.length + previews.length > 10) {
        toast.error('Máximo de 10 arquivos por upload');
        return;
      }

      rejectedMsgs.slice(0, 3).forEach((msg) => toast.error(msg));
      if (rejectedMsgs.length > 3) {
        toast.error(`...e mais ${rejectedMsgs.length - 3} rejeitado(s)`);
      }

      if (accepted.length > 0) {
        setPreviews((prev) => [...prev, ...accepted]);
        onNewFilesAdded(accepted);
      }
    },
    [previews, maxFileSizeMb, onNewFilesAdded],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      processFiles(Array.from(e.dataTransfer.files));
    },
    [processFiles],
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files || []));
    e.target.value = '';
  };

  const removePreview = (idx: number) => {
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  const Icon = Upload;

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-6 cursor-pointer transition-colors ${
          isDragging
            ? 'border-amber-500/70 bg-amber-500/5'
            : 'border-zinc-700 hover:border-zinc-600 bg-zinc-900/50 hover:bg-zinc-900'
        }`}
      >
        <Icon size={20} className={isDragging ? 'text-amber-400' : 'text-zinc-500'} />
        <div className="text-center pointer-events-none">
          <p className="text-sm text-zinc-300">
            {isDragging ? 'Solte os arquivos aqui' : 'Arraste arquivos ou clique para selecionar'}
          </p>
          <p className="text-xs text-zinc-600 mt-1">
            PDF, Word, Excel, CSV, Markdown, TXT, Imagens e Áudio · Máx {maxFileSizeMb}MB
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept={Object.keys(KNOWLEDGE_UPLOAD_EXT_MIMES).join(',')}
          onChange={handleInputChange}
        />
      </div>

      {/* Preview cards */}
      {previews.length > 0 && (
        <div className="space-y-1.5">
          {previews.map((p, i) => {
            const FileIcon = getFileIcon(getFileExt(p.file.name));
            return (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg"
              >
                <FileIcon size={14} className="text-zinc-400 shrink-0" />
                <span className="flex-1 text-xs text-zinc-300 truncate">{p.file.name}</span>
                <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full shrink-0">
                  {p.typeLabel}
                </span>
                <span className="text-[10px] text-zinc-600 shrink-0">{formatSize(p.file.size)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePreview(i);
                  }}
                  className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
