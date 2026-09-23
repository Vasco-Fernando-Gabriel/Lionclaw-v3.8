import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings } from 'lucide-react';
import { UploadDropZone, type FilePreview } from './UploadDropZone';
import { UrlImportField } from './UrlImportField';
import { TextIngestField } from './TextIngestField';
import { IngestHistoryList } from './IngestHistoryList';
import { IngestSettingsDrawer } from './IngestSettingsDrawer';
import type { IngestJob } from '@/types';
import toast from 'react-hot-toast';

export function UploadTab() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxFileSizeMb, setMaxFileSizeMb] = useState(50);
  const [newJobs, setNewJobs] = useState<IngestJob[]>([]);

  const submittedPaths = useRef(new Set<string>());

  useEffect(() => {
    window.lionclaw.mgraph
      .ingestSettings()
      .then((s) => setMaxFileSizeMb(s.maxFileSizeMb))
      .catch(() => {});
  }, []);

  const handleNewFilesAdded = useCallback(async (files: FilePreview[]) => {
    const toIngest = files.filter((fp) => !submittedPaths.current.has(fp.path));
    if (toIngest.length === 0) return;

    toIngest.forEach((fp) => submittedPaths.current.add(fp.path));

    await Promise.allSettled(
      toIngest.map(async (fp) => {
        try {
          const job = await window.lionclaw.mgraph.ingestFile(fp.path, fp.file.name);
          if ('error' in job) throw new Error(job.error);
          setNewJobs((prev) => [...prev, job]);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Falha ao enviar arquivo');
        }
      }),
    );
  }, []);

  const handleJobCreated = useCallback((job: IngestJob) => {
    setNewJobs((prev) => [...prev, job]);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Topbar with settings gear */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-zinc-800/50">
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-1.5 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors"
          title="Configurações de ingestão"
        >
          <Settings size={14} />
        </button>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 1. Drop zone */}
        <UploadDropZone maxFileSizeMb={maxFileSizeMb} onNewFilesAdded={handleNewFilesAdded} />

        {/* 2. URL import */}
        <UrlImportField onJobCreated={handleJobCreated} />

        {/* 3. Text ingest */}
        <TextIngestField onJobCreated={handleJobCreated} />

        {/* 4. Separator + history */}
        <div className="border-t border-zinc-800 pt-4">
          <IngestHistoryList newJobs={newJobs} />
        </div>
      </div>

      {/* Settings drawer */}
      <IngestSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
