
export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'] as const;

export const SDK_DISALLOWED_TOOLS: readonly string[] = Object.freeze([
  'Artifact',
  'DesignSync',
  'ListAgents',
  'ListSkills',
  'Monitor',
  'PowerShell',
  'PushNotification',
  'ReadMcpResourceDirTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'SendUserFile',
  'SubscribePR',
  'SuggestSkills',
  'WebBrowser',
  'Workflow',
]);

const TASK_TOOL_SET: ReadonlySet<string> = new Set<string>(TASK_TOOL_NAMES);

export function toSdkToolNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const emittedTaskTools = new Set<string>();
  const pushTaskTool = (name: string): void => {
    if (emittedTaskTools.has(name)) return;
    emittedTaskTools.add(name);
    out.push(name);
  };
  for (const name of names) {
    if (name === 'TodoWrite') {
      for (const taskTool of TASK_TOOL_NAMES) pushTaskTool(taskTool);
    } else if (TASK_TOOL_SET.has(name)) {
      pushTaskTool(name);
    } else {
      out.push(name);
    }
  }
  return out;
}
