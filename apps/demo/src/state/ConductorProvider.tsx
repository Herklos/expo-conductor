/**
 * ConductorProvider — subscribes to lifecycle events and persists execution history.
 * Wrap the app shell with this provider so all screens share task/history state.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import Conductor, {
  foldHistory,
  type RegisteredTask,
  type TaskExecutionRecord,
} from 'expo-conductor';

export type TriggerMode = 'interval' | 'alarm' | 'notification';

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface ConductorContextValue {
  tasks: RegisteredTask[];
  records: TaskExecutionRecord[];
  liveLog: string[];
  triggerMode: TriggerMode;
  setTriggerMode: (m: TriggerMode) => void;
  refresh: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
}

const ConductorContext = createContext<ConductorContextValue>({
  tasks: [],
  records: [],
  liveLog: [],
  triggerMode: 'interval',
  setTriggerMode: () => {},
  refresh: async () => {},
  refreshHistory: async () => {},
  clearHistory: async () => {},
});

export function ConductorProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<RegisteredTask[]>([]);
  const [records, setRecords] = useState<TaskExecutionRecord[]>([]);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('interval');
  const logRef = useRef<string[]>([]);

  const appendLog = useCallback((line: string) => {
    const time = fmtDateTime(Date.now());
    const entry = `${time}  ${line}`;
    logRef.current = [entry, ...logRef.current].slice(0, 100);
    setLiveLog([...logRef.current]);
  }, []);

  const refresh = useCallback(async () => {
    setTasks(await Conductor.getTasks());
  }, []);

  const refreshHistory = useCallback(async () => {
    const events = await Conductor.getHistory();
    setRecords(foldHistory(events));
  }, []);

  const clearHistory = useCallback(async () => {
    await Conductor.clearHistory();
    setRecords([]);
  }, []);

  useEffect(() => {
    const subs = [
      Conductor.addListener('onTaskExecute', (p) => {
        appendLog(`execute → ${p.taskId} (trigger=${p.triggerType}, attempt=${p.attempt})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskComplete', (p) => {
        appendLog(`complete → ${p.taskId} (${p.result})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskSkipped', (p) => {
        appendLog(`skipped → ${p.taskId} (${p.reason})`);
        void refreshHistory();
      }),
      Conductor.addListener('onTaskError', (p) => {
        appendLog(`error → ${p.taskId} (${p.error})`);
        void refreshHistory();
      }),
    ];
    void refresh();
    void refreshHistory();
    return () => subs.forEach((s) => s.remove());
  }, [appendLog, refresh, refreshHistory]);

  return (
    <ConductorContext.Provider
      value={{ tasks, records, liveLog, triggerMode, setTriggerMode, refresh, refreshHistory, clearHistory }}
    >
      {children}
    </ConductorContext.Provider>
  );
}

export function useConductor() {
  return useContext(ConductorContext);
}
