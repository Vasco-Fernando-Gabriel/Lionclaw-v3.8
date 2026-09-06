import { useEffect } from 'react';
import { useHarnessStore } from '@/stores/harness-store';
import { ProjectList } from '@/components/harness/ProjectList';
import { ProjectDetail } from '@/components/harness/ProjectDetail';

export default function HarnessPage() {
  const { selectedProjectId, loadProjects } = useHarnessStore();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const unsub1 = window.lionclaw.harness.onProjectUpdate(() => {
      useHarnessStore.getState().loadProjects();
    });
    const unsub2 = window.lionclaw.harness.onPlanningDone(() => {
      useHarnessStore.getState().loadProjects();
    });
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  if (selectedProjectId) {
    return <ProjectDetail projectId={selectedProjectId} />;
  }

  return <ProjectList />;
}
